"""Check which original features survive exact layer intersection."""

import asyncio
from dataclasses import replace
from pathlib import Path
from uuid import UUID
from typing import Any

import fiona
import pytest
from shapely.geometry import LineString, Point, Polygon, box, mapping
from shapely.geometry.base import BaseGeometry

from eolab_app.attribute_filter import VectorFilter
from eolab_app.bounded_vector import count_selected_features, resolve_vector_file_selection
from eolab_app.catalog_selection import (
    ResolvedCatalogSelection,
    UploadedSelection,
    DrawingSelection,
    VectorSelection,
)
from eolab_app.feature_intersection import bind_intersections, match_features
from eolab_app.polygon_areas import SummaryPolygon
from eolab_app.vector.display_feature_ids import display_feature_ranges
from eolab_app.vector.parcels import read_parcel_rows
from eolab_app.vector.feature_attributes import read_feature_attributes


def _write_layer(
    path: Path,
    features: list[tuple[BaseGeometry | None, str]],
    crs: str = "EPSG:4326",
    predicate: VectorFilter | None = None,
    geometry_type: str = "Unknown",
    *,
    spatial_index: bool = True,
) -> ResolvedCatalogSelection:
    """Create a real GeoPackage selection with original geometries and one field.

    Args:
        path: Temporary GeoPackage to write.
        features: Geometry and group value in native row order.
        crs: Coordinate system of the feature coordinates.
        predicate: Filter applied to the test view.
        geometry_type: Declared native layer geometry, including mixed test layers.
        spatial_index: Whether the original layer has a native GeoPackage index.

    Returns:
        Selection bound to its original GeoPackage and field schema.
    """
    with fiona.open(
        path,
        "w",
        driver="GPKG",
        layer="features",
        crs=crs,
        schema={"geometry": geometry_type, "properties": {"group": "str"}},
        SPATIAL_INDEX="YES" if spatial_index else "NO",
    ) as layer:
        for geometry, group in features:
            layer.write(
                {
                    "geometry": mapping(geometry) if geometry is not None else None,
                    "properties": {"group": group},
                }
            )
    return resolve_vector_file_selection(
        path,
        UploadedSelection(
            uploadId=UUID(int=1),
            layerName="features",
            filter=predicate or VectorFilter(),
        ),
    )


def _spatial_rule() -> VectorFilter:
    """Give the geometry tests one spatial clause with an independently supplied polygon view."""
    return VectorFilter.model_validate({"rules": [{"operator": "intersects", "layerId": UUID(int=1),
                                        "source": {"kind": "drawing", "polygonArea": None}}]})


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
    assert match_features(target, {str(UUID(int=1)): polygons}, _spatial_rule()).ids == {1, 2, 5}
    assert match_features(target, {str(UUID(int=1)): ()}, _spatial_rule()).counts == {"matched": 0, "total": 6}


def _write_native_geometry(path: Path, wkt: str) -> ResolvedCatalogSelection:
    """Write an original feature whose native type is unavailable in Shapely.

    Args:
        path: Temporary GeoPackage for the selected layer.
        wkt: Original geometry in GDAL's well-known text format.

    Returns:
        A resolved selection containing the feature at native ID 1.
    """
    from osgeo import gdal, ogr, osr

    with (
        gdal.ExceptionMgr(),
        ogr.ExceptionMgr(),
        osr.ExceptionMgr(),
        ogr.GetDriverByName("GPKG").CreateDataSource(str(path)) as dataset,
    ):
        crs = osr.SpatialReference()
        assert crs.ImportFromEPSG(4326) == 0
        geometry = ogr.CreateGeometryFromWkt(wkt)
        layer = dataset.CreateLayer("features", crs, geometry.GetGeometryType())
        feature = ogr.Feature(layer.GetLayerDefn())
        assert feature.SetGeometry(geometry) == 0
        assert layer.CreateFeature(feature) == 0
    return resolve_vector_file_selection(
        path,
        UploadedSelection(
            uploadId=UUID(int=2), layerName="features", filter=VectorFilter()
        ),
    )


