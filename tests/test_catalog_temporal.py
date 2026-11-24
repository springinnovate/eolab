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


def publish_observation_summary(archive: Path) -> None:
    """Materialize the producer's grouped summary contract for fixture observations.

    Args:
        archive: Test archive whose published observations supply metadata groups,
            repeated variable totals and time bounds. Ready publication hides the
            public summary until publication settles.
    """
    with closing(sqlite3.connect(archive / "catalog.sqlite")) as db, db:
        db.executescript("""
            DROP VIEW IF EXISTS observation_summary;
            DROP TABLE IF EXISTS summary_rows;
            CREATE TABLE summary_rows AS
            SELECT variable, name, units, band, dtype, nodata, temporal_type,
                   crs, transform, height, width,
                   COUNT(*) AS group_observation_count,
                   SUM(COUNT(*)) OVER (PARTITION BY variable) AS observation_count,
                   MIN(MIN(valid_time)) OVER (PARTITION BY variable) AS valid_time_min,
                   MAX(MAX(valid_time)) OVER (PARTITION BY variable) AS valid_time_max,
                   MIN(MIN(interval_start)) OVER (PARTITION BY variable) AS interval_start_min,
                   MAX(MAX(interval_end)) OVER (PARTITION BY variable) AS interval_end_max
            FROM observations
            GROUP BY variable, name, units, band, dtype, nodata, temporal_type,
                     crs, transform, height, width;
            CREATE VIEW observation_summary AS SELECT * FROM summary_rows
            WHERE NOT EXISTS (SELECT 1 FROM publications WHERE status = 'ready');
        """)


def restrict_catalog_reads(
    monkeypatch: pytest.MonkeyPatch, *, forbidden: set[str]
) -> list[str]:
    """Record real SQLite queries while rejecting reads of selected relations.

    Args:
        monkeypatch: Scope that temporarily replaces connection creation.
        forbidden: Tables or views whose rows the reader must not access.

    Returns:
        Queries executed by connections opened within the patch scope.
    """
    connect = sqlite3.connect
    queries: list[str] = []

    def authorize(
        action: int,
        relation: str | None,
        column: str | None,
        database: str | None,
        trigger: str | None,
    ) -> int:
        """Reject forbidden source reads at SQLite's authorization boundary.

        Args:
            action: SQLite operation code.
            relation: Table or view affected by the operation.
            column: Column read, when applicable.
            database: SQLite database name.
            trigger: Initiating view or trigger name.

        Returns:
            SQLite's allow or deny result for this operation.
        """
        del column, database, trigger
        return (
            sqlite3.SQLITE_DENY
            if action == sqlite3.SQLITE_READ and relation in forbidden
            else sqlite3.SQLITE_OK
        )

    def open_catalog(*args: Any, **kwargs: Any) -> sqlite3.Connection:
        """Open a real catalog connection with read tracing and authorization.

        Args:
            *args: SQLite connection arguments.
            **kwargs: SQLite connection options.

        Returns:
            Connection retaining actual SQLite query and error behavior.
        """
        connection = connect(*args, **kwargs)
        connection.set_authorizer(authorize)
        connection.set_trace_callback(queries.append)
        return connection

    monkeypatch.setattr(sqlite3, "connect", open_catalog)
    return queries


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
    initialize_reader = rasterio.io.DatasetReader.__init__

    def record_open(
        reader: rasterio.io.DatasetReader, *args: Any, **kwargs: Any
    ) -> None:
        """Record the actual file opened by Rasterio or its GeoTIFF reader subclass.

        Args:
            reader: Native dataset reader under construction.
            *args: Native file and positional open arguments.
            **kwargs: Native keyword open arguments.
        """
        initialize_reader(reader, *args, **kwargs)
        opened.append(Path(reader.name))

    monkeypatch.setattr(rasterio.io.DatasetReader, "__init__", record_open)
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
    with closing(sqlite3.connect(era5_archive / "catalog.sqlite")) as db, db:
        db.execute(
            "UPDATE coverage SET units = 'kelvin' WHERE variable = ?", (TEMPERATURE,)
        )
    updated_items = AsyncMock()
    manager.items_updated = updated_items
    for _ in range(2):
        status = asyncio.run(scan(manager))
        assert status["failed"] == 0
        assert status["catalogItemsAlreadyPresent"] == 1
        assert set(writer.write_session.items) == {ITEM_KEY}
        assert (
            writer.write_session.items[ITEM_KEY]["properties"]["end_datetime"]
            == "2000-02-01T03:00:00Z"
        )
        assert (
            writer.write_session.items[ITEM_KEY]["properties"]["cube:variables"][
                TEMPERATURE
            ]["unit"]
            == "kelvin"
        )
        updated_items.assert_awaited_once_with((ITEM_KEY,))
        updated_items.reset_mock()


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


