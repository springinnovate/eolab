"""Test focused GeoPackage discovery and spatial-vector layer metadata."""

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import fiona
import pytest

from eolab_app.catalog.geopackage import (
    FALLBACK_DATETIME_DESCRIPTION,
    FILE_EXTENSION,
    GEOPACKAGE_LAYER_PROPERTY,
    GEOPACKAGE_MEDIA_TYPE,
    PROJECTION_EXTENSION,
    build_stac_items,
    discover_geopackage_files,
)
from eolab_app.catalog.handlers import create_default_dataset_handler_registry
from eolab_app.catalog.metadata import build_dataset_metadata
from eolab_app.catalog.models import DatasetCandidate
from eolab_app.catalog.vector import TABLE_EXTENSION


def write_geopackage_layer(
    geopackage_path: Path,
    layer_name: str,
    *,
    crs: str | None = "EPSG:3857",
    geometry_type: str | None = "Polygon",
    geometry: dict[str, Any] | None = None,
    write_feature: bool = True,
) -> None:
    """Add one small vector or attribute layer to a GeoPackage fixture.

    Args:
        geopackage_path: Container path to create or extend.
        layer_name: Exact layer name to add.
        crs: Layer coordinate reference system, or ``None`` for an attribute
            table.
        geometry_type: Fiona schema geometry type, or ``None`` for an
            attribute table.
        geometry: Optional feature geometry matching the schema.
        write_feature: Whether to add one feature row.

    Returns:
        None.
    """
    geopackage_path.parent.mkdir(parents=True, exist_ok=True)
    if geometry is None and geometry_type == "Polygon":
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
        geopackage_path,
        "w",
        driver="GPKG",
        layer=layer_name,
        crs=crs,
        schema={
            "geometry": geometry_type,
            "properties": {"name": "str:40", "rank": "int"},
        },
    ) as dataset:
        if write_feature:
            dataset.write({
                "geometry": geometry,
                "properties": {"name": "fixture", "rank": 1},
            })


def test_geopackage_discovery_is_case_insensitive_and_registered(
    tmp_path: Path,
) -> None:
    """Recognize only `.gpkg` files and dispatch them by an explicit key.

    Args:
        tmp_path: Isolated mounted source directory.

    Returns:
        None.
    """
    (tmp_path / "vectors.GPKG").touch()
    (tmp_path / "extended.gpkx").touch()
    (tmp_path / "ignored.sqlite").touch()

    matches = discover_geopackage_files(
        tmp_path,
        ("extended.gpkx", "ignored.sqlite", "vectors.GPKG"),
    )
    registry = create_default_dataset_handler_registry()
    candidates, pruned_names = registry.discover_directory(
        tmp_path,
        (),
        ("extended.gpkx", "ignored.sqlite", "vectors.GPKG"),
    )

    assert matches == (tmp_path / "vectors.GPKG",)
    assert pruned_names == frozenset()
    assert [
        (candidate.path.name, candidate.handler_name)
        for candidate in candidates
    ] == [("vectors.GPKG", "geopackage")]


def test_geopackage_emits_one_complete_item_per_spatial_vector_layer(
    tmp_path: Path,
) -> None:
    """Catalog multiple spatial layers while excluding an attribute table.

    Args:
        tmp_path: Isolated mounted source directory.

    Returns:
        None.
    """
    geopackage_path = tmp_path / "nested" / "habitats.gpkg"
    write_geopackage_layer(geopackage_path, "areas")
    write_geopackage_layer(
        geopackage_path,
        "sites",
        crs="EPSG:4326",
        geometry_type="Point",
        geometry={"type": "Point", "coordinates": [-122, 48]},
    )
    write_geopackage_layer(
        geopackage_path,
        "notes",
        crs=None,
        geometry_type=None,
        geometry=None,
    )
    modified_at = datetime(2026, 8, 22, 17, 30, tzinfo=timezone.utc)
    os.utime(
        geopackage_path,
        (modified_at.timestamp(), modified_at.timestamp()),
    )

    items = build_stac_items(tmp_path, geopackage_path)

    assert [
        item["properties"][GEOPACKAGE_LAYER_PROPERTY]
        for item in items
    ] == ["areas", "sites"]
    assert len({item["id"] for item in items}) == 2
    areas_item, sites_item = items
    assert areas_item["collection"] == "eolab-mounted-vectors"
    assert areas_item["properties"]["title"] == (
        "nested/habitats.gpkg — areas"
    )
    assert areas_item["properties"]["datetime"] == "2026-08-22T17:30:00Z"
    assert areas_item["properties"]["description"] == (
        f"GeoPackage spatial vector layer 'areas'. "
        f"{FALLBACK_DATETIME_DESCRIPTION}"
    )
    assert areas_item["properties"]["proj:epsg"] == 3857
    assert areas_item["properties"]["proj:bbox"] == pytest.approx(
        [0, 0, 1_000, 1_000]
    )
    assert areas_item["bbox"] == pytest.approx(
        [0, 0, 0.008983152841, 0.008983152804]
    )
    assert areas_item["properties"]["table:row_count"] == 1
    assert areas_item["properties"]["table:columns"] == [
        {"name": "geometry", "type": "Polygon"},
        {"name": "name", "type": "str:40"},
        {"name": "rank", "type": "int"},
    ]
    assert areas_item["properties"]["table:primary_geometry"] == "geometry"
    assert areas_item["geometry"]["type"] == "Polygon"
    assert areas_item["stac_extensions"] == [
        PROJECTION_EXTENSION,
        TABLE_EXTENSION,
        FILE_EXTENSION,
    ]
    assert areas_item["assets"]["data"] == {
        "href": geopackage_path.resolve().as_uri(),
        "type": GEOPACKAGE_MEDIA_TYPE,
        "title": "nested/habitats.gpkg",
        "roles": ["data"],
        "updated": "2026-08-22T17:30:00Z",
        "file:size": geopackage_path.stat().st_size,
        GEOPACKAGE_LAYER_PROPERTY: "areas",
    }
    assert sites_item["geometry"] == {
        "type": "Point",
        "coordinates": [-122, 48],
    }
    assert "proj:wkt2" not in sites_item["properties"]
    json.dumps(items)


