"""Test GeoTIFF stack admission through its SQLite observation contract."""

import asyncio
import json
import shutil
import sqlite3
from collections.abc import AsyncIterator, Iterable
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

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


def observation_path(archive: Path, variable: str, month: int, hour: int) -> Path:
    """Return a fixture observation's deterministic GeoTIFF path.

    Args:
        archive: Test archive root.
        variable: Published variable identifier.
        month: Calendar month in 2000.
        hour: Hour offset from the beginning of that month.

    Returns:
        Absolute or archive-rooted path for the requested observation.
    """
    stamp = datetime(2000, month, 1, tzinfo=timezone.utc) + timedelta(hours=hour)
    return (
        archive / f"{stamp:%Y/%m}" / variable / f"{variable}_{stamp:%Y%m%dT%H%M%SZ}.tif"
    )


def publish_month(
    archive: Path,
    month: int,
    hours: dict[str, tuple[int, ...]],
    *,
    shape: tuple[int, int] = (721, 1440),
    transform: rasterio.Affine = rasterio.Affine(0.25, 0, -180.125, 0, -0.25, 90.125),
    dtype: str = "float32",
) -> None:
    """Publish sparse GeoTIFFs and replace one month's observation metadata.

    Non-forecast fields have no reference time; forecast fields use a six-hour
    lead. Published rasters initially contain NoData so callers can populate the
    cells their calculation needs.

    Args:
        archive: Directory containing the test producer catalog.
        month: Calendar month in 2000.
        hours: Hour offsets from the start of that month, by variable.
        shape: Native raster rows and columns.
        transform: Native north-up grid.
        dtype: Floating-point type retained by the fixture rasters.
    """
    start = int(datetime(2000, month, 1, tzinfo=timezone.utc).timestamp())
    end = int(
        datetime(2000 + month // 12, month % 12 + 1, 1, tzinfo=timezone.utc).timestamp()
    )
    with closing(sqlite3.connect(archive / "catalog.sqlite")) as connection, connection:
        connection.execute(
            "DELETE FROM coverage WHERE valid_time >= ? AND valid_time < ?",
            (start, end),
        )
        for variable, observations in hours.items():
            step_type, unit, title = VARIABLES[variable]
            temporal_type = {
                "instant": "instant",
                "avg": "mean",
                "accum": "accumulation",
            }[step_type]
            duration = 0 if step_type == "instant" else 3600
            for hour in observations:
                stamp = start + hour * 3600
                path = observation_path(archive, variable, month, hour)
                path.parent.mkdir(parents=True, exist_ok=True)
                with rasterio.open(
                    path,
                    "w",
                    driver="GTiff",
                    height=shape[0],
                    width=shape[1],
                    count=1,
                    dtype=dtype,
                    crs="EPSG:4326",
                    transform=transform,
                    nodata=numpy.nan,
                    tiled=True,
                    compress="deflate",
                ) as target:
                    target.write(numpy.full(shape, numpy.nan, dtype=dtype), 1)
                connection.execute(
                    "INSERT INTO coverage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        variable,
                        title,
                        unit,
                        path.relative_to(archive).as_posix(),
                        1,
                        stamp,
                        None if duration == 0 else stamp - 6 * 3600,
                        stamp - duration,
                        stamp,
                        temporal_type,
                        dtype,
                        "NaN",
                        "EPSG:4326",
                        json.dumps(transform.to_gdal()),
                        *shape,
                    ),
                )