@pytest.mark.parametrize(
    "field, value, message",
    [
        ("band", 2, "Unsupported raster grid"),
        ("crs", "EPSG:3857", "share one raster grid"),
        ("transform", "[0, 1, 0, 0, 0, 1]", "Unsupported raster grid"),
        ("units", "different", "Variable metadata differs"),
        ("dtype", "object", "Unsupported variable metadata"),
        ("nodata", "not numeric", "could not convert string to float"),
        ("valid_time", "not a time", "Invalid time or interval"),
        ("valid_time", None, "Invalid time or interval"),
        ("valid_time", 0.5, "Invalid time or interval"),
        ("reference_time", "not a time", "Invalid time or interval"),
        ("interval_start", None, "Invalid time or interval"),
        ("interval_start", 0.5, "Invalid time or interval"),
        ("interval_end", None, "Invalid time or interval"),
        ("interval_end", 0.5, "Invalid time or interval"),
        ("interval_start", 0, "Invalid time or interval"),
    ],
)
def test_later_observation_still_validates_changed_metadata_and_time(
    era5_archive: Path, tmp_path: Path, field: str, value: Any, message: str
) -> None:
    """Reject malformed values in an otherwise valid observation catalog.

    Args:
        era5_archive: Published observations with repeated metadata.
        tmp_path: Isolated source mount.
        field: Fixture column to corrupt in the last temperature observation.
        value: Invalid or conflicting value for that field.
        message: Expected admission failure.
    """
    with closing(sqlite3.connect(era5_archive / "catalog.sqlite")) as db, db:
        db.execute(
            f"UPDATE coverage SET {field} = ? WHERE rowid = "
            "(SELECT rowid FROM coverage WHERE variable = ? ORDER BY valid_time DESC LIMIT 1)",
            (value, TEMPERATURE),
        )
    manager, writer = create_scanner(tmp_path)
    status = asyncio.run(scan(manager))
    assert status["failed"] == 1
    assert message in status["errors"][0]["error"]
    assert writer.write_session.items == {}


def test_equal_valued_real_height_does_not_reuse_a_valid_integer_grid(
    era5_archive: Path, tmp_path: Path
) -> None:
    """Keep SQLite value types significant when a later grid repeats its size.

    Args:
        era5_archive: Valid source whose final temperature height becomes a REAL.
        tmp_path: Isolated source mount.
    """
    with closing(sqlite3.connect(era5_archive / "catalog.sqlite")) as db, db:
        last_row = db.execute(
            "SELECT rowid FROM coverage WHERE variable = ? ORDER BY valid_time DESC LIMIT 1",
            (TEMPERATURE,),
        ).fetchone()[0]
        columns = [
            (
                f"CASE WHEN rowid = {last_row} THEN CAST(height AS REAL) ELSE height END AS height"
                if row[1] == "height"
                else row[1]
            )
            for row in db.execute("PRAGMA table_info(coverage)")
        ]
        db.execute("DROP VIEW observations")
        db.execute(
            f"CREATE VIEW observations AS SELECT {', '.join(columns)} FROM coverage"
        )
    manager, writer = create_scanner(tmp_path)
    status = asyncio.run(scan(manager))
    assert status["failed"] == 1
    assert "Unsupported raster grid" in status["errors"][0]["error"]
    assert writer.write_session.items == {}


def test_equivalent_grid_and_nodata_representations_keep_the_same_item(
    era5_archive: Path, tmp_path: Path
) -> None:
    """Compare parsed metadata so alternate valid spellings remain admissible.

    Args:
        era5_archive: Source with equivalent CRS, transform and NoData encodings.
        tmp_path: Isolated source mount.
    """
    manager, writer = create_scanner(tmp_path)
    assert asyncio.run(scan(manager))["failed"] == 0
    original = deepcopy(writer.write_session.items[ITEM_KEY])
    with closing(sqlite3.connect(era5_archive / "catalog.sqlite")) as db, db:
        transform = db.execute("SELECT transform FROM coverage LIMIT 1").fetchone()[0]
        db.execute(
            "UPDATE coverage SET crs = ?, transform = ?, nodata = 'nan' WHERE rowid = "
            "(SELECT rowid FROM coverage WHERE variable = ? ORDER BY valid_time DESC LIMIT 1)",
            (
                rasterio.crs.CRS.from_epsg(4326).to_wkt(),
                json.dumps(json.loads(transform), indent=2),
                TEMPERATURE,
            ),
        )
    assert asyncio.run(scan(manager))["failed"] == 0
    assert writer.write_session.items[ITEM_KEY] == original