@pytest.mark.parametrize(
    "wkt",
    [
        "CURVEPOLYGON (CIRCULARSTRING (1 0, 0 1, -1 0, 0 -1, 1 0))",
        "TRIANGLE Z ((0 0 7, 2 0 7, 0 2 7, 0 0 7))",
        "TIN (((-4 -4,-3 -4,-4 -3,-4 -4)),((0 0,2 0,0 2,0 0)))",
        "POLYHEDRALSURFACE (((-4 -4,-3 -4,-4 -3,-4 -4)),((0 0,2 0,0 2,0 0)))",
    ],
    ids=["curved-polygon", "triangle-z", "tin", "polyhedral-surface"],
)
@pytest.mark.parametrize("as_target", [True, False])
def test_native_geopackage_surfaces_keep_their_intersection_membership(
    tmp_path: Path, as_target: bool, wkt: str
) -> None:
    """Read a native polygonal surface as either an original target or a boundary.

    Args:
        tmp_path: Temporary directory for the two native GeoPackages.
        as_target: Compare the native surface against a linear boundary if true.
        wkt: Native surface with a part intersecting the first linear polygon.
    """
    surface = _write_native_geometry(tmp_path / "surface.gpkg", wkt)
    linear = _write_layer(
        tmp_path / "linear.gpkg",
        [
            (box(0.7, 0.6, 0.8, 0.7), "intersects the surface"),
            (box(2, 2, 3, 3), "outside"),
        ],
        geometry_type="Polygon",
    )
    target, boundary = (surface, linear) if as_target else (linear, surface)
    matches = match_features(target, {str(UUID(int=1)): boundary}, _spatial_rule())
    assert matches.ids == {1}


def test_measured_native_surface_keeps_only_spatial_coordinates(tmp_path: Path) -> None:
    """Keep the original elevation when converting measured vertices to GeoJSON."""
    from eolab_app.feature_intersection import iter_original_features

    surface = _write_native_geometry(
        tmp_path / "measured.gpkg",
        "TRIANGLE ZM ((0 0 7 10,2 0 8 20,0 2 9 30,0 0 7 10))",
    )
    [(_, _, polygon)] = list(iter_original_features(surface, None, None))
    assert list(polygon.exterior.coords) == [(0, 0, 7), (2, 0, 8), (0, 2, 9), (0, 0, 7)]


def test_mixed_collection_keeps_nested_surfaces_and_points(tmp_path: Path) -> None:
    """Select an original collection by either part, and exclude the empty gap."""
    collection = _write_native_geometry(
        tmp_path / "collection.gpkg",
        "GEOMETRYCOLLECTION (POINT (4 4), GEOMETRYCOLLECTION "
        "(TRIANGLE ((0 0,2 0,0 2,0 0))))",
    )
    for area, expected in [
        (box(0.7, 0.6, 0.8, 0.7), {1}),
        (box(3.9, 3.9, 4.1, 4.1), {1}),
        (box(2, 2, 3, 3), set()),
    ]:
        assert (
            match_features(collection, {}, VectorFilter(), required_area=area).ids
            == expected
        )


@pytest.mark.parametrize("as_target", [True, False])
def test_drawings_and_projected_source_share_one_comparison(tmp_path: Path, as_target: bool) -> None:
    """A saved WGS84 drawing around one degree east meets only the first metric polygon."""
    projected = _write_layer(tmp_path / "metric.gpkg", [
        (box(110_000, 0, 112_000, 1_000), "near"), (box(500_000, 0, 501_000, 1_000), "far"),
    ], crs="EPSG:3857")
    drawn = (SummaryPolygon.model_validate(mapping(box(0.95, -0.02, 1.05, 0.02))),)
    target, polygons = (drawn, projected) if as_target else (projected, drawn)
    assert match_features(target, {str(UUID(int=1)): polygons}, _spatial_rule()).ids == ({0} if as_target else {1})


