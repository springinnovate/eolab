"""Test mounted-dataset metadata extraction and scan orchestration."""

import asyncio
import json
import os
from contextlib import AbstractAsyncContextManager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx2
import fiona
import numpy
import pytest
import rasterio
from affine import Affine
from rasterio.transform import from_bounds, from_origin

from eolab_app.geotiff import (
    ACQUISITION_DATETIME_DESCRIPTION,
    FALLBACK_DATETIME_DESCRIPTION,
    build_stac_item as build_geotiff_stac_item,
)
from eolab_app.scanning import DATASET_ITEM_BUILDERS, ScanManager, StacApiWriter
from eolab_app.shapefile import (
    FALLBACK_DATETIME_DESCRIPTION as SHAPEFILE_DATETIME_DESCRIPTION,
    build_stac_item as build_shapefile_stac_item,
    discover_shapefile_datasets,
)


def write_geotiff(
    path: Path,
    acquisition_datetime: str | None = None,
    *,
    crs: str = "EPSG:4326",
    transform: Affine | None = None,
    width: int = 3,
    height: int = 2,
) -> None:
    """Write a small spatially valid GeoTIFF fixture."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if transform is None:
        transform = from_origin(-123, 49, 0.1, 0.1)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=width,
        height=height,
        count=1,
        dtype="uint8",
        crs=crs,
        transform=transform,
        nodata=0,
    ) as dataset:
        dataset.write(numpy.ones((1, height, width), dtype="uint8"))
        if acquisition_datetime is not None:
            dataset.update_tags(
                ns="IMAGERY",
                ACQUISITIONDATETIME=acquisition_datetime,
            )


def write_shapefile(
    path: Path,
    *,
    crs: str = "EPSG:3857",
    geometry: dict[str, Any] | None = None,
    write_feature: bool = True,
) -> tuple[Path, tuple[Path, ...]]:
    """Write and discover a small projected Shapefile fixture."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if geometry is None:
        geometry = {
            "type": "Polygon",
            "coordinates": [[
                [0, 0],
                [1_000, 0],
                [1_000, 1_000],
                [0, 1_000],
                [0, 0],
            ]],
        }
    with fiona.open(
        path,
        "w",
        driver="ESRI Shapefile",
        crs=crs,
        schema={
            "geometry": "Polygon",
            "properties": {"name": "str:40", "rank": "int"},
        },
    ) as dataset:
        if write_feature:
            dataset.write({
                "geometry": geometry,
                "properties": {"name": "fixture", "rank": 1},
            })
    datasets = discover_shapefile_datasets(path.parent, os.listdir(path.parent))
    assert len(datasets) == 1
    return datasets[0]


def test_geotiff_uses_embedded_acquisition_datetime(tmp_path: Path) -> None:
    """Prefer an unambiguous GDAL acquisition timestamp over file metadata."""
    geotiff_path = tmp_path / "nested" / "observation.tif"
    write_geotiff(geotiff_path, "2024-06-15T13:20:04-07:00")

    item = build_geotiff_stac_item(tmp_path, geotiff_path)

    assert item["properties"]["datetime"] == "2024-06-15T20:20:04Z"
    assert item["properties"]["description"] == ACQUISITION_DATETIME_DESCRIPTION
    assert item["properties"]["proj:epsg"] == 4326
    assert item["properties"]["proj:shape"] == [2, 3]
    assert item["bbox"] == pytest.approx([-123, 48.8, -122.7, 49])
    assert item["assets"]["data"]["raster:bands"] == [
        {"data_type": "uint8", "nodata": 0.0}
    ]
    json.dumps(item)


def test_geotiff_discloses_filesystem_timestamp_fallback(tmp_path: Path) -> None:
    """Use and disclose file modification time when observation time is absent."""
    geotiff_path = tmp_path / "model-output.tiff"
    write_geotiff(geotiff_path)
    modified_at = datetime(2025, 2, 11, 17, 31, 52, tzinfo=timezone.utc)
    os.utime(geotiff_path, (modified_at.timestamp(), modified_at.timestamp()))

    item = build_geotiff_stac_item(tmp_path, geotiff_path)

    assert item["properties"]["datetime"] == "2025-02-11T17:31:52Z"
    assert item["properties"]["description"] == FALLBACK_DATETIME_DESCRIPTION
    assert item["assets"]["data"]["updated"] == "2025-02-11T17:31:52Z"


