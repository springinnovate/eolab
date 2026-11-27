"""Measure exact original-coordinate extents independently of app and rendering."""

from dataclasses import replace
from pathlib import Path
from uuid import UUID
from typing import Any

import fiona
import pytest
from shapely.affinity import translate
from shapely.geometry import box, mapping, shape

from eolab_app.attribute_filter import VectorFilter, ogr_predicate
from eolab_app.bounded_geometry import GeometryValidationError
from eolab_app.bounded_vector import VectorReadLimits, polygon_records
from eolab_app.catalog_selection import CatalogSelection, ResolvedCatalogSelection
from eolab_app.vector.extent_operation import FeatureExtent, SelectionExtentResult
from eolab_app.vector.extents import read_selected_extent
from eolab_app.feature_intersection import match_features
from eolab_app.polygon_areas import SummaryPolygon


@pytest.mark.parametrize(
    "geometry",
    [
        {"type": "Point", "coordinates": [0, 1000]},
        {"type": "LineString", "coordinates": [[0, 0], [1000, 1000]]},
        {"type": "Polygon", "coordinates": [[[0, 0], [1000, 0], [1000, 1000], [0, 0]]]},
    ],
)
@pytest.mark.parametrize("driver", ["GPKG", "ESRI Shapefile"])
def test_extent_projects_original_geometry_types_and_exact_predicate(
    tmp_path: Path,
    geometry: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
    driver: str,
) -> None:
    """Read points, lines and polygons without a display outline or geometry snapshot.

    Args:
        tmp_path: Isolated original GeoPackage.
        geometry: Native projected geometry whose coordinates should be measured.
        monkeypatch: Control elapsed time without relying on native read speed.
        driver: Mounted format supported by the original-source selection contract.
    """
    path = tmp_path / ("features.gpkg" if driver == "GPKG" else "features.shp")
    with fiona.open(
        path,
        "w",
        driver=driver,
        layer="features",
        crs="EPSG:3857",
        schema={"geometry": geometry["type"], "properties": {"name": "str"}},
    ) as dataset:
        dataset.write({"geometry": geometry, "properties": {"name": "Exact"}})
        dataset.write(
            {
                "geometry": mapping(translate(shape(geometry), xoff=1_000_000)),
                "properties": {"name": "exact"},
            }
        )
    predicate = VectorFilter(
        rules=[{"field": "name", "operator": "eq", "value": "Exact"}]
    )
    selection = CatalogSelection(
        collectionId="eolab-mounted-vectors",
        itemId="features",
        assetKey="data",
        layerName="features",
        filter=predicate,
    )
    resolved = ResolvedCatalogSelection(
        selection, path, driver, ogr_predicate(predicate)
    )
    result = read_selected_extent(resolved)
    assert result["matched"] == 1
    assert set(result) == {"matched", "bbox"}
    west, south, east, north = result["bbox"]
    assert west == pytest.approx(0)
    assert east == pytest.approx(0 if geometry["type"] == "Point" else 0.00898315284)
    assert north == pytest.approx(0.0089831528)
    assert south == pytest.approx(north if geometry["type"] == "Point" else 0)
    for limits in [
        VectorReadLimits(features=0),
        VectorReadLimits(coordinates_per_feature=0),
    ]:
        with pytest.raises(GeometryValidationError, match="budget|coordinate buffer"):
            read_selected_extent(resolved, limits=limits)
    empty = selection.model_copy(
        update={
            "filter": VectorFilter(
                rules=[{"field": "name", "operator": "eq", "value": "absent"}]
            )
        }
    )
    assert read_selected_extent(
        ResolvedCatalogSelection(empty, path, driver, ogr_predicate(empty.filter))
    ) == {"matched": 0, "bbox": None}
    ticks = iter([0, 100])
    monkeypatch.setattr("eolab_app.vector.extents.monotonic", lambda: next(ticks))
    with pytest.raises(GeometryValidationError, match="time budget"):
        read_selected_extent(resolved)