@pytest.fixture
def era5_archive(tmp_path: Path) -> Path:
    """Create a GeoTIFF archive with partial months and variable-specific gaps.

    Args:
        tmp_path: Isolated scan mount.

    Returns:
        Descriptor directory exposing the producer's observations view.
    """
    archive = tmp_path / "weather"
    archive.mkdir()
    (archive / "dataset.yaml").write_text(
        "id: era5-test\ntitle: Test hourly weather\nsource:\n"
        "  format: temporal_cog\n  catalog: catalog.sqlite\n",
        encoding="utf-8",
    )
    with closing(sqlite3.connect(archive / "catalog.sqlite")) as connection, connection:
        connection.executescript("""
            CREATE TABLE coverage (
                variable TEXT, name TEXT, units TEXT, path TEXT, band INTEGER,
                valid_time INTEGER, reference_time INTEGER, interval_start INTEGER,
                interval_end INTEGER, temporal_type TEXT, dtype TEXT, nodata TEXT,
                crs TEXT, transform TEXT, height INTEGER, width INTEGER);
            CREATE TABLE publications (variable TEXT, valid_time INTEGER, status TEXT);
            CREATE VIEW observations AS SELECT c.* FROM coverage c WHERE NOT EXISTS (
                SELECT 1 FROM publications p WHERE p.variable = c.variable
                AND p.valid_time = c.valid_time AND p.status = 'ready');
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
        era5_archive: Published GeoTIFF observations with gaps in coverage.
        tmp_path: Isolated scan mount.
        monkeypatch: Records opens to verify temporal admission uses catalog metadata.
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
        """Read the ordinary TIFF; admission must not open observation files.

        Args:
            path: Source requested by the admission handler.
            *args: Native positional open arguments.
            **kwargs: Native keyword open arguments.

        Returns:
            Rasterio's real dataset reader.

        Raises:
            AssertionError: If admission attempts to open a weather array.
        """
        assert Path(path) == tmp_path / "ordinary.tif"
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
    assert set(item["assets"]) == {"eolab:temporal-source"}
    assert opened == [tmp_path / "ordinary.tif"]


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


def test_changed_dataset_id_retires_old_records_and_keeps_other_sources(
    era5_archive: Path,
    tmp_path: Path,
) -> None:
    """Replace every old ID at one descriptor while preserving another source.

    Args:
        era5_archive: Archive whose descriptor receives a new Item ID.
        tmp_path: Isolated mount containing another archive with the same title.
    """
    other_archive = tmp_path / "other-weather"
    shutil.copytree(era5_archive, other_archive)
    other_descriptor = other_archive / "dataset.yaml"
    other_descriptor.write_text(
        other_descriptor.read_text().replace("era5-test", "other-weather"),
        encoding="utf-8",
    )
    other_key = (ITEM_KEY[0], "other-weather")
    manager, writer = create_scanner(tmp_path)
    assert asyncio.run(scan(manager))["failed"] == 0
    other_item = deepcopy(writer.write_session.items[other_key])
    stale_item = deepcopy(writer.write_session.items[ITEM_KEY])
    stale_item["id"] = "older-weather"
    stale_key = (ITEM_KEY[0], stale_item["id"])
    writer.write_session.items[stale_key] = stale_item
    descriptor = era5_archive / "dataset.yaml"
    descriptor.write_text(
        descriptor.read_text().replace("era5-test", "renamed-weather"),
        encoding="utf-8",
    )
    new_key = (ITEM_KEY[0], "renamed-weather")
    updated_items = AsyncMock()
    manager.items_updated = updated_items

    for retired_keys in ({ITEM_KEY, stale_key}, set()):
        status = asyncio.run(scan(manager))
        assert status["state"] == "completed"
        assert status["failed"] == 0
        assert set(writer.write_session.items) == {new_key, other_key}
        assert writer.write_session.items[other_key] == other_item
        updated_items.assert_awaited_once()
        assert (
            set(updated_items.await_args.args[0]) == {new_key, other_key} | retired_keys
        )
        updated_items.reset_mock()


@pytest.mark.parametrize(
    "failure", ["admission", "finalization", "publication", "retirement"]
)
def test_failed_id_replacement_preserves_the_previous_item_until_retry(
    era5_archive: Path,
    tmp_path: Path,
    failure: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Retire an old ID only after its replacement is admitted and published.

    Args:
        era5_archive: Previously admitted archive receiving a new Item ID.
        tmp_path: Isolated scan mount.
        failure: Boundary that rejects the first replacement attempt.
        monkeypatch: Substitutes a failing database deletion for the retirement case.
    """
    manager, writer = create_scanner(tmp_path)
    assert asyncio.run(scan(manager))["failed"] == 0
    prior_item = deepcopy(writer.write_session.items[ITEM_KEY])
    descriptor = era5_archive / "dataset.yaml"
    descriptor.write_text(
        descriptor.read_text().replace("era5-test", "renamed-weather"),
        encoding="utf-8",
    )
    new_key = (ITEM_KEY[0], "renamed-weather")
    updated_items = AsyncMock()
    manager.items_updated = updated_items
    retire_items = manager.catalog_database.delete_replaced_temporal_items
    if failure == "admission":
        with closing(sqlite3.connect(era5_archive / "catalog.sqlite")) as db, db:
            db.execute("UPDATE coverage SET width = 0")
    elif failure == "finalization":
        manager.item_finalizer = AsyncMock()
        manager.item_finalizer.finalize.side_effect = RuntimeError(
            "Finalization failed"
        )
    elif failure == "publication":
        writer.write_session.item_error = RuntimeError("Publication failed")
    else:
        monkeypatch.setattr(
            manager.catalog_database,
            "delete_replaced_temporal_items",
            AsyncMock(side_effect=RuntimeError("Retirement failed")),
        )

    status = asyncio.run(scan(manager))
    assert status["errors"]
    assert status["state"] == (
        "failed" if failure in {"publication", "retirement"} else "completed"
    )
    assert status["catalogItemsWritten"] == (1 if failure == "retirement" else 0)
    assert writer.write_session.items[ITEM_KEY] == prior_item
    assert set(writer.write_session.items) == (
        {ITEM_KEY, new_key} if failure == "retirement" else {ITEM_KEY}
    )
    updated_items.assert_not_awaited()

    if failure == "admission":
        with closing(sqlite3.connect(era5_archive / "catalog.sqlite")) as db, db:
            db.execute("UPDATE coverage SET width = 1440")
    manager.item_finalizer = None
    writer.write_session.item_error = None
    monkeypatch.setattr(
        manager.catalog_database, "delete_replaced_temporal_items", retire_items
    )
    status = asyncio.run(scan(manager))
    assert status["state"] == "completed"
    assert status["failed"] == 0
    assert set(writer.write_session.items) == {new_key}
    updated_items.assert_awaited_once()
    assert set(updated_items.await_args.args[0]) == {ITEM_KEY, new_key}


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


@pytest.mark.parametrize("failure", ["descriptor", "missing-catalog"])
def test_failed_refresh_preserves_prior_item_and_missing_descriptor_removes_it(
    era5_archive: Path,
    tmp_path: Path,
    failure: str,
) -> None:
    """Keep admitted metadata after a failed refresh, then reconcile true removal.

    Args:
        era5_archive: Previously admitted archive.
        tmp_path: Isolated scan mount.
        failure: Broken descriptor or absent SQLite catalog after admission.
    """
    manager, writer = create_scanner(tmp_path)
    assert asyncio.run(scan(manager))["failed"] == 0
    prior_item = deepcopy(writer.write_session.items[ITEM_KEY])
    descriptor = era5_archive / "dataset.yaml"
    if failure == "descriptor":
        descriptor.write_text("source: [not valid", encoding="utf-8")
    else:
        (era5_archive / "catalog.sqlite").unlink()
    status = asyncio.run(scan(manager))
    assert status["failed"] == 1
    assert status["catalogItemsWritten"] == 0
    assert writer.write_session.items[ITEM_KEY] == prior_item
    descriptor.unlink()
    status = asyncio.run(scan(manager))
    assert status["reconciliation"]["removed"] == 1
    assert ITEM_KEY not in writer.write_session.items


@pytest.mark.parametrize(
    "failure, message",
    [
        ("grid", "Unsupported raster grid"),
        ("catalog-escape", "escapes its directory"),
        ("interval", "Invalid time or interval"),
        ("duplicate", "Duplicate observation"),
        ("variable", "Variable metadata differs"),
    ],
)
def test_invalid_external_metadata_is_reported_without_publishing_an_item(
    era5_archive: Path, tmp_path: Path, failure: str, message: str
) -> None:
    """Reject malformed external observation metadata at catalog admission.

    Args:
        era5_archive: Archive to damage before its first scan.
        tmp_path: Isolated scan mount.
        failure: Metadata fault introduced into the fixture.
        message: Useful detail expected from the owning input boundary.
    """
    if failure == "catalog-escape":
        descriptor = era5_archive / "dataset.yaml"
        descriptor.write_text(
            descriptor.read_text().replace("catalog.sqlite", "../outside.sqlite"),
            encoding="utf-8",
        )
    else:
        with closing(sqlite3.connect(era5_archive / "catalog.sqlite")) as db, db:
            updates = {
                "grid": "UPDATE coverage SET width = 0",
                "interval": "UPDATE coverage SET interval_start = interval_end WHERE temporal_type = 'mean'",
                "duplicate": "INSERT INTO coverage SELECT * FROM coverage LIMIT 1",
                "variable": "UPDATE coverage SET units = 'different' WHERE rowid = 1",
            }
            db.execute(updates[failure])
    manager, writer = create_scanner(tmp_path)
    status = asyncio.run(scan(manager))
    assert status["failed"] == 1
    assert message in status["errors"][0]["error"]
    assert writer.write_session.items == {}


def test_regional_float64_grid_and_publication_visibility(era5_archive: Path) -> None:
    """Admit a regional grid while excluding the producer's uncommitted file.

    Args:
        era5_archive: Archive whose published metadata is replaced for this case.
    """
    with closing(sqlite3.connect(era5_archive / "catalog.sqlite")) as db, db:
        db.execute("DELETE FROM coverage")
    publish_month(
        era5_archive,
        2,
        {TEMPERATURE: (0, 24)},
        shape=(3, 4),
        transform=from_origin(10, 20, 0.5, 0.5),
        dtype="float64",
    )
    with closing(sqlite3.connect(era5_archive / "catalog.sqlite")) as db, db:
        db.execute(
            "INSERT INTO publications SELECT variable, valid_time, 'ready' "
            "FROM coverage WHERE valid_time = (SELECT MAX(valid_time) FROM coverage)"
        )
    manager, writer = create_scanner(era5_archive.parent)
    assert asyncio.run(scan(manager))["failed"] == 0
    item = writer.write_session.items[ITEM_KEY]
    assert item["bbox"] == [10, 18.5, 12, 20]
    assert item["properties"]["cube:variables"][TEMPERATURE]["data_type"] == "float64"
    assert item["properties"]["cube:dimensions"]["time"]["extent"] == [
        "2000-02-01T00:00:00Z",
        "2000-02-01T00:00:00Z",
    ]
