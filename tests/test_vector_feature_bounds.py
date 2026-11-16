"""Keep selected-feature bounds on the authorized, bounded inspection path."""

import asyncio
from base64 import urlsafe_b64decode
import json
from pathlib import Path
from urllib.parse import parse_qsl

import httpx2
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eolab_app.diagnostics.tracker import GetMapRequestTracker
from eolab_app.rendering.render_queue import GeoServerRenderQueue
from eolab_app.rendering.errors import PublishedLayerRequestError
from eolab_app.raster.wms_authorization import PublishedRasterAuthorization
from eolab_app.routes.wms_proxy import create_wms_proxy_router
from eolab_app.vector.filters import VectorFilter
from eolab_app.vector.models import ResolvedVectorSource
from eolab_app.vector.sources import PublishedVectorRegistry


@pytest.mark.parametrize("filtered", [False, True])
@pytest.mark.parametrize("properties", [None, "name"])
def test_inspection_retains_feature_bounds_and_requested_attributes(
    tmp_path: Path, filtered: bool, properties: str | None
) -> None:
    """Use original-layer envelopes without changing public field or filter choices.

    Args:
        tmp_path: Isolated source identity; native I/O is supplied by the transport.
        filtered: Whether the visible publication has an accepted attribute filter.
        properties: Optional public request for a subset of scalar attributes.
    """
    source = ResolvedVectorSource(
        "mounted", "geopackage", tmp_path / "source.gpkg", "data", "parcels"
    )
    registry = PublishedVectorRegistry()
    registry.authorize(
        "eolab:parcels",
        source,
        "vector-polygon",
        inspection_layer_name="eolab:parcels_original",
    )
    layer = "eolab:parcels"
    if filtered:
        layer = registry.authorize_filter(
            layer,
            VectorFilter(
                enabled=True,
                rules=[{"field": "name", "operator": "eq", "value": "Habitat"}],
            ),
        )
    captured: list[dict[str, str]] = []
    bounds = [-84.0, 8.0, -79.0, 12.0]

    def upstream(request: httpx2.Request) -> httpx2.Response:
        """Record the native query and supply one geometry-free selected feature.

        Args:
            request: Authorized original-layer request from the actual WMS route.

        Returns:
            The native writer's bounded geographic-envelope response shape.
        """
        captured.append(
            dict(parse_qsl(request.content.decode()))
            if request.content
            else dict(request.url.params)
        )
        return httpx2.Response(
            200,
            json={
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "id": "parcels.7",
                        "geometry": None,
                        "bbox": bounds,
                        "properties": (
                            {"name": "Habitat"}
                            if properties
                            else {"name": "Habitat", "rank": 2}
                        ),
                    }
                ],
            },
        )

    client = httpx2.AsyncClient(transport=httpx2.MockTransport(upstream))
    app = FastAPI()
    app.include_router(
        create_wms_proxy_router(
            client,
            "http://geoserver/geoserver",
            (registry,),
            GetMapRequestTracker(2),
            GeoServerRenderQueue(2),
        )
    )
    query = {
        "service": "WMS",
        "version": "1.1.1",
        "request": "GetFeatureInfo",
        "layers": layer,
        "query_layers": layer,
        "styles": "vector-polygon",
        "srs": "EPSG:3857",
        "bbox": "-10000000,0,0,10000000",
        "width": "800",
        "height": "600",
        "format": "image/png",
        "info_format": "application/json",
        "vector_feature_bounds": "true",
        "x": "128",
        "y": "128",
        "feature_count": "5",
        "buffer": "8",
    }
    if properties is not None:
        query["propertyName"] = properties
    with TestClient(app) as browser:
        response = browser.post("/geoserver/eolab/wms", data=query)
        assert response.status_code == 200
        feature = response.json()["features"][0]
        assert feature["id"] == "parcels.7"
        assert feature["bbox"] == bounds
        assert feature["geometry"] is None
        assert feature["properties"] == (
            {"name": "Habitat"} if properties else {"name": "Habitat", "rank": 2}
        )
        assert captured[0]["info_format"] == "application/vnd.eolab.feature-info+json"
        assert (
            captured[0]["layers"]
            == captured[0]["query_layers"]
            == "eolab:parcels_original"
        )
        assert "propertyname" not in {name.lower() for name in captured[0]}
        assert "vector_feature_bounds" not in captured[0]
        if properties is None:
            assert "format_options" not in captured[0]
        else:
            option, encoded = captured[0]["format_options"].split(":")
            assert option == "eolabProperties"
            assert json.loads(urlsafe_b64decode(encoded)) == ["name"]
        assert captured[0]["feature_count"] == "5"
        assert captured[0]["buffer"] == "8"
        assert ("cql_filter" in captured[0]) == filtered
        assert response.headers["x-content-type-options"] == "nosniff"
        untrusted = {**query, "info_format": "application/vnd.eolab.feature-info+json"}
        assert browser.post("/geoserver/eolab/wms", data=untrusted).status_code == 400
        invalid_flag = {**query, "vector_feature_bounds": "false"}
        assert (
            browser.post("/geoserver/eolab/wms", data=invalid_flag).status_code == 400
        )
        custom_options = {**query, "format_options": "eolabProperties:anything"}
        assert (
            browser.post("/geoserver/eolab/wms", data=custom_options).status_code == 400
        )
        assert len(captured) == 1
    asyncio.run(client.aclose())


def test_attribute_only_inspection_keeps_native_projection(tmp_path: Path) -> None:
    """Preserve hover's one-field projection without requesting feature geometry.

    Args:
        tmp_path: Isolated source identity, with no filesystem read.
    """
    source = ResolvedVectorSource(
        "mounted", "geopackage", tmp_path / "source.gpkg", "data", "parcels"
    )
    registry = PublishedVectorRegistry()
    registry.authorize("eolab:parcels", source, "vector-polygon")
    query = {
        "layers": "eolab:parcels",
        "query_layers": "eolab:parcels",
        "styles": "vector-polygon",
        "info_format": "application/json",
        "propertyName": "name",
    }
    assert (
        dict(
            registry.require_current("eolab:parcels").prepare_query(
                "getfeatureinfo", list(query.items())
            )
        )
        == query
    )


def test_raster_inspection_rejects_vector_bounds() -> None:
    """Keep the new optional vector request out of raster WMS behavior."""
    with pytest.raises(PublishedLayerRequestError, match="only for vector"):
        PublishedRasterAuthorization().validate_parameters(
            "getfeatureinfo", {"vector_feature_bounds": "true"}
        )