@pytest.mark.parametrize(("match", "expected"), [("all", ["field and spatial"]), ("any", ["field and spatial", "spatial", "field", "field without geometry"])])
def test_mixed_filter_counts_and_pages_original_features(tmp_path: Path, match: str, expected: list[str]) -> None:
    """Count, display and page the same whole features for mixed field and spatial conditions.

    Args:
        tmp_path: Originals in the temporary GeoPackage directory.
        match: Boolean group chosen in the filter editor.
        expected: Matching original parcel labels in native order.
    """
    boundary = _write_layer(tmp_path / "bounds.gpkg", [(box(0, 0, 1, 1), "west"), (box(3, 3, 4, 4), "east")],
                            predicate=VectorFilter.model_validate({"rules": [{"field": "group", "operator": "eq", "value": "west"}]}))
    original = _write_layer(tmp_path / "targets.gpkg", [
        (box(-1, -1, 0, 0), "field and spatial"), (box(1, 1, 2, 2), "spatial"),
        (box(3, 3, 4, 4), "field"), (None, "field without geometry")], geometry_type="Polygon")
    view_id = str(UUID(int=42))
    predicate = VectorFilter.model_validate({"match": match, "rules": [
        {"operator": "intersects", "layerId": view_id, "source": boundary.selection},
        {"field": "group", "operator": "contains", "value": "field"},
    ]})
    target = replace(original, selection=original.selection.model_copy(update={"filter": predicate}))

    async def read_polygons(source: VectorSelection | DrawingSelection) -> ResolvedCatalogSelection:
        """Return the independently filtered original selected for this condition."""
        assert source == boundary.selection
        return boundary

    bound = asyncio.run(bind_intersections(target, read_polygons))
    assert count_selected_features(bound) == {"matched": len(expected), "total": 4}
    assert display_feature_ranges(bound, bound.matches.ids) == ("1" if match == "all" else "1:4")
    page = read_parcel_rows(bound, "group", ("group",), 0, 10)
    assert [row.properties["group"] for row in page.rows] == expected
    attributes = asyncio.run(read_feature_attributes(bound, tuple(sorted(bound.matches.ids))))
    assert [feature.properties["group"] for feature in attributes.features] == expected