@pytest.mark.parametrize("year", [1950, 2000])
def test_summary_matches_full_item_without_reading_observations_or_tiffs(
    era5_archive: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    year: int,
) -> None:
    """Use compact metadata for identical partial-date Items before and after 1970.

    Args:
        era5_archive: Sparse published observations with variable-specific gaps.
        tmp_path: Isolated source mount.
        monkeypatch: Denies row reads and raster opens after summary publication.
        year: Calendar year to represent with the fixture timestamps.
    """
    offset = int((datetime(year, 1, 1) - datetime(2000, 1, 1)).total_seconds())
    with closing(sqlite3.connect(era5_archive / "catalog.sqlite")) as db, db:
        db.execute(
            "UPDATE coverage SET valid_time=valid_time+?, reference_time=reference_time+?, "
            "interval_start=interval_start+?, interval_end=interval_end+?",
            (offset,) * 4,
        )
    manager, writer = create_scanner(tmp_path)
    assert asyncio.run(scan(manager))["failed"] == 0
    original = deepcopy(writer.write_session.items[ITEM_KEY])
    publish_observation_summary(era5_archive)
    queries = restrict_catalog_reads(
        monkeypatch, forbidden={"observations", "coverage"}
    )

    def reject_raster_open(*args: Any, **kwargs: Any) -> None:
        """Fail if temporal metadata extraction tries to open a raster.

        Args:
            *args: Raster open arguments that must not be used.
            **kwargs: Raster open options that must not be used.

        Raises:
            AssertionError: Any attempted raster open.
        """
        raise AssertionError("Summary admission must not open TIFFs")

    monkeypatch.setattr(rasterio, "open", reject_raster_open)
    assert asyncio.run(scan(manager))["failed"] == 0
    assert writer.write_session.items[ITEM_KEY] == original
    assert any("FROM observation_summary" in query for query in queries)
    assert original["properties"]["start_datetime"].startswith(str(year))


