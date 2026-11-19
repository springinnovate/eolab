"""Check which original features survive exact layer intersection."""

import asyncio
from dataclasses import replace
from pathlib import Path
from uuid import UUID

import fiona
import pytest
from shapely.geometry import LineString, Point, Polygon, box, mapping
from shapely.geometry.base import BaseGeometry

from eolab_app.attribute_filter import VectorFilter
from eolab_app.bounded_vector import count_selected_features, resolve_vector_file_selection
from eolab_app.catalog_selection import ResolvedCatalogSelection, UploadedSelection
from eolab_app.feature_intersection import bind_intersections, match_features
from eolab_app.feature_predicate import DrawingSelection, VectorSelection
from eolab_app.polygon_areas import SummaryPolygon
from eolab_app.vector.display_feature_ids import display_feature_ranges
from eolab_app.vector.parcels import read_parcel_rows


def _write_layer(
    path: Path, features: list[tuple[BaseGeometry | None, str]], crs: str = "EPSG:4326",
    predicate: VectorFilter | None = None, geometry_type: str = "Unknown",
) -> ResolvedCatalogSelection:
    """Create a real GeoPackage selection with original geometries and one field.

    Args:
        path: Temporary GeoPackage to write.
        features: Geometry and group value in native row order.
        crs: Coordinate system of the feature coordinates.
        predicate: Filter applied to the test view.
        geometry_type: Declared native layer geometry, including mixed test layers.

    Returns:
        Selection bound to its original GeoPackage and field schema.
    """
    with fiona.open(path, "w", driver="GPKG", layer="features", crs=crs,
                    schema={"geometry": geometry_type, "properties": {"group": "str"}}) as layer:
        for geometry, group in features:
            layer.write({"geometry": mapping(geometry) if geometry is not None else None,
                         "properties": {"group": group}})
    return resolve_vector_file_selection(path, UploadedSelection(
        uploadId=UUID(int=1), layerName="features", filter=predicate or VectorFilter(),
    ))


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

    async def run_job(token: str) -> None:
        """Run the installed worker read against the real application and the fixture catalog."""
        catalog = httpx2.MockTransport(lambda request: httpx2.Response(200, json=item))
        mounts = {"http://app:8000": httpx2.ASGITransport(app=app), "http://stac-api:8080": catalog}
        async with httpx2.AsyncClient(mounts=mounts, trust_env=False) as client:
            await selection_operation.return_intersecting_ids(client, selection_operation.ComparisonInput(spatialRead=token))
        completed.append(token)

    reader = VectorSamplingService(StaticCatalog(item), MountedVectorResolver(tmp_path), uploads=uploads, comparison_executor=run_job)
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
        original_filter = fiona.Collection.filter

        def track_scan(dataset, *args, **kwargs):
            """Record each native feature scan performed while applying this map filter."""
            scans.append(dataset.name)
            return original_filter(dataset, *args, **kwargs)

        monkeypatch.setattr(fiona.Collection, "filter", track_scan)
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
        assert owner.delete(f"{BASE}/{identifier}", headers=HEADERS).status_code == 204
        assert owner.post(url, json=request, headers=HEADERS).status_code == 404
