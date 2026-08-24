"""Test Esri File Geodatabase discovery and STAC metadata extraction."""

import asyncio
import logging
import os
import shutil
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import fiona
import pytest

from eolab_app.catalog import filegeodatabase
from eolab_app.catalog.discovery import FilesystemDatasetDiscovery
from eolab_app.catalog.filegeodatabase import (
    FILE_GEODATABASE_MEDIA_TYPE,
    OPENFILEGDB_DRIVER,
    build_stac_items,
)
from eolab_app.catalog.handlers import create_default_dataset_handler_registry
from eolab_app.catalog.metadata import MetadataPipeline
from eolab_app.catalog.scanner import ScanManager
from tests.catalog_support import RecordingCatalogDatabase, RecordingCatalogWriter


def write_spatial_layer(
    geodatabase_path: Path,
    layer_name: str,
    geometry_type: str,
    properties: dict[str, str],
    features: tuple[dict[str, Any], ...],
    *,
    crs: str = "EPSG:4326",
    alias: str | None = None,
) -> None:
    """Create one genuine OpenFileGDB spatial feature class for testing.

    Args:
        geodatabase_path: `.gdb` directory to create or extend.
        layer_name: Exact name for the new feature class.
        geometry_type: Fiona schema geometry type.
        properties: Fiona field-name to field-type schema.
        features: Complete GeoJSON-like features to write.
        crs: Coordinate reference system accepted by Fiona.
        alias: Optional File Geodatabase layer alias.

    Returns:
        None.

    Raises:
        fiona.errors.FionaError: If OpenFileGDB cannot create the fixture.
    """
    creation_options = {}
    if alias is not None:
        creation_options["LAYER_ALIAS"] = alias
    with fiona.open(
        geodatabase_path,
        "w",
        driver=OPENFILEGDB_DRIVER,
        layer=layer_name,
        schema={"geometry": geometry_type, "properties": properties},
        crs=crs,
        **creation_options,
    ) as layer:
        layer.writerecords(features)


def set_tree_modified_at(root: Path, modified_at: datetime) -> None:
    """Set one deterministic modification time on a directory tree.

    Args:
        root: Container directory whose descendants should be updated.
        modified_at: Timezone-aware timestamp to apply.

    Returns:
        None.

    Raises:
        ValueError: If ``modified_at`` has no timezone information.
        OSError: If a path timestamp cannot be updated.
    """
    if modified_at.tzinfo is None:
        raise ValueError("Fixture modification time must be timezone-aware")
    timestamp = modified_at.timestamp()
    for path in root.rglob("*"):
        os.utime(path, (timestamp, timestamp))
    os.utime(root, (timestamp, timestamp))


def create_representative_geodatabase(root: Path) -> Path:
    """Create a two-feature-class File Geodatabase below a mounted root.

    Args:
        root: Mounted source root for the fixture.

    Returns:
        Path to the created `.gdb` directory.

    Raises:
        fiona.errors.FionaError: If OpenFileGDB cannot create the fixture.
    """
    geodatabase_path = root / "Data" / "Habitat.GDB"
    geodatabase_path.parent.mkdir(parents=True)
    write_spatial_layer(
        geodatabase_path,
        "habitat",
        "Polygon",
        {"name": "str:40", "rank": "int"},
        ({
            "type": "Feature",
            "geometry": {
                "type": "Polygon",
                "coordinates": [[
                    [0, 0],
                    [1000, 0],
                    [1000, 1000],
                    [0, 1000],
                    [0, 0],
                ]],
            },
            "properties": {"name": "wetland", "rank": 2},
        },),
        crs="EPSG:3857",
        alias="Priority habitat",
    )
    write_spatial_layer(
        geodatabase_path,
        "observations",
        "Point",
        {"species": "str:40"},
        ({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [-122.5, 48.5]},
            "properties": {"species": "owl"},
        },),
    )
    set_tree_modified_at(
        geodatabase_path,
        datetime(2025, 5, 6, 7, 8, 9, tzinfo=timezone.utc),
    )
    return geodatabase_path