def test_geotiff_transforms_bounds_with_an_invalid_projected_corner(
    tmp_path: Path,
) -> None:
    """Catalog a valid raster whose rectangular extent exceeds its CRS domain."""
    geotiff_path = tmp_path / "partial-eckert-iv.tif"
    projected_bounds = (
        -10834025.0233928,
        5015601.46147158,
        -2980025.0233928,
        8432601.46147158,
    )
    width = height = 10
    write_geotiff(
        geotiff_path,
        crs="+proj=eck4 +lon_0=0 +ellps=GRS80 +units=m +no_defs",
        transform=from_bounds(*projected_bounds, width, height),
        width=width,
        height=height,
    )

    item = build_geotiff_stac_item(tmp_path, geotiff_path)

    assert item["bbox"] == pytest.approx(
        [-178.045549, 40.049153, -35.118271, 86.417527]
    )
    assert item["geometry"] == {
        "type": "Polygon",
        "coordinates": [[
            [item["bbox"][0], item["bbox"][1]],
            [item["bbox"][2], item["bbox"][1]],
            [item["bbox"][2], item["bbox"][3]],
            [item["bbox"][0], item["bbox"][3]],
            [item["bbox"][0], item["bbox"][1]],
        ]],
    }


def test_geotiff_rejects_fully_untransformable_bounds(tmp_path: Path) -> None:
    """Reject a raster when no finite WGS 84 extent can be produced."""
    geotiff_path = tmp_path / "invalid-eckert-iv-extent.tif"
    width = height = 10
    write_geotiff(
        geotiff_path,
        crs="+proj=eck4 +lon_0=0 +ellps=GRS80 +units=m +no_defs",
        transform=from_bounds(
            30_000_000,
            30_000_000,
            31_000_000,
            31_000_000,
            width,
            height,
        ),
        width=width,
        height=height,
    )

    with pytest.raises(ValueError, match="could not be transformed"):
        build_geotiff_stac_item(tmp_path, geotiff_path)


def test_geotiff_rejects_ambiguous_acquisition_datetime(tmp_path: Path) -> None:
    """Reject an acquisition value with no UTC offset instead of guessing."""
    geotiff_path = tmp_path / "ambiguous.tif"
    write_geotiff(geotiff_path, "2024-06-15T13:20:04")

    with pytest.raises(ValueError, match="valid RFC 3339 timestamp"):
        build_geotiff_stac_item(tmp_path, geotiff_path)


def test_item_identifier_is_stable_for_relative_path(tmp_path: Path) -> None:
    """Generate the same identifier whenever the mounted path is rescanned."""
    first_root = tmp_path / "first"
    second_root = tmp_path / "second"
    first_path = first_root / "models" / "result.tif"
    second_path = second_root / "models" / "result.tif"
    write_geotiff(first_path)
    write_geotiff(second_path)

    first_item = build_geotiff_stac_item(first_root, first_path)
    second_item = build_geotiff_stac_item(second_root, second_path)

    assert first_item["id"] == second_item["id"]


def test_geotiff_title_preserves_relative_filename(tmp_path: Path) -> None:
    """Preserve the literal relative path used by Catalog substring search."""
    geotiff_path = tmp_path / "Model Outputs" / "grassland_2002.tif"
    write_geotiff(geotiff_path)

    item = build_geotiff_stac_item(tmp_path, geotiff_path)

    assert item["properties"]["title"] == "Model Outputs/grassland_2002.tif"
    assert "keywords" not in item["properties"]


def test_shapefile_builds_one_projected_vector_item(tmp_path: Path) -> None:
    """Catalog one Shapefile with its projection, schema, and sidecars."""
    shapefile_path, component_paths = write_shapefile(
        tmp_path / "nested" / "habitat.shp"
    )
    modified_at = datetime(2025, 4, 3, 12, 30, tzinfo=timezone.utc)
    for component_path in component_paths:
        os.utime(
            component_path,
            (modified_at.timestamp(), modified_at.timestamp()),
        )

    item = build_shapefile_stac_item(
        tmp_path,
        shapefile_path,
        component_paths,
    )

    assert item["collection"] == "eolab-mounted-vectors"
    assert item["properties"]["title"] == "nested/habitat.shp"
    assert item["properties"]["datetime"] == "2025-04-03T12:30:00Z"
    assert item["properties"]["description"] == SHAPEFILE_DATETIME_DESCRIPTION
    assert item["properties"]["proj:epsg"] == 3857
    assert item["properties"]["proj:bbox"] == pytest.approx([0, 0, 1000, 1000])
    assert item["bbox"] == pytest.approx(
        [0, 0, 0.008983152841, 0.008983152804]
    )
    assert item["properties"]["table:row_count"] == 1
    assert [
        column["name"] for column in item["properties"]["table:columns"]
    ] == ["geometry", "name", "rank"]
    assert item["properties"]["table:primary_geometry"] == "geometry"
    assert {"shp", "shx", "dbf", "prj"} <= item["assets"].keys()
    assert item["assets"]["shp"]["type"] == "application/vnd.shp"
    assert item["assets"]["dbf"]["title"] == "nested/habitat.dbf"
    json.dumps(item)