def test_extent_contract_accepts_points_and_rejects_invalid_native_results() -> None:
    """Keep empty/point bounds valid while rejecting partial or malformed results."""
    assert FeatureExtent(matched=1, bbox=(5, 10, 5, 10)).bbox == (5, 10, 5, 10)
    assert FeatureExtent(matched=0, bbox=None).bbox is None
    for result in [
        {},
        {"extent": {"matched": 1, "bbox": [0, 0, 1, 1]}, "error": "bad"},
        {"extent": {"matched": 0, "bbox": [0, 0, 1, 1]}},
        {"extent": {"matched": 1, "bbox": [1, 0, 0, 1]}},
        {"extent": {"matched": 1, "bbox": [0, 0, 1, float("inf")]}},
        {"extent": {"matched": 1, "bbox": [-181, 0, 1, 1]}},
    ]:
        with pytest.raises(ValueError):
            SelectionExtentResult.model_validate(result)


def test_extent_counts_matches_without_coordinates(tmp_path: Path) -> None:
    """Return no bounds for a matching null geometry without falling back to the source extent.

    Args:
        tmp_path: Isolated original GeoPackage.
    """
    path = tmp_path / "null.gpkg"
    with fiona.open(
        path,
        "w",
        driver="GPKG",
        layer="features",
        crs="EPSG:4326",
        schema={"geometry": "Point", "properties": {"name": "str"}},
    ) as dataset:
        dataset.write({"geometry": None, "properties": {"name": "chosen"}})
        dataset.write(
            {
                "geometry": {"type": "Point", "coordinates": [50, 60]},
                "properties": {"name": "other"},
            }
        )
    predicate = VectorFilter(
        rules=[{"field": "name", "operator": "eq", "value": "chosen"}]
    )
    selection = CatalogSelection(
        collectionId="eolab-mounted-vectors",
        itemId="null",
        assetKey="data",
        layerName="features",
        filter=predicate,
    )
    assert read_selected_extent(
        ResolvedCatalogSelection(selection, path, "GPKG", ogr_predicate(predicate))
    ) == {"matched": 1, "bbox": None}


def test_projected_line_extent_includes_curved_edge_between_stored_vertices(
    tmp_path: Path,
) -> None:
    """Include a polar line's northern bulge that transforming endpoints alone misses.

    Args:
        tmp_path: Isolated original GeoPackage in the Arctic polar projection.
    """
    path = tmp_path / "polar.gpkg"
    with fiona.open(
        path,
        "w",
        driver="GPKG",
        layer="features",
        crs="EPSG:3413",
        schema={"geometry": "LineString", "properties": {}},
    ) as dataset:
        dataset.write(
            {
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[-1_000_000, -1_000_000], [1_000_000, -1_000_000]],
                },
                "properties": {},
            }
        )
    selection = CatalogSelection(
        collectionId="eolab-mounted-vectors",
        itemId="polar",
        assetKey="data",
        layerName="features",
        filter=VectorFilter(),
    )
    bbox = read_selected_extent(
        ResolvedCatalogSelection(selection, path, "GPKG", None)
    )["bbox"]
    assert bbox[0] == pytest.approx(-90)
    assert bbox[2] == pytest.approx(0)
    assert bbox[1] == pytest.approx(76.9988155)
    assert bbox[3] == pytest.approx(80.787813)
    assert bbox[3] > 80  # The two stored endpoints both lie below 77 degrees N.