def test_geopackage_item_identity_uses_relative_path_and_layer_name(
    tmp_path: Path,
) -> None:
    """Keep rescan IDs stable while distinguishing sibling layer names.

    Args:
        tmp_path: Isolated parent for two mounted source roots.

    Returns:
        None.
    """
    first_root = tmp_path / "first"
    second_root = tmp_path / "second"
    first_path = first_root / "vectors" / "shared.gpkg"
    second_path = second_root / "vectors" / "shared.gpkg"
    for geopackage_path in (first_path, second_path):
        write_geopackage_layer(geopackage_path, "roads")
        write_geopackage_layer(geopackage_path, "sites")

    first_items = build_stac_items(first_root, first_path)
    second_items = build_stac_items(second_root, second_path)

    assert [item["id"] for item in first_items] == [
        item["id"] for item in second_items
    ]
    assert first_items[0]["id"] != first_items[1]["id"]


def test_unreadable_geopackage_layer_does_not_discard_valid_sibling(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Log an unreadable layer and retain Items from layers that still open.

    Args:
        tmp_path: Isolated mounted source directory.
        monkeypatch: Fixture for injecting one GDAL layer-open failure.
        caplog: Fixture recording the layer-level warning.

    Returns:
        None.
    """
    geopackage_path = tmp_path / "partial.gpkg"
    write_geopackage_layer(geopackage_path, "valid")
    real_open = fiona.open

    def list_layers_with_unreadable_layer(path: Path) -> list[str]:
        """Inject one unreadable name beside the fixture's valid layer.

        Args:
            path: GeoPackage path passed by the production builder.

        Returns:
            The injected and real layer names in deterministic order.
        """
        assert path == geopackage_path
        return ["unreadable", "valid"]

    def open_with_unreadable_layer(
        *args: Any,
        **kwargs: Any,
    ) -> fiona.Collection:
        """Raise for the injected layer and delegate every real layer.

        Args:
            *args: Positional arguments accepted by :func:`fiona.open`.
            **kwargs: Keyword arguments accepted by :func:`fiona.open`.

        Returns:
            An open Fiona collection for a real layer.

        Raises:
            fiona.errors.DriverError: If the requested layer is the injected
                unreadable layer.
        """
        if kwargs.get("layer") == "unreadable":
            raise fiona.errors.DriverError("injected layer failure")
        return real_open(*args, **kwargs)

    monkeypatch.setattr(
        "eolab_app.catalog.geopackage.fiona.listlayers",
        list_layers_with_unreadable_layer,
    )
    monkeypatch.setattr(
        "eolab_app.catalog.geopackage.fiona.open",
        open_with_unreadable_layer,
    )
    caplog.set_level(logging.WARNING, logger="eolab_app.catalog.geopackage")

    items = build_stac_items(tmp_path, geopackage_path)

    assert len(items) == 1
    assert items[0]["properties"][GEOPACKAGE_LAYER_PROPERTY] == "valid"
    assert "unreadable" in caplog.text
    assert "injected layer failure" in caplog.text


def test_malformed_geopackage_is_an_isolated_dataset_error(
    tmp_path: Path,
) -> None:
    """Capture one malformed container without affecting another candidate.

    Args:
        tmp_path: Isolated mounted source directory.

    Returns:
        None.
    """
    valid_path = tmp_path / "valid.gpkg"
    malformed_path = tmp_path / "malformed.gpkg"
    write_geopackage_layer(valid_path, "areas")
    malformed_path.write_text("not a GeoPackage", encoding="utf-8")
    registry = create_default_dataset_handler_registry()

    malformed_result = build_dataset_metadata(
        tmp_path,
        DatasetCandidate(malformed_path, "geopackage"),
        registry,
    )
    valid_result = build_dataset_metadata(
        tmp_path,
        DatasetCandidate(valid_path, "geopackage"),
        registry,
    )

    assert malformed_result.items == ()
    assert malformed_result.error is not None
    assert valid_result.error is None
    assert len(valid_result.items) == 1


def test_geopackage_without_catalogable_spatial_layers_reports_source_error(
    tmp_path: Path,
) -> None:
    """Reject an empty spatial layer instead of emitting geometry-free Items.

    Args:
        tmp_path: Isolated mounted source directory.

    Returns:
        None.
    """
    geopackage_path = tmp_path / "empty.gpkg"
    write_geopackage_layer(
        geopackage_path,
        "empty",
        write_feature=False,
    )

    with pytest.raises(
        ValueError,
        match="no catalogable spatial vector layers.*no features",
    ):
        build_stac_items(tmp_path, geopackage_path)