def test_public_map_filter_requires_the_private_boundary(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Apply a filtered upload to a public catalog layer and reject another browser and later deletion.

    Args:
        tmp_path: Temporary catalog and private upload storage.
        monkeypatch: Configure the worker's own mounted originals.
    """
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import httpx2
    from eolab_app.routes.vector_sampling import create_vector_sampling_router
    from eolab_app.vector import selection_operation
    from eolab_app.routes.spatial_filters import create_spatial_filter_router
    from eolab_app.routes.vector_uploads import create_vector_uploads_router
    from eolab_app.vector.sampling import VectorSamplingService
    from eolab_app.vector.sources import MountedVectorResolver
    from eolab_app.vector_uploads import VectorUploadStore
    from tests.test_vector_filters import context
    from tests.test_vector_publication import StaticCatalog
    from tests.test_vector_uploads import BASE, HEADERS, write_layer

    _, registry, item, published, _ = context(tmp_path)
    uploads = VectorUploadStore(tmp_path / "uploads", None)
    app = FastAPI()
    monkeypatch.setattr(selection_operation, "SCAN_MOUNT", tmp_path)
    monkeypatch.setattr(selection_operation, "UPLOAD_MOUNT", uploads.root)
    completed = []

    async def run_job(token: str, execution_seconds: int) -> None:
        """Run the installed comparison with the deadline for the requested result.

        Args:
            token: Request-scoped credential for these source layers.
            execution_seconds: Hard deadline passed to the Jobs executor.
        """
        read = reader.spatial_reads.get(token)
        assert execution_seconds == (50 if read.lasso else 20)
        catalog = httpx2.MockTransport(lambda request: httpx2.Response(200, json=item))
        mounts = {"http://app:8000": httpx2.ASGITransport(app=app), "http://stac-api:8080": catalog}
        async with httpx2.AsyncClient(mounts=mounts, trust_env=False) as client:
            await selection_operation.deliver_intersection_result(
                client, selection_operation.ComparisonInput(spatialRead=token)
            )
        completed.append(token)

    async def read_drawing(owner: str, reference: Any) -> tuple[SummaryPolygon, ...]:
        """Return three committed drawing positions in their original order."""
        return tuple(SummaryPolygon.model_validate(mapping(box(x, 0, x + 0.001, 0.001))) for x in (0, 2, 3))

    reader = VectorSamplingService(StaticCatalog(item), MountedVectorResolver(tmp_path), uploads=uploads, comparison_executor=run_job, read_drawing=read_drawing)
    app.include_router(create_vector_sampling_router(reader))
    app.include_router(create_vector_uploads_router(uploads))
    app.include_router(create_spatial_filter_router(reader, registry, lambda request, response: "unused"))
    with TestClient(app, base_url="https://testserver") as owner, TestClient(app, base_url="https://testserver") as other:
        uploaded = owner.post(BASE, params={"name": "Private boundary"}, headers=HEADERS,
                              content=write_layer(tmp_path / "mask.gpkg"))
        assert uploaded.status_code == 201, uploaded.text
        identifier = uploaded.json()["id"]
        source = {"uploadId": identifier, "layerName": "areas", "filter": {"rules": [
            {"field": "count", "operator": "eq", "value": 7}]}}
        condition = {"operator": "intersects", "layerId": str(UUID(int=2)), "source": source}
        target = {"collectionId": item["collection"], "itemId": item["id"], "assetKey": registry.require_current(published.layer_name).source.asset_key,
                  "layerName": "categories", "filter": {"rules": [condition, condition]}}
        request = {"layerName": published.layer_name, "selection": target}
        url = "/api/vector-filters/map"
        scans = []
        from osgeo import ogr
        original_scan = ogr.Layer.__iter__

        def track_scan(dataset: ogr.Layer) -> Any:
            """Record each native feature scan performed while applying this map filter."""
            scans.append(dataset.GetName())
            return original_scan(dataset)

        monkeypatch.setattr(ogr.Layer, "__iter__", track_scan)
        result = owner.post(url, json=request, headers=HEADERS)
        assert result.status_code == 200, result.text
        assert result.json()["count"] == {"matched": 8, "total": 8, "complete": True}
        assert scans == ["areas", "categories"]
        assert len(completed) == 1
        assert registry.private_inputs(result.json()["layerName"]).uploads == {UUID(identifier)}
        assert owner.get("/api/vector-sampling/spatial-read", headers={"Authorization": f"Bearer {completed[-1]}"}).status_code == 404
        scans.clear()
        second = {**condition, "layerId": str(UUID(int=4)), "source": {**source, "filter": {"rules": [
            {"field": "count", "operator": "eq", "value": 9}]}}}
        both = {**request, "selection": {**target, "filter": {"match": "all", "rules": [condition, second]}}}
        assert owner.post(url, json=both, headers=HEADERS).json()["count"]["matched"] == 0
        assert scans == ["areas", "areas", "categories"]
        assert len(completed) == 2
        drawings = {"target": {"kind": "drawing", "polygonArea": {"id": "a" * 32, "sha256": "b" * 64}},
                    "properties": [{"name": "near"}, {"name": "keep"}, {"name": "far"}],
                    "filter": {"match": "any", "rules": [condition, condition, {"field": "name", "operator": "eq", "value": "keep"}]}}
        selected = owner.post("/api/vector-filters/drawings", headers=HEADERS, json=drawings)
        assert selected.status_code == 200, selected.text
        assert selected.json() == [0, 1]
        assert len(completed) == 3
        assert other.post(url, json=request, headers=HEADERS).status_code == 404
        nested = {"operator": "intersects", "layerId": str(UUID(int=3)), "source": {
            "kind": "drawing", "polygonArea": None, "filter": {"rules": [condition]}}}
        drawn = {**request, "selection": {**target, "filter": {"rules": [nested]}}}
        drawn_view = owner.post(url, json=drawn, headers=HEADERS)
        assert drawn_view.status_code == 200, drawn_view.text
        assert drawn_view.json()["count"]["matched"] == 0
        assert registry.private_inputs(drawn_view.json()["layerName"]).uploads == {UUID(identifier)}
        assert other.post(url, json=drawn, headers=HEADERS).status_code == 404
        source["filter"]["rules"][0]["value"] = 9
        empty = owner.post(url, json=request, headers=HEADERS)
        assert empty.status_code == 200, empty.text
        assert empty.json()["count"] == {"matched": 0, "total": 8, "complete": True}
        # A Lasso covering the layer must still use the empty private spatial filter.
        before_lasso = len(completed)
        lasso_url = "/api/vector-sampling/lasso"
        lasso_body = {"selection": target, "polygon": mapping(box(-1, -1, 1, 1))}
        lasso = owner.post(lasso_url, json=lasso_body, headers=HEADERS)
        assert lasso.status_code == 200, lasso.text
        assert lasso.json() == {
            "matched": 0,
            "featureIds": [],
            "features": [],
            "geometry": {"type": "FeatureCollection", "features": []},
        }
        assert len(completed) == before_lasso + 2  # One bound filter and one Lasso.
        assert (
            other.post(lasso_url, json=lasso_body, headers=HEADERS).status_code == 404
        )
        assert owner.delete(f"{BASE}/{identifier}", headers=HEADERS).status_code == 204
        assert owner.post(url, json=request, headers=HEADERS).status_code == 404