def test_shapefile_matches_component_extensions_case_insensitively(
    tmp_path: Path,
) -> None:
    """Group uppercase companion extensions under one logical dataset."""
    _, component_paths = write_shapefile(tmp_path / "roads.shp")
    for component_path in component_paths:
        temporary_path = component_path.with_name(f"{component_path.name}.rename")
        component_path.rename(temporary_path)
        temporary_path.rename(
            component_path.with_suffix(component_path.suffix.upper())
        )
    datasets = discover_shapefile_datasets(tmp_path, os.listdir(tmp_path))

    assert len(datasets) == 1
    shapefile_path, uppercase_component_paths = datasets[0]
    item = build_shapefile_stac_item(
        tmp_path,
        shapefile_path,
        uppercase_component_paths,
    )

    assert item["properties"]["title"] == "roads.SHP"
    assert {"shp", "shx", "dbf", "prj"} <= item["assets"].keys()


def test_shapefile_reports_missing_required_component(tmp_path: Path) -> None:
    """Reject one incomplete logical dataset before asking GDAL to open it."""
    write_shapefile(tmp_path / "incomplete.shp")
    (tmp_path / "incomplete.dbf").unlink()
    [(shapefile_path, component_paths)] = discover_shapefile_datasets(
        tmp_path,
        os.listdir(tmp_path),
    )

    with pytest.raises(ValueError, match=r"required components: \.dbf"):
        build_shapefile_stac_item(
            tmp_path,
            shapefile_path,
            component_paths,
        )


def test_shapefile_catalogs_multipart_polygon_layer(tmp_path: Path) -> None:
    """Accept multipart records using the Shapefile layer's Polygon type."""
    polygon = [[
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 100],
        [0, 0],
    ]]
    shapefile_path, component_paths = write_shapefile(
        tmp_path / "multipart.shp",
        geometry={"type": "MultiPolygon", "coordinates": [polygon, polygon]},
    )

    item = build_shapefile_stac_item(
        tmp_path,
        shapefile_path,
        component_paths,
    )

    assert item["properties"]["table:columns"][0] == {
        "name": "geometry",
        "type": "Polygon",
    }
    assert item["properties"]["table:row_count"] == 1


def test_empty_shapefile_has_no_spatial_extent(tmp_path: Path) -> None:
    """Do not invent a zero-area footprint for a dataset with no features."""
    shapefile_path, component_paths = write_shapefile(
        tmp_path / "empty.shp",
        write_feature=False,
    )

    item = build_shapefile_stac_item(
        tmp_path,
        shapefile_path,
        component_paths,
    )

    assert item["properties"]["table:row_count"] == 0
    assert item["geometry"] is None
    assert "bbox" not in item
    assert "proj:bbox" not in item["properties"]


def test_shapefile_serializes_non_epsg_projection_as_wkt2(tmp_path: Path) -> None:
    """Use the Projection extension's WKT2 field for a custom CRS."""
    shapefile_path, component_paths = write_shapefile(
        tmp_path / "custom-projection.shp",
        crs="+proj=eck4 +lon_0=0 +datum=WGS84 +units=m +no_defs",
    )

    item = build_shapefile_stac_item(
        tmp_path,
        shapefile_path,
        component_paths,
    )

    assert "proj:epsg" not in item["properties"]
    assert item["properties"]["proj:wkt2"].startswith("PROJCRS[")


class RecordingCatalogSession:
    """Record catalog writes while providing an async context manager."""

    def __init__(self, item_error: Exception | None = None) -> None:
        self.collections: dict[str, dict[str, Any]] = {}
        self.items: dict[tuple[str, str], dict[str, Any]] = {}
        self.item_batches: list[list[dict[str, Any]]] = []
        self.item_error = item_error

    async def __aenter__(self) -> "RecordingCatalogSession":
        return self

    async def __aexit__(self, *exception_details: object) -> None:
        return None

    async def upsert_collection(self, collection: dict[str, Any]) -> None:
        self.collections[collection["id"]] = collection

    async def upsert_items(self, items: list[dict[str, Any]]) -> None:
        self.item_batches.append(items)
        if self.item_error is not None:
            raise self.item_error
        self.items.update(
            ((item["collection"], item["id"]), item) for item in items
        )


