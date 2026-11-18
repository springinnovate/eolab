"""Check which original features survive exact layer intersection."""

from pathlib import Path
from uuid import UUID

import fiona
import pytest
from shapely.geometry import LineString, Point, Polygon, box, mapping
from shapely.geometry.base import BaseGeometry

from eolab_app.attribute_filter import VectorFilter
from eolab_app.bounded_vector import resolve_vector_file_selection
from eolab_app.catalog_selection import ResolvedCatalogSelection, UploadedSelection
from eolab_app.feature_intersection import intersecting_feature_ids
from eolab_app.polygon_areas import SummaryPolygon


def _write_layer(
    path: Path, features: list[tuple[BaseGeometry | None, str]], crs: str = "EPSG:4326",
    predicate: VectorFilter | None = None,
) -> ResolvedCatalogSelection:
    """Create a real GeoPackage selection with original geometries and one field.

    Args:
        path: Temporary GeoPackage to write.
        features: Geometry and group value in native row order.
        crs: Coordinate system of the feature coordinates.
        predicate: Filter applied to the test view.

    Returns:
        Selection bound to its original GeoPackage and field schema.
    """
    with fiona.open(path, "w", driver="GPKG", layer="features", crs=crs,
                    schema={"geometry": "Unknown", "properties": {"group": "str"}}) as layer:
        for geometry, group in features:
            layer.write({"geometry": mapping(geometry) if geometry is not None else None,
                         "properties": {"group": group}})
    return resolve_vector_file_selection(path, UploadedSelection(
        uploadId=UUID(int=1), layerName="features", filter=predicate or VectorFilter(),
    ))


def test_filtered_source_uses_exact_geometry_and_includes_boundary_contact(tmp_path: Path) -> None:
    """Check entire target membership against overlapping polygons with a hole."""
    forest = VectorFilter.model_validate({"rules": [{"field": "group", "operator": "eq", "value": "forest"}]})
    boundary = Polygon(box(0, 0, 10, 10).exterior.coords, [box(3, 3, 7, 7).exterior.coords])
    polygons = _write_layer(tmp_path / "boundary.gpkg", [
        (boundary, "forest"), (box(0, 0, 2, 2), "forest"), (box(20, 20, 21, 21), "urban"),
    ], predicate=forest)
    target = _write_layer(tmp_path / "features.gpkg", [
        (Point(1, 1), "both polygons"), (LineString([(-1, 8), (0, 8)]), "touches"),
        (Point(5, 5), "inside the hole"), (Point(20.5, 20.5), "excluded polygon"),
        (box(-1, -1, 11, 11), "contains polygon"), (None, "no geometry"),
    ])
    assert intersecting_feature_ids(target, polygons) == (1, 2, 5)
    assert intersecting_feature_ids(target, ()) == ()


@pytest.mark.parametrize("as_target", [True, False])
def test_drawings_and_projected_source_share_one_comparison(tmp_path: Path, as_target: bool) -> None:
    """A saved WGS84 drawing around one degree east meets only the first metric polygon."""
    projected = _write_layer(tmp_path / "metric.gpkg", [
        (box(110_000, 0, 112_000, 1_000), "near"), (box(500_000, 0, 501_000, 1_000), "far"),
    ], crs="EPSG:3857")
    drawn = (SummaryPolygon.model_validate(mapping(box(0.95, -0.02, 1.05, 0.02))),)
    target, polygons = (drawn, projected) if as_target else (projected, drawn)
    assert intersecting_feature_ids(target, polygons) == ((0,) if as_target else (1,))
