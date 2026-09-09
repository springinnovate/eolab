"""Verify complete filtered masks, bounded reads and retained AOI lifecycles."""

import asyncio
from datetime import datetime, timedelta, timezone

import fiona
import pytest
from shapely.geometry import shape

from eolab_app.bounded_geometry import GeometryValidationError
from eolab_app.sampling_area import SamplingAreaUnavailableError
from eolab_app.temporary_aoi.service import TemporaryAoiService
from eolab_app.vector.filters import VectorFilter
from eolab_app.vector.geometry import read_filtered_geometry
from eolab_app.vector.models import ResolvedVectorSource
from eolab_app.vector.sources import vector_source_signature
from eolab_app.catalog.vector import MOUNTED_VECTOR_COLLECTION_ID
from eolab_app.vector.filters import CatalogVectorFilterRequest
from eolab_app.vector.sampling import VectorSamplingService
from eolab_app.vector.errors import VectorConflictError


@pytest.fixture
def source(tmp_path):
    """Write two polygons, including a hole, in an exact named layer."""
    path = tmp_path / "countries.gpkg"
    with fiona.open(path, "w", driver="GPKG", layer="countries", crs="EPSG:4326",
                    schema={"geometry": "Polygon", "properties": {"iso3": "str"}}) as dataset:
        for iso3, rings in [
            ("PER", [[[0,0],[4,0],[4,4],[0,4],[0,0]], [[1,1],[1,2],[2,2],[2,1],[1,1]]]),
            ("BRA", [[[10,0],[14,0],[14,4],[10,4],[10,0]]]),
        ]:
            dataset.write({"geometry": {"type": "Polygon", "coordinates": rings}, "properties": {"iso3": iso3}})
    return ResolvedVectorSource("mounted", "geopackage", path, "data", "countries")


def filtered(code):
    """Build an exact typed country predicate."""
    return VectorFilter.model_validate({"rules": [{"field": "iso3", "operator": "eq", "value": code}]})


def test_complete_filtered_polygon_preserves_hole_and_discards_attributes(source):
    result = read_filtered_geometry(source, filtered("PER"), vector_source_signature(source))
    assert (result["matched"], result["total"]) == (1, 2)
    assert result["bbox"] == (0, 0, 4, 4)
    feature = result["geometry"]["features"][0]
    assert feature["properties"] == {}
    assert shape(feature["geometry"]).area == 15


def test_zero_matches_never_falls_back_to_unfiltered_geometry(source):
    with pytest.raises(GeometryValidationError, match="No matching"):
        read_filtered_geometry(source, filtered("XXX"), vector_source_signature(source))


def test_entire_layer_requires_complete_bounded_read(source, monkeypatch):
    monkeypatch.setattr("eolab_app.vector.geometry.MAX_SCANNED_FEATURES", 1)
    with pytest.raises(GeometryValidationError, match="scan budget"):
        read_filtered_geometry(source, filtered("PER"), vector_source_signature(source))


def test_source_identity_must_match_before_read(source):
    with pytest.raises(Exception, match="source changed"):
        read_filtered_geometry(source, filtered("PER"), ())


def test_retained_geometry_uses_existing_expiry_and_delete(source, tmp_path):
    async def scenario():
        now = datetime.now(timezone.utc)
        service = TemporaryAoiService(tmp_path / "areas", now=lambda: now)
        result = read_filtered_geometry(source, filtered("PER"), vector_source_signature(source))
        try:
            first = await service.retain_geometry(result["geometry"], result["bbox"], "Peru")
            second = await service.retain_geometry(result["geometry"], result["bbox"], "Peru")
            assert first.identity.reference != second.identity.reference
            result["geometry"]["features"].clear()
            assert len((await service.resolve_for_sampling(first.identity.reference)).geometries) == 1
            await service.remove(first.identity.reference)
            with pytest.raises(SamplingAreaUnavailableError):
                await service.resolve_for_sampling(first.identity.reference)
            now += timedelta(hours=1)
            with pytest.raises(SamplingAreaUnavailableError):
                await service.resolve_for_sampling(second.identity.reference)
        finally:
            await service.close()
    asyncio.run(scenario())


def test_workflow_uses_catalog_fields_without_publication_and_retains_complete_geometry(source, tmp_path):
    """Run the actual supervised child and AOI lifecycle without GeoServer state."""
    class Catalog:
        async def get_item(self, request):
            return {"id": request.item_id, "properties": {"table:columns": [{"name": "iso3", "type": "str"}]}}
    class Resolver:
        def resolve(self, item):
            return source
    async def scenario():
        lifecycle = TemporaryAoiService(tmp_path / "retained")
        service = VectorSamplingService(Catalog(), Resolver(), lifecycle.retain_geometry)
        request = CatalogVectorFilterRequest(collectionId=MOUNTED_VECTOR_COLLECTION_ID, itemId="countries", filter=filtered("PER"))
        try:
            result = await service.select(request)
            assert result["matched"] == 1 and result["total"] == 2
            assert result["filter"] == request.filter.model_dump(mode="json")
            assert len((await lifecycle.resolve_for_sampling(result["id"])).geometries) == 1
            invalid = request.model_copy(update={"filter": VectorFilter(rules=[{"field": "unknown", "operator": "eq", "value": 1}])})
            with pytest.raises(VectorConflictError, match="not in this layer"):
                await service.select(invalid)
        finally:
            await lifecycle.close()
    asyncio.run(scenario())