class RecordingCatalogWriter:
    """Return the same in-memory write session for every scan."""

    def __init__(self, item_error: Exception | None = None) -> None:
        self.write_session = RecordingCatalogSession(item_error)

    def session(self) -> AbstractAsyncContextManager[RecordingCatalogSession]:
        return self.write_session


class RecordingCatalogDatabase:
    """Record direct database operations requested by the scanner."""

    def __init__(self, catalog_writer: RecordingCatalogWriter) -> None:
        self.catalog_writer = catalog_writer
        self.search_count_cache_invalidations = 0

    async def existing_item_keys(
        self,
        collection_identifiers: tuple[str, ...],
    ) -> set[tuple[str, str]]:
        assert collection_identifiers == (
            "eolab-mounted-geotiffs",
            "eolab-mounted-vectors",
        )
        return set(self.catalog_writer.write_session.items)

    async def invalidate_search_count_cache(self) -> None:
        self.search_count_cache_invalidations += 1


def test_scan_continues_after_an_invalid_geotiff(tmp_path: Path) -> None:
    """Index valid files, report invalid files, and keep stable upsert results."""
    write_geotiff(tmp_path / "valid.TIF")
    (tmp_path / "invalid.tiff").write_text("not a raster", encoding="utf-8")
    catalog_writer = RecordingCatalogWriter()
    catalog_database = RecordingCatalogDatabase(catalog_writer)
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        catalog_database,
        8,
    )

    async def run_twice() -> tuple[dict[str, Any], dict[str, Any]]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        first_status = scan_manager.status()
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return first_status, scan_manager.status()

    first_status, second_status = asyncio.run(run_twice())

    assert first_status["state"] == "completed"
    assert first_status["discovered"] == 2
    assert first_status["processed"] == 2
    assert first_status["indexed"] == 1
    assert first_status["alreadyInCatalog"] == 0
    assert first_status["failed"] == 1
    assert first_status["errors"][0]["path"] == "invalid.tiff"
    assert second_status["indexed"] == 1
    assert second_status["alreadyInCatalog"] == 1
    assert len(catalog_writer.write_session.collections) == 2
    assert len(catalog_writer.write_session.items) == 1
    assert catalog_database.search_count_cache_invalidations == 2


def test_scan_combines_multiple_directories_under_one_mount(tmp_path: Path) -> None:
    """Scan configured directories while retaining mount-relative Item paths."""
    observations_path = tmp_path / "observations"
    model_outputs_path = tmp_path / "model_outputs"
    write_geotiff(observations_path / "result.tif")
    write_geotiff(model_outputs_path / "result.tif")
    catalog_writer = RecordingCatalogWriter()
    scan_manager = ScanManager(
        tmp_path,
        (observations_path, model_outputs_path),
        catalog_writer,
        RecordingCatalogDatabase(catalog_writer),
        8,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["state"] == "completed"
    assert status["indexed"] == 2
    assert {
        item["properties"]["title"]
        for item in catalog_writer.write_session.items.values()
    } == {"observations/result.tif", "model_outputs/result.tif"}


def test_scan_catalogs_raster_and_shapefile_datasets_together(
    tmp_path: Path,
) -> None:
    """Share progress while retaining Collection-safe, idempotent batches."""
    write_geotiff(tmp_path / "rasters" / "observation.tif")
    write_shapefile(tmp_path / "vectors" / "habitat.shp")
    catalog_writer = RecordingCatalogWriter()
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogDatabase(catalog_writer),
        4,
    )

    async def run_twice() -> tuple[dict[str, Any], dict[str, Any]]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        first_status = scan_manager.status()
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return first_status, scan_manager.status()

    first_status, second_status = asyncio.run(run_twice())

    assert first_status["state"] == "completed"
    assert first_status["discovered"] == 2
    assert first_status["processed"] == 2
    assert first_status["indexed"] == 2
    assert first_status["alreadyInCatalog"] == 0
    assert second_status["indexed"] == 2
    assert second_status["alreadyInCatalog"] == 2
    assert set(catalog_writer.write_session.collections) == {
        "eolab-mounted-geotiffs",
        "eolab-mounted-vectors",
    }
    assert {
        item["collection"]
        for item in catalog_writer.write_session.items.values()
    } == {"eolab-mounted-geotiffs", "eolab-mounted-vectors"}
    assert all(
        len({item["collection"] for item in item_batch}) == 1
        for item_batch in catalog_writer.write_session.item_batches
    )