@pytest.mark.parametrize("selected_id", [1, 2**31, 2**32 + 1])
@pytest.mark.parametrize("reader", ["extent", "polygons"])
def test_spatial_matches_keep_colliding_native_ids_distinct(
    tmp_path: Path, selected_id: int, reader: str
) -> None:
    """Read only the polygon whose exact native ID passed the spatial filter.

    Args:
        tmp_path: Isolated original GeoPackage directory.
        selected_id: Native ID selected by geometry, including Windows collisions.
        reader: Existing extent or polygon consumer of the exact spatial result.
    """
    from osgeo import gdal, ogr, osr

    path = tmp_path / "native-ids.gpkg"
    polygons = {
        identifier: box(index * 2, 0, index * 2 + 1, 1)
        for index, identifier in enumerate((1, 2**31, 2**32 + 1))
    }
    with (
        gdal.ExceptionMgr(),
        ogr.ExceptionMgr(),
        osr.ExceptionMgr(),
        ogr.GetDriverByName("GPKG").CreateDataSource(str(path)) as dataset,
    ):
        crs = osr.SpatialReference()
        assert crs.ImportFromEPSG(4326) == 0
        layer = dataset.CreateLayer("features", crs, ogr.wkbPolygon)
        assert layer.CreateField(ogr.FieldDefn("label", ogr.OFTString)) == 0
        for identifier, polygon in polygons.items():
            feature = ogr.Feature(layer.GetLayerDefn())
            feature.SetFID(identifier)
            feature.SetField("label", str(identifier))
            assert feature.SetGeometry(ogr.CreateGeometryFromWkt(polygon.wkt)) == 0
            assert layer.CreateFeature(feature) == 0
    selection = CatalogSelection(
        collectionId="eolab-mounted-vectors",
        itemId="native-ids",
        assetKey="data",
        layerName="features",
        filter=VectorFilter(),
    )
    original = ResolvedCatalogSelection(selection, path, "GPKG", None)
    predicate = VectorFilter.model_validate(
        {
            "rules": [
                {
                    "operator": "intersects",
                    "layerId": str(UUID(int=1)),
                    "source": {"kind": "drawing", "polygonArea": None},
                }
            ]
        }
    )
    boundary = SummaryPolygon.model_validate(mapping(polygons[selected_id]))
    matches = match_features(original, {str(UUID(int=1)): (boundary,)}, predicate)
    assert matches.ids == {selected_id}
    resolved = replace(
        original,
        matches=matches,
        selection=selection.model_copy(update={"filter": predicate}),
    )
    if reader == "extent":
        assert read_selected_extent(resolved) == {
            "matched": 1,
            "bbox": list(polygons[selected_id].bounds),
        }
    else:
        with polygon_records(resolved, ("label",)) as records:
            actual = list(records)
        assert len(actual) == 1
        geometry, properties = actual[0]
        assert shape(geometry).equals(polygons[selected_id])
        assert properties == {"label": str(selected_id)}


@pytest.mark.parametrize("driver", ["GPKG", "ESRI Shapefile"])
@pytest.mark.parametrize("reader", ["extent", "polygons"])
def test_bound_spatial_read_keeps_fields_needed_for_native_predicate(
    tmp_path: Path,
    driver: str,
    reader: str,
) -> None:
    """Keep the selected polygon when its driver's WHERE test needs an attribute.

    Args:
        tmp_path: Isolated mounted source directory.
        driver: Supported driver whose native predicate implementation is used.
        reader: Existing consumer of the bound spatial selection.
    """
    path = tmp_path / ("features.gpkg" if driver == "GPKG" else "features.shp")
    with fiona.open(
        path,
        "w",
        driver=driver,
        layer="features",
        crs="EPSG:4326",
        schema={"geometry": "Polygon", "properties": {"score": "int"}},
    ) as dataset:
        for index, score in enumerate((10, 20)):
            dataset.write(
                {
                    "geometry": mapping(box(index * 2, 0, index * 2 + 1, 1)),
                    "properties": {"score": score},
                }
            )
    selection = CatalogSelection(
        collectionId="eolab-mounted-vectors",
        itemId="features",
        assetKey="data",
        layerName="features",
        filter=VectorFilter(),
    )
    original = ResolvedCatalogSelection(selection, path, driver, None)
    predicate = VectorFilter.model_validate(
        {
            "rules": [
                {
                    "operator": "intersects",
                    "layerId": str(UUID(int=1)),
                    "source": {"kind": "drawing", "polygonArea": None},
                },
                {"field": "score", "operator": "ge", "value": 15},
            ]
        }
    )
    boundary = SummaryPolygon.model_validate(mapping(box(-1, -1, 4, 2)))
    matches = match_features(original, {str(UUID(int=1)): (boundary,)}, predicate)
    resolved = replace(
        original,
        matches=matches,
        where=ogr_predicate(predicate),
        selection=selection.model_copy(update={"filter": predicate}),
    )
    assert matches.counts == {"matched": 1, "total": 2}
    if reader == "extent":
        assert read_selected_extent(resolved) == {"matched": 1, "bbox": [2, 0, 3, 1]}
    else:
        with polygon_records(resolved, ("score",)) as records:
            actual = list(records)
        assert len(actual) == 1
        assert shape(actual[0][0]).equals(box(2, 0, 3, 1))
        assert actual[0][1] == {"score": 20}