def test_summary_normalizes_equivalent_metadata_groups(
    era5_archive: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Accept distinct raw groups whose parsed grid and NoData are equivalent.

    Args:
        era5_archive: Archive receiving an alternate encoding on one observation.
        tmp_path: Isolated source mount.
        monkeypatch: Prevents the compact reader from traversing observations.
    """
    with closing(sqlite3.connect(era5_archive / "catalog.sqlite")) as db, db:
        transform = db.execute("SELECT transform FROM coverage LIMIT 1").fetchone()[0]
        db.execute(
            "UPDATE coverage SET crs=?, transform=?, nodata='nan' WHERE rowid=1",
            (
                rasterio.crs.CRS.from_epsg(4326).to_wkt(),
                json.dumps(json.loads(transform), indent=2),
            ),
        )
    manager, writer = create_scanner(tmp_path)
    assert asyncio.run(scan(manager))["failed"] == 0
    original = deepcopy(writer.write_session.items[ITEM_KEY])
    publish_observation_summary(era5_archive)
    with closing(sqlite3.connect(era5_archive / "catalog.sqlite")) as db:
        assert db.execute("SELECT COUNT(*) FROM observation_summary").fetchone()[0] == 4
    restrict_catalog_reads(monkeypatch, forbidden={"observations", "coverage"})
    assert asyncio.run(scan(manager))["failed"] == 0
    assert writer.write_session.items[ITEM_KEY] == original


@pytest.mark.parametrize(
    "field,value,message",
    [
        ("group_observation_count", 0, "Invalid observation summary count"),
        ("group_observation_count", 1.5, "Invalid observation summary count"),
        ("observation_count", None, "Invalid observation summary count"),
        ("observation_count", -1, "Invalid observation summary count"),
        ("group_observation_count", 100, "group counts do not match total"),
        ("valid_time_min", None, "Invalid time or interval"),
        ("valid_time_max", 0.5, "Invalid time or interval"),
        ("valid_time_min", 0, "Invalid time or interval"),
        ("interval_start_min", 0.5, "Invalid time or interval"),
        ("interval_end_max", 0, "Invalid time or interval"),
        ("band", 2, "Unsupported raster grid"),
        ("height", 0, "Unsupported raster grid"),
        ("width", 0.5, "Unsupported raster grid"),
        ("crs", "EPSG:3857", "share one raster grid"),
        ("dtype", "object", "Unsupported variable metadata"),
        ("units", "", "Unsupported variable metadata"),
    ],
)
def test_malformed_summary_is_rejected_without_observation_fallback(
    era5_archive: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    field: str,
    value: Any,
    message: str,
) -> None:
    """Reject invalid advertised summary values at the admission boundary.

    Args:
        era5_archive: Valid source whose summary receives one malformed field.
        tmp_path: Isolated source mount.
        monkeypatch: Forbids silently replacing a bad summary with a full scan.
        field: External summary field to corrupt.
        value: Invalid value stored in that field.
        message: Expected useful admission failure.
    """
    publish_observation_summary(era5_archive)
    with closing(sqlite3.connect(era5_archive / "catalog.sqlite")) as db, db:
        db.execute(
            f"UPDATE summary_rows SET {field}=? WHERE variable=?", (value, TEMPERATURE)
        )
    restrict_catalog_reads(monkeypatch, forbidden={"observations", "coverage"})
    manager, writer = create_scanner(tmp_path)
    status = asyncio.run(scan(manager))
    assert status["failed"] == 1
    assert message in status["errors"][0]["error"]
    assert writer.write_session.items == {}


@pytest.mark.parametrize(
    "field,value,message",
    [
        ("units", "different", "Variable metadata differs"),
        ("width", 720, "share one raster grid"),
        ("temporal_type", "mean", "Variable metadata differs"),
    ],
)
def test_summary_preserves_metadata_homogeneity_rejection(
    era5_archive: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    field: str,
    value: Any,
    message: str,
) -> None:
    """Reject mixed valid metadata groups instead of hiding them in a summary.

    Args:
        era5_archive: Published observations with one inconsistent group.
        tmp_path: Isolated source mount.
        monkeypatch: Forbids full observation reads.
        field: Metadata field changed in one observation.
        value: Individually parseable value that conflicts with its peers.
        message: The owning metadata validation failure.
    """
    with closing(sqlite3.connect(era5_archive / "catalog.sqlite")) as db, db:
        db.execute(f"UPDATE coverage SET {field}=? WHERE rowid=1", (value,))
        if field == "temporal_type":
            db.execute(
                "UPDATE coverage SET interval_start=valid_time-3600 WHERE rowid=1"
            )
    publish_observation_summary(era5_archive)
    restrict_catalog_reads(monkeypatch, forbidden={"observations", "coverage"})
    manager, writer = create_scanner(tmp_path)
    status = asyncio.run(scan(manager))
    assert status["failed"] == 1
    assert message in status["errors"][0]["error"]
    assert writer.write_session.items == {}


@pytest.mark.parametrize("field", ["observation_count", "time_bounds"])
def test_summary_rejects_inconsistent_repeated_variable_totals(
    era5_archive: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    field: str,
) -> None:
    """Require every metadata group to report the same variable totals and bounds.

    Args:
        era5_archive: Source split into equivalent NoData metadata groups.
        tmp_path: Isolated source mount.
        monkeypatch: Forbids observation fallback.
        field: Repeated count or time bounds changed in one group.
    """
    with closing(sqlite3.connect(era5_archive / "catalog.sqlite")) as db, db:
        db.execute("UPDATE coverage SET nodata='nan' WHERE rowid=1")
    publish_observation_summary(era5_archive)
    with closing(sqlite3.connect(era5_archive / "catalog.sqlite")) as db, db:
        assignment = (
            "observation_count=observation_count+1"
            if field == "observation_count"
            else "valid_time_max=valid_time_max+3600, interval_end_max=interval_end_max+3600"
        )
        db.execute(f"UPDATE summary_rows SET {assignment} WHERE nodata='nan'")
    restrict_catalog_reads(monkeypatch, forbidden={"observations", "coverage"})
    manager, writer = create_scanner(tmp_path)
    status = asyncio.run(scan(manager))
    assert status["failed"] == 1
    assert "totals or time bounds differ" in status["errors"][0]["error"]
    assert writer.write_session.items == {}


@pytest.mark.parametrize("unavailable", ["empty", "ready"])
def test_empty_summary_reads_current_published_observations(
    era5_archive: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    unavailable: str,
) -> None:
    """Fall back when a summary is uninitialized or hidden during ready publication.

    Args:
        era5_archive: Source whose summary is intentionally unavailable.
        tmp_path: Isolated source mount.
        monkeypatch: Records actual fallback queries.
        unavailable: Empty backing rows or an unfinished ready publication.
    """
    if unavailable == "ready":
        with closing(sqlite3.connect(era5_archive / "catalog.sqlite")) as db, db:
            db.execute(
                "INSERT INTO publications SELECT variable, valid_time, 'ready' "
                "FROM coverage WHERE valid_time=(SELECT MAX(valid_time) FROM coverage)"
            )
    manager, writer = create_scanner(tmp_path)
    assert asyncio.run(scan(manager))["failed"] == 0
    original = deepcopy(writer.write_session.items[ITEM_KEY])
    publish_observation_summary(era5_archive)
    if unavailable == "empty":
        with closing(sqlite3.connect(era5_archive / "catalog.sqlite")) as db, db:
            db.execute("DELETE FROM summary_rows")
    queries = restrict_catalog_reads(monkeypatch, forbidden=set())
    assert asyncio.run(scan(manager))["failed"] == 0
    assert writer.write_session.items[ITEM_KEY] == original
    assert any("FROM observations ORDER BY" in query for query in queries)


@pytest.mark.parametrize(
    "failure,message",
    [
        ("broken-view", "no such table"),
        ("missing-column", "no such column"),
        ("read-denied", "prohibited"),
    ],
)
def test_summary_source_errors_remain_visible(
    era5_archive: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
    message: str,
) -> None:
    """Report broken or unreadable summary relations rather than silently scanning.

    Args:
        era5_archive: Source with an advertised summary that cannot be read.
        tmp_path: Isolated source mount.
        monkeypatch: Rejects unauthorized reads at the real SQLite boundary.
        failure: Broken relation, missing required field, or denied source read.
        message: Source error expected in the scan result.
    """
    publish_observation_summary(era5_archive)
    if failure != "read-denied":
        with closing(sqlite3.connect(era5_archive / "catalog.sqlite")) as db, db:
            db.execute("DROP VIEW observation_summary")
            query = (
                "SELECT * FROM missing_summary"
                if failure == "broken-view"
                else "SELECT variable FROM summary_rows"
            )
            db.execute(f"CREATE VIEW observation_summary AS {query}")
    forbidden = {"observations", "coverage"}
    if failure == "read-denied":
        forbidden.add("summary_rows")
    restrict_catalog_reads(monkeypatch, forbidden=forbidden)
    manager, writer = create_scanner(tmp_path)
    status = asyncio.run(scan(manager))
    assert status["failed"] == 1
    assert message in status["errors"][0]["error"]
    assert writer.write_session.items == {}


def test_summary_refresh_publishes_added_dates_and_replaced_metadata(
    era5_archive: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Refresh the same Item and notify caches after producer summary publication.

    Args:
        era5_archive: Source receiving additional coverage and a metadata replacement.
        tmp_path: Isolated source mount.
        monkeypatch: Forbids observation reads during both compact admissions.
    """
    publish_observation_summary(era5_archive)
    manager, writer = create_scanner(tmp_path)
    with monkeypatch.context() as patch:
        restrict_catalog_reads(patch, forbidden={"observations", "coverage"})
        assert asyncio.run(scan(manager))["failed"] == 0
    publish_month(era5_archive, 2, {TEMPERATURE: (0, 1, 2, 3)})
    with closing(sqlite3.connect(era5_archive / "catalog.sqlite")) as db, db:
        db.execute(
            "UPDATE coverage SET units='kelvin' WHERE variable=?", (TEMPERATURE,)
        )
    publish_observation_summary(era5_archive)
    updated_items = AsyncMock()
    manager.items_updated = updated_items
    restrict_catalog_reads(monkeypatch, forbidden={"observations", "coverage"})
    assert asyncio.run(scan(manager))["failed"] == 0
    assert set(writer.write_session.items) == {ITEM_KEY}
    item = writer.write_session.items[ITEM_KEY]
    assert item["properties"]["end_datetime"] == "2000-02-01T03:00:00Z"
    assert item["properties"]["cube:variables"][TEMPERATURE]["unit"] == "kelvin"
    updated_items.assert_awaited_once_with((ITEM_KEY,))
