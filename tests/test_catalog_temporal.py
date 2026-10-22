"""Test ERA5 admission with SQLite coverage and real Zarr coordinate reads."""

import asyncio
import json
import shutil
import sqlite3
from calendar import monthrange
from collections.abc import AsyncIterator, Iterable
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy
import pytest
import rasterio
from rasterio.transform import from_origin

from eolab_app.catalog.handlers import create_default_dataset_handler_registry
from eolab_app.catalog.discovery import FilesystemDatasetDiscovery
from eolab_app.catalog.metadata import MetadataPipeline, build_dataset_metadata
from eolab_app.catalog.models import DatasetCandidate, DatasetMetadataResult
from eolab_app.catalog.scanner import ScanManager
from tests.catalog_support import RecordingCatalogDatabase, RecordingCatalogWriter

TEMPERATURE = "2_metre_temperature"
PRECIPITATION = "mean_total_precipitation_rate"
RADIATION = "surface_solar_radiation_downwards"
VARIABLES = {
    TEMPERATURE: ("instant", "K", "Air temperature at 2 m"),
    PRECIPITATION: ("avg", "kg m**-2 s**-1", "Mean precipitation rate"),
    RADIATION: ("accum", "W m**-2 s", "Downward solar energy"),
}
ITEM_KEY = ("eolab-temporal-datasets", "era5-test")


def write_coordinate(
    path: Path, values: numpy.ndarray, attributes: dict[str, str]
) -> None:
    """Write a one-chunk Zarr v3 coordinate that GDAL can read directly.

    Args:
        path: Coordinate array directory.
        values: One-dimensional integer or floating-point coordinate values.
        attributes: Units and clock conventions stored in the array header.
    """
    (path / "c").mkdir(parents=True, exist_ok=True)
    metadata = {
        "zarr_format": 3,
        "node_type": "array",
        "shape": [len(values)],
        "data_type": values.dtype.name,
        "chunk_grid": {
            "name": "regular",
            "configuration": {"chunk_shape": [len(values)]},
        },
        "chunk_key_encoding": {"name": "default", "configuration": {"separator": "/"}},
        "fill_value": 0,
        "codecs": [{"name": "bytes", "configuration": {"endian": "little"}}],
        "dimension_names": [path.name],
        "attributes": attributes,
    }
    (path / "zarr.json").write_text(json.dumps(metadata), encoding="utf-8")
    (path / "c" / "0").write_bytes(
        values.astype(values.dtype.newbyteorder("<")).tobytes()
    )


def publish_month(archive: Path, month: int, hours: dict[str, tuple[int, ...]]) -> None:
    """Publish a small 2000 coverage revision and matching monthly array metadata.

    Coordinate values are stored, but weather pixels are deliberately absent.
    As in the producer, the time axis is the union of available observation
    labels and weather chunks span a calendar month. Non-forecast fields have no
    forecast origin; forecast fields use a six-hour lead.

    Args:
        archive: Directory containing the test producer catalog.
        month: Calendar month in 2000.
        hours: Observation-hour offsets from the start of that month, by variable.
    """
    start = int(datetime(2000, month, 1, tzinfo=timezone.utc).timestamp())
    times = numpy.array(
        sorted({start + hour * 3600 for values in hours.values() for hour in values}),
        dtype="int64",
    )
    revision = f"month-{month}-hours-{len(times)}"
    with closing(sqlite3.connect(archive / "catalog.sqlite")) as connection, connection:
        connection.execute("INSERT INTO revisions VALUES (?, 'published')", (revision,))
        connection.execute(
            "INSERT OR REPLACE INTO months VALUES (2000, ?, ?)", (month, revision)
        )
        for variable, observations in hours.items():
            step_type = VARIABLES[variable][0]
            duration = 0 if step_type == "instant" else 3600
            connection.executemany(
                "INSERT INTO coverage VALUES (?, ?, ?, ?, ?, ?, ?)",
                [
                    (
                        revision,
                        variable,
                        start + hour * 3600,
                        (
                            int(numpy.iinfo(numpy.int64).min)
                            if step_type == "instant"
                            else start + hour * 3600 - 6 * 3600
                        ),
                        start + hour * 3600 - duration,
                        start + hour * 3600,
                        step_type,
                    )
                    for hour in observations
                ],
            )
    store = archive / "2000" / f"{month:02d}" / "era5.zarr"
    store.mkdir(parents=True, exist_ok=True)
    (store / "zarr.json").write_text(
        json.dumps({"zarr_format": 3, "node_type": "group", "attributes": {}}),
        encoding="utf-8",
    )
    write_coordinate(
        store / "latitude", numpy.linspace(90, -90, 721), {"units": "degrees_north"}
    )
    write_coordinate(
        store / "longitude", numpy.arange(1440) * 0.25, {"units": "degrees_east"}
    )
    write_coordinate(
        store / "time",
        times,
        {
            "units": "seconds since 1970-01-01 00:00:00",
            "calendar": "proleptic_gregorian",
            "timezone": "UTC",
        },
    )
    for variable in hours:
        step_type, unit, title = VARIABLES[variable]
        path = store / variable
        path.mkdir(exist_ok=True)
        (path / "zarr.json").write_text(
            json.dumps(
                {
                    "zarr_format": 3,
                    "node_type": "array",
                    "shape": [len(times), 721, 1440],
                    "data_type": "float32",
                    "dimension_names": ["time", "latitude", "longitude"],
                    "fill_value": "NaN",
                    "chunk_grid": {
                        "name": "regular",
                        "configuration": {
                            "chunk_shape": [monthrange(2000, month)[1] * 24, 32, 32]
                        },
                    },
                    "chunk_key_encoding": {
                        "name": "default",
                        "configuration": {"separator": "/"},
                    },
                    "codecs": [
                        {"name": "bytes", "configuration": {"endian": "little"}}
                    ],
                    "attributes": {
                        "step_type": step_type,
                        "units": unit,
                        "long_name": title,
                    },
                }
            ),
            encoding="utf-8",
        )