def test_scan_continues_after_an_incomplete_shapefile(tmp_path: Path) -> None:
    """Report one logical vector error while cataloging other datasets."""
    write_geotiff(tmp_path / "valid.tif")
    (tmp_path / "incomplete.shp").touch()
    catalog_writer = RecordingCatalogWriter()
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogDatabase(catalog_writer),
        2,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["state"] == "completed"
    assert status["discovered"] == 2
    assert status["processed"] == 2
    assert status["indexed"] == 1
    assert status["failed"] == 1
    assert status["errors"] == [{
        "path": "incomplete.shp",
        "error": "Shapefile is missing required components: .dbf, .prj, .shx",
    }]


def test_scan_continues_after_an_unreadable_shapefile(tmp_path: Path) -> None:
    """Reject a corrupt attribute table even when geometry remains readable."""
    write_geotiff(tmp_path / "valid.tif")
    write_shapefile(tmp_path / "corrupt.shp")
    (tmp_path / "corrupt.dbf").write_bytes(b"not a dBASE table")
    catalog_writer = RecordingCatalogWriter()
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogDatabase(catalog_writer),
        2,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["state"] == "completed"
    assert status["indexed"] == 1
    assert status["failed"] == 1
    assert status["errors"][0]["path"] == "corrupt.shp"
    assert status["errors"][0]["error"]