def test_default_discovery_recognizes_and_prunes_gdb_containers(
    tmp_path: Path,
) -> None:
    """Count one `.gdb` source without discovering its internal files.

    Args:
        tmp_path: Isolated mounted source root.

    Returns:
        None.
    """
    geodatabase_path = tmp_path / "Nested" / "Forestry.GDB"
    geodatabase_path.mkdir(parents=True)
    (geodatabase_path / "internal.tif").touch()
    (tmp_path / "visible.tif").touch()

    candidates, errors = FilesystemDatasetDiscovery(
        tmp_path,
        (tmp_path,),
        create_default_dataset_handler_registry(),
    ).discover()

    assert errors == []
    assert [
        (
            candidate.path.relative_to(tmp_path).as_posix(),
            candidate.handler_name,
        )
        for candidate in candidates
    ] == [
        ("Nested/Forestry.GDB", "file-geodatabase"),
        ("visible.tif", "geotiff"),
    ]


def test_openfilegdb_builds_deterministic_items_for_spatial_layers(
    tmp_path: Path,
) -> None:
    """Emit stable, metadata-rich Items for every spatial feature class.

    Args:
        tmp_path: Isolated parent for two equivalent mounted roots.

    Returns:
        None.
    """
    first_root = tmp_path / "first-mount"
    second_root = tmp_path / "second-mount"
    first_geodatabase = create_representative_geodatabase(first_root)
    second_geodatabase = second_root / "Data" / "Habitat.GDB"
    second_geodatabase.parent.mkdir(parents=True)
    shutil.copytree(first_geodatabase, second_geodatabase)

    first_items = build_stac_items(first_root, first_geodatabase)
    second_items = build_stac_items(second_root, second_geodatabase)

    assert len(first_items) == 2
    assert [item["id"] for item in first_items] == [
        item["id"] for item in second_items
    ]
    assert first_items[0]["id"] != first_items[1]["id"]
    assert [item["properties"]["eolab:layer_name"] for item in first_items] == [
        "habitat",
        "observations",
    ]

    habitat_item = first_items[0]
    assert habitat_item["collection"] == "eolab-mounted-vectors"
    assert habitat_item["geometry"]["type"] == "Polygon"
    assert habitat_item["bbox"] == pytest.approx([
        0,
        0,
        0.008983152841195215,
        0.008983152804391995,
    ])
    assert habitat_item["properties"] == {
        "title": "Data/Habitat.GDB/habitat",
        "description": filegeodatabase.FALLBACK_DATETIME_DESCRIPTION,
        "datetime": "2025-05-06T07:08:09Z",
        "eolab:layer_name": "habitat",
        "eolab:layer_alias": "Priority habitat",
        "eolab:vector_source": {
            "kind": "mounted",
            "format": "file-geodatabase",
            "asset_key": "data",
            "layer_name": "habitat",
        },
        "table:row_count": 1,
        "table:columns": [
            {"name": "geometry", "type": "MultiPolygon"},
            {"name": "name", "type": "str:40"},
            {"name": "rank", "type": "float"},
        ],
        "table:primary_geometry": "geometry",
        "proj:epsg": 3857,
        "proj:bbox": [0.0, 0.0, 1000.0, 1000.0],
    }
    assert habitat_item["assets"] == {
        "data": {
            "href": first_geodatabase.resolve().as_uri(),
            "type": FILE_GEODATABASE_MEDIA_TYPE,
            "title": "Data/Habitat.GDB",
            "roles": ["data"],
            "updated": "2025-05-06T07:08:09Z",
            "eolab:layer_name": "habitat",
        },
    }
    assert "eolab:layer_alias" not in first_items[1]["properties"]