@pytest.fixture
def era5_archive(tmp_path: Path) -> Path:
    """Create two partial months, variable gaps and an unpublished revision.

    Args:
        tmp_path: Isolated scan mount.

    Returns:
        Descriptor directory with the producer tables needed for admission.
    """
    archive = tmp_path / "weather"
    archive.mkdir()
    (archive / "dataset.yaml").write_text(
        "id: era5-test\ntitle: Test hourly weather\nsource:\n"
        "  format: era5_ncar_zarr\n  catalog: catalog.sqlite\n",
        encoding="utf-8",
    )
    with closing(sqlite3.connect(archive / "catalog.sqlite")) as connection, connection:
        connection.executescript("""
            CREATE TABLE revisions (id TEXT PRIMARY KEY, status TEXT NOT NULL);
            CREATE TABLE months (year INTEGER, month INTEGER, current_revision_id TEXT,
                                 PRIMARY KEY (year, month));
            CREATE TABLE coverage (
                revision_id TEXT, variable TEXT, valid_time INTEGER, reference_time INTEGER,
                interval_start INTEGER, interval_end INTEGER, step_type TEXT,
                PRIMARY KEY (revision_id, variable, valid_time));
            INSERT INTO revisions VALUES ('unfinished-month', 'preparing');
        """)
    publish_month(archive, 1, {TEMPERATURE: (742, 743), PRECIPITATION: (742,)})
    publish_month(
        archive, 2, {TEMPERATURE: (0, 1, 2), PRECIPITATION: (0, 2), RADIATION: (2,)}
    )
    return archive


def create_scanner(source_root: Path) -> tuple[ScanManager, RecordingCatalogWriter]:
    """Compose the real discovery and metadata pipeline with an in-memory catalog.

    Args:
        source_root: Mounted directory containing the fixture archive.

    Returns:
        Scan coordinator and its inspectable catalog writer.
    """
    registry = create_default_dataset_handler_registry()
    writer = RecordingCatalogWriter()
    manager = ScanManager(
        source_root,
        (source_root,),
        writer,
        RecordingCatalogDatabase(writer),
        2,
        1,
        10,
        dataset_handlers=registry,
        metadata_pipeline=MetadataPipeline(
            source_root, 2, 4, registry, ThreadPoolExecutor
        ),
    )
    return manager, writer