def test_existing_items_are_classified_by_collection_and_identifier(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Do not conflate equal Item identifiers from different Collections."""
    (tmp_path / "raster.tif").touch()
    (tmp_path / "vector.shp").touch()

    def build_item(
        source_root: Path,
        dataset_path: Path,
        *component_paths: tuple[Path, ...],
    ) -> dict[str, Any]:
        collection = (
            "eolab-mounted-vectors"
            if dataset_path.suffix.lower() == ".shp"
            else "eolab-mounted-geotiffs"
        )
        return {"id": "same-id", "collection": collection}

    monkeypatch.setitem(DATASET_ITEM_BUILDERS, ".tif", build_item)
    monkeypatch.setitem(DATASET_ITEM_BUILDERS, ".shp", build_item)
    catalog_writer = RecordingCatalogWriter()
    catalog_writer.write_session.items[
        ("eolab-mounted-geotiffs", "same-id")
    ] = {"id": "same-id", "collection": "eolab-mounted-geotiffs"}
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogDatabase(catalog_writer),
        2,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["indexed"] == 2
    assert status["alreadyInCatalog"] == 1
    assert [
        {item["collection"] for item in item_batch}
        for item_batch in catalog_writer.write_session.item_batches
    ] == [{"eolab-mounted-geotiffs"}, {"eolab-mounted-vectors"}]


def test_scan_reads_metadata_concurrently_and_bulk_upserts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Honor concurrency and keep large raster/vector batches separate."""
    for item_index in range(105):
        (tmp_path / f"item-{item_index:03}.tif").touch()
        (tmp_path / f"item-{item_index:03}.shp").touch()

    active_metadata_calls = 0
    maximum_metadata_calls = 0

    def build_item(
        source_root: Path,
        dataset_path: Path,
        *component_paths: tuple[Path, ...],
    ) -> dict[str, Any]:
        relative_path = dataset_path.relative_to(source_root).as_posix()
        return {
            "id": relative_path,
            "collection": (
                "eolab-mounted-vectors"
                if dataset_path.suffix.lower() == ".shp"
                else "eolab-mounted-geotiffs"
            ),
        }

    async def yielding_to_thread(function: Any, *args: Any) -> Any:
        nonlocal active_metadata_calls, maximum_metadata_calls
        if function is not build_item:
            return function(*args)

        active_metadata_calls += 1
        maximum_metadata_calls = max(maximum_metadata_calls, active_metadata_calls)
        await asyncio.sleep(0)
        try:
            return function(*args)
        finally:
            active_metadata_calls -= 1

    monkeypatch.setitem(DATASET_ITEM_BUILDERS, ".tif", build_item)
    monkeypatch.setitem(DATASET_ITEM_BUILDERS, ".shp", build_item)
    monkeypatch.setattr("eolab_app.scanning.asyncio.to_thread", yielding_to_thread)
    catalog_writer = RecordingCatalogWriter()
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogDatabase(catalog_writer),
        3,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert maximum_metadata_calls == 3
    assert sorted(
        (item_batch[0]["collection"], len(item_batch))
        for item_batch in catalog_writer.write_session.item_batches
    ) == [
        ("eolab-mounted-geotiffs", 5),
        ("eolab-mounted-geotiffs", 100),
        ("eolab-mounted-vectors", 5),
        ("eolab-mounted-vectors", 100),
    ]
    assert status["processed"] == 210
    assert status["indexed"] == 210
    assert status["alreadyInCatalog"] == 0
    assert status["failed"] == 0


def test_scan_caps_error_details_without_losing_failure_count(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep status polling bounded when many files cannot be read."""
    for item_index in range(105):
        (tmp_path / f"invalid-{item_index:03}.tif").touch()

    def reject_item(source_root: Path, geotiff_path: Path) -> dict[str, Any]:
        raise ValueError("invalid raster")

    monkeypatch.setitem(DATASET_ITEM_BUILDERS, ".tif", reject_item)
    catalog_writer = RecordingCatalogWriter()
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogDatabase(catalog_writer),
        8,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["state"] == "completed"
    assert status["processed"] == 105
    assert status["failed"] == 105
    assert len(status["errors"]) == 100
    assert status["errorsTruncated"] is True


def test_scan_stops_after_a_bulk_catalog_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stop and cancel queued work after a systemic catalog failure."""
    for item_index in range(500):
        (tmp_path / f"item-{item_index:03}.tif").touch()

    def build_item(source_root: Path, geotiff_path: Path) -> dict[str, Any]:
        relative_path = geotiff_path.relative_to(source_root).as_posix()
        return {
            "id": relative_path,
            "collection": "eolab-mounted-geotiffs",
        }

    monkeypatch.setitem(DATASET_ITEM_BUILDERS, ".tif", build_item)
    catalog_writer = RecordingCatalogWriter(
        RuntimeError("catalog unavailable")
    )
    catalog_database = RecordingCatalogDatabase(catalog_writer)
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        catalog_database,
        8,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["state"] == "failed"
    assert status["processed"] == 100
    assert status["indexed"] == 0
    assert status["failed"] == 0
    assert len(catalog_writer.write_session.item_batches) == 1
    assert status["errors"][-1] == {
        "path": None,
        "error": "Scan stopped: catalog unavailable",
    }
    assert catalog_database.search_count_cache_invalidations == 0


def test_scan_prevents_overlap(tmp_path: Path) -> None:
    """Reject a second start while directory discovery is still running."""
    catalog_writer = RecordingCatalogWriter()
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogDatabase(catalog_writer),
        8,
    )

    async def start_twice() -> None:
        await scan_manager.start()
        with pytest.raises(RuntimeError, match="already running"):
            await scan_manager.start()

    asyncio.run(start_twice())


def test_catalog_writer_uses_standard_bulk_upserts() -> None:
    """Upsert a batch without per-Item existence requests."""
    requests: list[tuple[str, str, object | None]] = []

    def catalog_response(request: httpx2.Request) -> httpx2.Response:
        request_body = json.loads(request.content) if request.content else None
        requests.append((request.method, request.url.path, request_body))
        if request.method == "GET" and request.url.path.endswith(
            "/eolab-mounted-geotiffs"
        ):
            return httpx2.Response(404)
        return httpx2.Response(200, json="written")

    writer = StacApiWriter(
        "http://stac-api:8080",
        httpx2.MockTransport(catalog_response),
    )

    async def write_records() -> None:
        async with writer.session() as session:
            await session.upsert_collection(
                {"id": "eolab-mounted-geotiffs"}
            )
            await session.upsert_items(
                [{
                    "id": "geotiff-123",
                    "collection": "eolab-mounted-geotiffs",
                }]
            )

    asyncio.run(write_records())

    assert requests == [
        (
            "GET",
            "/collections/eolab-mounted-geotiffs",
            None,
        ),
        (
            "POST",
            "/collections",
            {"id": "eolab-mounted-geotiffs"},
        ),
        (
            "POST",
            "/collections/eolab-mounted-geotiffs/bulk_items",
            {
                "method": "upsert",
                "items": {
                    "geotiff-123": {
                        "id": "geotiff-123",
                        "collection": "eolab-mounted-geotiffs",
                    }
                },
            },
        ),
    ]