def test_file_geodatabase_layer_failures_are_isolated(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Keep readable layer Items when one sibling layer inspection fails.

    Args:
        tmp_path: Isolated mounted source root.
        monkeypatch: Pytest replacement helper.
        caplog: Pytest log-recording helper.

    Returns:
        None.
    """
    geodatabase_path = create_representative_geodatabase(tmp_path)
    original_builder = filegeodatabase.build_layer_stac_item

    def build_with_one_failure(
        source_root: Path,
        candidate_path: Path,
        relative_path_text: str,
        layer_name: str,
        modified_at: datetime,
    ) -> dict[str, Any] | None:
        """Fail one layer while delegating every other layer.

        Args:
            source_root: Root directory mounted for scanning.
            candidate_path: File Geodatabase below the mounted root.
            relative_path_text: Mount-relative POSIX container path.
            layer_name: Exact feature-class name.
            modified_at: Container-level fallback datetime.

        Returns:
            Delegated Item for readable layers.

        Raises:
            fiona.errors.FionaError: If the selected layer is the failure case.
        """
        if layer_name == "habitat":
            raise fiona.errors.FionaError("unreadable feature class")
        return original_builder(
            source_root,
            candidate_path,
            relative_path_text,
            layer_name,
            modified_at,
        )

    monkeypatch.setattr(
        filegeodatabase,
        "build_layer_stac_item",
        build_with_one_failure,
    )
    caplog.set_level(logging.WARNING, logger=filegeodatabase.__name__)

    items = build_stac_items(tmp_path, geodatabase_path)

    assert len(items) == 1
    assert items[0]["properties"]["eolab:layer_name"] == "observations"
    assert "habitat" in caplog.text
    assert "unreadable feature class" in caplog.text


def test_file_geodatabase_zero_item_result_preserves_nonspatial_sources(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Return zero Items when a geodatabase exposes only nonspatial tables.

    Args:
        tmp_path: Isolated mounted source root.
        monkeypatch: Pytest replacement helper.

    Returns:
        None.
    """
    geodatabase_path = tmp_path / "Lookup.gdb"
    geodatabase_path.mkdir()
    monkeypatch.setattr(
        filegeodatabase.fiona,
        "listlayers",
        lambda *args, **kwargs: ["lookup"],
    )
    monkeypatch.setattr(
        filegeodatabase,
        "build_layer_stac_item",
        lambda *args, **kwargs: None,
    )

    assert build_stac_items(tmp_path, geodatabase_path) == ()


def test_file_geodatabase_requires_the_openfilegdb_driver(
    tmp_path: Path,
) -> None:
    """Open a representative fixture through the explicitly allowed driver.

    Args:
        tmp_path: Isolated mounted source root.

    Returns:
        None.
    """
    geodatabase_path = create_representative_geodatabase(tmp_path)

    assert OPENFILEGDB_DRIVER in fiona.supported_drivers
    with fiona.open(
        geodatabase_path,
        layer="habitat",
        enabled_drivers=[OPENFILEGDB_DRIVER],
    ) as layer:
        assert layer.driver == OPENFILEGDB_DRIVER
        assert len(layer) == 1


def test_file_geodatabase_scan_tracks_one_source_and_multiple_items(
    tmp_path: Path,
) -> None:
    """Preserve source and Item cardinality through the complete scan path.

    Args:
        tmp_path: Isolated mounted source root.

    Returns:
        None.
    """
    create_representative_geodatabase(tmp_path)
    registry = create_default_dataset_handler_registry()
    metadata_pipeline = MetadataPipeline(
        tmp_path,
        worker_count=2,
        result_queue_size=2,
        dataset_handlers=registry,
        executor_factory=ThreadPoolExecutor,
    )
    catalog_writer = RecordingCatalogWriter()
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogDatabase(catalog_writer),
        2,
        1,
        1,
        dataset_handlers=registry,
        metadata_pipeline=metadata_pipeline,
    )

    async def run_scan() -> dict[str, Any]:
        """Run the File Geodatabase scan to a terminal state.

        Returns:
            Final public scan status.
        """
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["state"] == "completed"
    assert status["sourceDatasetsDiscovered"] == 1
    assert status["sourceDatasetsProcessed"] == 1
    assert status["catalogItemsProduced"] == 2
    assert status["catalogItemsWritten"] == 2
    assert status["failed"] == 0
    assert status["errors"] == []
    assert len(catalog_writer.write_session.items) == 2