async def scan(manager: ScanManager) -> dict[str, Any]:
    """Run one real catalog scan and return its terminal public status.

    Args:
        manager: Scanner whose source files are ready for admission.

    Returns:
        Completed or failed scan status.
    """
    await manager.start()
    while manager.status()["state"] in {"discovering", "scanning"}:
        await asyncio.sleep(0.001)
    return manager.status()


def test_scan_admits_partial_months_without_reading_weather_pixels(
    era5_archive: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Index one temporal Item alongside an ordinary raster using metadata only.

    Args:
        era5_archive: Two compact monthly stores with gaps in coverage.
        tmp_path: Isolated scan mount.
        monkeypatch: Records native opens without replacing coordinate reads.
    """
    with rasterio.open(
        tmp_path / "ordinary.tif",
        "w",
        driver="GTiff",
        width=2,
        height=2,
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=from_origin(-10, 10, 1, 1),
    ) as target:
        target.write(numpy.ones((1, 2, 2), dtype="float32"))
    (era5_archive / "owned-sibling.tif").write_text(
        "not a separate raster", encoding="utf-8"
    )
    opened: list[Path] = []
    native_open = rasterio.open

    def record_open(path: Path, *args: Any, **kwargs: Any) -> rasterio.io.DatasetReader:
        """Read real coordinates or the ordinary TIFF, never weather arrays.

        Args:
            path: Source requested by the admission handler.
            *args: Native positional open arguments.
            **kwargs: Native keyword open arguments.

        Returns:
            Rasterio's real dataset reader.

        Raises:
            AssertionError: If admission attempts to open a weather array.
        """
        assert Path(path).suffix == ".tif" or Path(path).name in {
            "latitude",
            "longitude",
            "time",
        }
        opened.append(Path(path))
        return native_open(path, *args, **kwargs)

    monkeypatch.setattr(rasterio, "open", record_open)
    manager, writer = create_scanner(tmp_path)
    status = asyncio.run(scan(manager))
    assert status["failed"] == 0
    assert status["catalogItemsWritten"] == 2
    item = writer.write_session.items[ITEM_KEY]
    properties = item["properties"]
    assert properties["start_datetime"] == "2000-01-31T21:00:00Z"
    assert properties["end_datetime"] == "2000-02-01T02:00:00Z"
    assert properties["cube:dimensions"]["time"]["extent"] == [
        "2000-01-31T22:00:00Z",
        "2000-02-01T02:00:00Z",
    ]
    assert {
        name: value["eolab:time_support"]
        for name, value in properties["cube:variables"].items()
    } == {
        TEMPERATURE: "instantaneous",
        PRECIPITATION: "mean_rate",
        RADIATION: "accumulation",
    }
    assert set(item["assets"]) == {"2000-01", "2000-02", "eolab:temporal-source"}
    assert item["assets"]["2000-01"]["href"] == "urn:eolab:temporal:era5-test:2000-01"
    assert {path.name for path in opened if path.suffix != ".tif"} == {
        "latitude",
        "longitude",
        "time",
    }


def test_explicit_rescan_extends_the_same_item_and_is_idempotent(
    era5_archive: Path,
    tmp_path: Path,
) -> None:
    """Publish added observations on refresh without changing dataset identity.

    Args:
        era5_archive: Archive updated between completed scans.
        tmp_path: Isolated scan mount.
    """
    manager, writer = create_scanner(tmp_path)
    assert asyncio.run(scan(manager))["failed"] == 0
    publish_month(
        era5_archive,
        2,
        {TEMPERATURE: (0, 1, 2, 3), PRECIPITATION: (0, 2, 3), RADIATION: (2,)},
    )
    for _ in range(2):
        status = asyncio.run(scan(manager))
        assert status["failed"] == 0
        assert status["catalogItemsAlreadyPresent"] == 1
        assert set(writer.write_session.items) == {ITEM_KEY}
        assert (
            writer.write_session.items[ITEM_KEY]["properties"]["end_datetime"]
            == "2000-02-01T03:00:00Z"
        )


def test_relocated_dataset_is_removed_then_republished_under_the_same_id(
    era5_archive: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Finish deleting a vanished source before publishing its relocated Item.

    Args:
        era5_archive: Archive admitted before relocation.
        tmp_path: Isolated mount containing both source locations.
        monkeypatch: Records catalog operation order and removes worker timing.
    """
    manager, writer = create_scanner(tmp_path)
    assert asyncio.run(scan(manager))["failed"] == 0
    relocated = tmp_path / "relocated-weather"
    era5_archive.rename(relocated)
    operations: list[str] = []
    delete_items = manager.catalog_database.delete_item_batches
    write_items = writer.write_session.upsert_items

    async def record_delete(batches: Iterable[list[tuple[str, str]]]) -> int:
        """Record completion of the real in-memory catalog deletion.

        Args:
            batches: Item identities selected by the real reconciler.

        Returns:
            Number of removed catalog Items.
        """
        removed = await delete_items(batches)
        operations.append("delete")
        return removed

    async def record_write(items: list[dict[str, Any]]) -> None:
        """Record and perform the ordinary catalog Item upsert.

        Args:
            items: Complete Items produced by the metadata reader.
        """
        operations.append("write")
        await write_items(items)

    async def immediate_metadata(
        candidates: list[DatasetCandidate],
    ) -> AsyncIterator[DatasetMetadataResult]:
        """Yield real metadata without waiting for a worker thread.

        Args:
            candidates: Sources prepared by real discovery.

        Yields:
            Actual builder results, immediately exposing write/delete races.
        """
        for candidate in candidates:
            yield build_dataset_metadata(tmp_path, candidate)

    monkeypatch.setattr(manager.catalog_database, "delete_item_batches", record_delete)
    monkeypatch.setattr(writer.write_session, "upsert_items", record_write)
    monkeypatch.setattr(manager.metadata_pipeline, "results", immediate_metadata)
    status = asyncio.run(scan(manager))

    assert status["failed"] == 0
    assert status["reconciliation"]["removed"] == 1
    assert status["catalogItemsWritten"] == 1
    assert operations == ["delete", "write"]
    assert set(writer.write_session.items) == {ITEM_KEY}
    assert (
        writer.write_session.items[ITEM_KEY]["assets"]["eolab:temporal-source"]["href"]
        == (relocated / "dataset.yaml").as_uri()
    )


def test_duplicate_id_cannot_overwrite_an_existing_unscanned_source(
    era5_archive: Path,
    tmp_path: Path,
) -> None:
    """Retain an existing source when a newly scanned directory copies its ID.

    Args:
        era5_archive: Previously admitted source kept outside the next scan paths.
        tmp_path: Isolated mount containing both descriptors.
    """
    manager, writer = create_scanner(tmp_path)
    assert asyncio.run(scan(manager))["failed"] == 0
    original_item = deepcopy(writer.write_session.items[ITEM_KEY])
    duplicate = tmp_path / "duplicate-weather"
    shutil.copytree(era5_archive, duplicate)
    manager.discovery = FilesystemDatasetDiscovery(
        tmp_path, (duplicate,), create_default_dataset_handler_registry()
    )
    previous_writes = len(writer.write_session.item_batches)
    status = asyncio.run(scan(manager))

    assert status["failed"] == 1
    assert status["catalogItemsWritten"] == 0
    assert (
        "already belongs to another dataset directory" in status["errors"][0]["error"]
    )
    assert len(writer.write_session.item_batches) == previous_writes
    assert writer.write_session.items == {ITEM_KEY: original_item}


@pytest.mark.parametrize("failure", ["descriptor", "missing-store"])
def test_failed_refresh_preserves_prior_item_and_missing_descriptor_removes_it(
    era5_archive: Path,
    tmp_path: Path,
    failure: str,
) -> None:
    """Keep admitted metadata after a failed refresh, then reconcile true removal.

    Args:
        era5_archive: Previously admitted archive.
        tmp_path: Isolated scan mount.
        failure: Broken descriptor or absent monthly store introduced after admission.
    """
    manager, writer = create_scanner(tmp_path)
    assert asyncio.run(scan(manager))["failed"] == 0
    prior_item = deepcopy(writer.write_session.items[ITEM_KEY])
    descriptor = era5_archive / "dataset.yaml"
    if failure == "descriptor":
        descriptor.write_text("source: [not valid", encoding="utf-8")
    else:
        store = era5_archive / "2000" / "01" / "era5.zarr"
        store.rename(store.with_name("unavailable.zarr"))
    status = asyncio.run(scan(manager))
    assert status["failed"] == 1
    assert status["catalogItemsWritten"] == 0
    assert writer.write_session.items[ITEM_KEY] == prior_item
    descriptor.unlink()
    status = asyncio.run(scan(manager))
    assert status["reconciliation"]["removed"] == 1
    assert writer.write_session.items == {}


@pytest.mark.parametrize(
    "failure, message",
    [
        ("shape", "Unsupported metadata"),
        ("grid", "longitude coordinate values"),
        ("calendar", "time coordinate metadata"),
        ("missing-header", "zarr.json"),
        ("catalog-escape", "escapes its directory"),
        ("variable-escape", "Unsupported variable name"),
        ("interval", "Invalid time or interval"),
        ("duplicate", "Duplicate observation"),
        ("missing-revision", "has no published revision"),
    ],
)
def test_invalid_external_metadata_is_reported_without_publishing_an_item(
    era5_archive: Path,
    tmp_path: Path,
    failure: str,
    message: str,
) -> None:
    """Reject malformed external metadata at admission with a dataset error.

    The duplicate case represents an externally corrupted database whose table
    has lost the producer's primary-key constraint.

    Args:
        era5_archive: Archive to damage before its first scan.
        tmp_path: Isolated scan mount.
        failure: Metadata fault introduced into the fixture.
        message: Useful failure detail expected from the owning boundary.
    """
    month = era5_archive / "2000" / "01" / "era5.zarr"
    if failure in {"shape", "calendar"}:
        header = month / (TEMPERATURE if failure == "shape" else "time") / "zarr.json"
        metadata = json.loads(header.read_text(encoding="utf-8"))
        if failure == "shape":
            metadata["shape"][2] = 1439
        else:
            metadata["attributes"]["calendar"] = "360_day"
        header.write_text(json.dumps(metadata), encoding="utf-8")
    elif failure == "grid":
        longitude = numpy.arange(1440, dtype="float64") * 0.25
        longitude[0] = -180
        (month / "longitude" / "c" / "0").write_bytes(longitude.tobytes())
    elif failure == "missing-header":
        (month / TEMPERATURE / "zarr.json").unlink()
    elif failure == "catalog-escape":
        descriptor = era5_archive / "dataset.yaml"
        descriptor.write_text(
            descriptor.read_text(encoding="utf-8").replace(
                "catalog.sqlite", "../outside.sqlite"
            ),
            encoding="utf-8",
        )
    else:
        with (
            closing(sqlite3.connect(era5_archive / "catalog.sqlite")) as connection,
            connection,
        ):
            if failure == "variable-escape":
                connection.execute(
                    "UPDATE coverage SET variable = '../outside' WHERE variable = ?",
                    (TEMPERATURE,),
                )
            elif failure == "interval":
                connection.execute(
                    "UPDATE coverage SET interval_start = interval_start - 1 WHERE variable = ?",
                    (PRECIPITATION,),
                )
            elif failure == "missing-revision":
                connection.execute(
                    "UPDATE months SET current_revision_id = 'missing' WHERE month = 1"
                )
            else:
                connection.executescript("""
                    ALTER TABLE coverage RENAME TO original_coverage;
                    CREATE TABLE coverage AS SELECT * FROM original_coverage;
                    INSERT INTO coverage SELECT * FROM original_coverage LIMIT 1;
                """)
    manager, writer = create_scanner(tmp_path)
    status = asyncio.run(scan(manager))
    assert status["failed"] == 1
    assert message in status["errors"][0]["error"]
    assert writer.write_session.items == {}


def test_coordinate_symlink_cannot_escape_the_archive(
    era5_archive: Path,
    tmp_path: Path,
) -> None:
    """Reject an external coordinate even when its symlink is inside the archive.

    Args:
        era5_archive: Archive containing the linked coordinate.
        tmp_path: Isolated scan mount, also holding the external target.
    """
    coordinate = era5_archive / "2000" / "01" / "era5.zarr" / "time"
    external = tmp_path / "external-time"
    coordinate.rename(external)
    try:
        coordinate.symlink_to(external, target_is_directory=True)
    except OSError as error:
        pytest.skip(f"Creating a test symlink is unavailable: {error}")
    manager, writer = create_scanner(tmp_path)
    status = asyncio.run(scan(manager))
    assert status["failed"] == 1
    assert "escapes its directory" in status["errors"][0]["error"]
    assert writer.write_session.items == {}
