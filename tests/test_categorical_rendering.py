"""Exercise categorical appearances through real authorization/HTTP boundaries."""

import json
from urllib.parse import parse_qs
from xml.etree import ElementTree

import httpx2
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eolab_app.diagnostics.tracker import GetMapRequestTracker
from eolab_app.raster.wms_authorization import PublishedRasterAuthorization
from eolab_app.rendering.composite import CompositeMapRenderingService
from eolab_app.rendering.errors import (
    PublishedLayerNotAuthorizedError,
    PublishedLayerRequestError,
)
from eolab_app.rendering.render_queue import GeoServerRenderQueue
from eolab_app.rendering.sld import SLD_NAMESPACE
from eolab_app.routes.composite_map import create_composite_map_router
from eolab_app.routes.wms_proxy import create_wms_proxy_router
from eolab_app.vector.models import VectorStyle
from eolab_app.vector.styles import default_vector_style, vector_style_name
from eolab_app.vector.wms_authorization import PublishedVectorAuthorization


def category_style(color: str = "#228b22") -> dict[str, object]:
    """Build one valid appearance with a display-only expression-like label.

    Args:
        color: Exact color of category 41.

    Returns:
        JSON style suitable for either rendering boundary.
    """
    return {
        "mode": "categorical",
        "categories": [
            {
                "value": 41,
                "label": "Forest ${env('secret')}",
                "color": color,
                "opacity": 0.5,
            }
        ],
        "unmapped": {"color": "#808080", "opacity": 0.25},
    }


def vector_style() -> VectorStyle:
    """Return a polygon appearance whose fill differs from GeoServer's default.

    Returns:
        A validated custom vector appearance for the mixed-layer request.
    """
    return default_vector_style("polygon").model_copy(update={"fill_color": "#db2777"})


class RenderingRegistry:
    """Expose two published rasters and one styled vector without source I/O."""

    def require_current(
        self,
        layer_name: str,
    ) -> PublishedRasterAuthorization | PublishedVectorAuthorization:
        """Resolve one approved fixture identity.

        Args:
            layer_name: Requested published layer identity.

        Returns:
            The real raster- or vector-owned authorization contract.

        Raises:
            PublishedLayerNotAuthorizedError: If the requested layer is unknown.
        """
        if layer_name == "eolab:boundaries":
            return PublishedVectorAuthorization(
                source=object(),  # type: ignore[arg-type]
                styles={vector_style_name("boundaries", vector_style()): None},
            )
        if layer_name not in {"eolab:landcover", "eolab:continuous"}:
            raise PublishedLayerNotAuthorizedError("Layer is not published")
        return PublishedRasterAuthorization()


@pytest.fixture
def rendering_client() -> tuple[TestClient, list[httpx2.Request]]:
    """Compose real direct/composite routes around a capturing GeoServer boundary.

    Returns:
        HTTP client and captured upstream requests.
    """
    requests: list[httpx2.Request] = []

    def respond(request: httpx2.Request) -> httpx2.Response:
        """Capture an authorized native request and return a cacheable image.

        Args:
            request: Prepared upstream request.

        Returns:
            A controlled PNG response.
        """
        requests.append(request)
        return httpx2.Response(
            200, content=b"PNG", headers={"content-type": "image/png"}
        )

    upstream = httpx2.AsyncClient(transport=httpx2.MockTransport(respond))
    queue = GeoServerRenderQueue(2)
    tracker = GetMapRequestTracker(4)
    registries = (RenderingRegistry(),)
    app = FastAPI()
    app.include_router(
        create_wms_proxy_router(
            upstream, "http://geoserver/geoserver", registries, tracker, queue
        )
    )
    app.include_router(
        create_composite_map_router(
            CompositeMapRenderingService(registries),
            upstream,
            "http://geoserver/geoserver",
            tracker,
            queue,
        )
    )
    return TestClient(app), requests


def tile_query(layer: str = "eolab:landcover") -> dict[str, str]:
    """Return a transparent bounded WMS request for one layer.

    Args:
        layer: Authorized layer or composite transport sentinel.

    Returns:
        WMS 1.1.1 query fields.
    """
    return {
        "service": "WMS",
        "request": "GetMap",
        "version": "1.1.1",
        "layers": layer,
        "styles": "",
        "srs": "EPSG:3857",
        "bbox": "0,0,256,256",
        "width": "256",
        "height": "256",
        "format": "image/png",
        "transparent": "true",
    }


def test_direct_style_becomes_trusted_body_and_disables_shared_native_tiles(
    rendering_client: tuple[TestClient, list[httpx2.Request]],
) -> None:
    """Keep generated expressions, source identity and nearest policy server-owned.

    Args:
        rendering_client: Real routes with a capturing upstream boundary.
    """
    client, requests = rendering_client
    query = tile_query() | {
        "raster_style": json.dumps(category_style()),
        "tiled": "true",
        "tilesorigin": "0,0",
    }
    assert client.get("/geoserver/eolab/wms", params=query).status_code == 200
    request = requests[0]
    form = parse_qs(request.content.decode(), keep_blank_values=True)
    assert request.method == "POST"
    assert "application/x-www-form-urlencoded" in request.headers["content-type"]
    assert not {"raster_style", "tiled", "tilesorigin"} & form.keys()
    assert form["interpolations"] == ["nearest neighbor"]
    assert form["styles"] == [""]
    assert "Forest" not in form["sld_body"][0]
    assert "env('secret')" not in form["sld_body"][0]
    root = ElementTree.fromstring(form["sld_body"][0])
    assert (
        root.findtext(f".//{{{SLD_NAMESPACE}}}NamedLayer/{{{SLD_NAMESPACE}}}Name")
        == "eolab:landcover"
    )


@pytest.mark.parametrize(
    "bad",
    ["{}", "[]", "not JSON", '{"mode":"categorical","mode":"categorical"}'],
    ids=["empty", "array", "invalid", "duplicate"],
)
def test_bad_direct_definitions_never_reach_geoserver(
    rendering_client: tuple[TestClient, list[httpx2.Request]], bad: str
) -> None:
    """Reject malformed and duplicate-field style requests locally.

    Args:
        rendering_client: Real routes with a capturing upstream boundary.
        bad: Invalid categorical JSON.
    """
    client, requests = rendering_client
    response = client.get(
        "/geoserver/eolab/wms", params=tile_query() | {"raster_style": bad}
    )
    assert response.status_code == 400
    assert requests == []


def test_categorical_input_cannot_replace_layer_authority_or_supply_sld(
    rendering_client: tuple[TestClient, list[httpx2.Request]],
) -> None:
    """Keep categorical parameters confined to authorized GetMap requests.

    Args:
        rendering_client: Real routes with a capturing upstream boundary.
    """
    client, requests = rendering_client
    style = json.dumps(category_style())
    for query in (
        tile_query("eolab:unknown") | {"raster_style": style},
        tile_query() | {"raster_style": style, "env": "min:0"},
        tile_query() | {"sld_body": "arbitrary XML"},
        tile_query()
        | {
            "raster_style": style,
            "request": "GetLegendGraphic",
            "layer": "eolab:landcover",
        },
    ):
        assert client.get("/geoserver/eolab/wms", params=query).status_code == 400
    assert requests == []
    vector = PublishedVectorAuthorization(source=object(), styles={"vector-polygon": None})  # type: ignore[arg-type]
    with pytest.raises(PublishedLayerRequestError, match="not supported for vector"):
        vector.validate_parameters("getmap", {"raster_style": style})


def test_composite_category_isolated_by_plan_and_matches_direct_sld(
    rendering_client: tuple[TestClient, list[httpx2.Request]],
) -> None:
    """Use the same categorical renderer while retaining distinct map appearances.

    Args:
        rendering_client: Real routes with a capturing upstream boundary.
    """
    client, requests = rendering_client
    plans = []
    for color in ("#228b22", "#ff0000"):
        response = client.post(
            "/api/map-rendering/plans",
            json={
                "layers": [
                    {
                        "layerName": "eolab:landcover",
                        "styleName": "dynamic-raster",
                        "styleDefinition": category_style(color),
                        "opacity": 1,
                    }
                ]
            },
        )
        assert response.status_code == 200
        plans.append(response.json())
    assert plans[0]["planId"] != plans[1]["planId"]
    for plan in plans:
        assert (
            client.get(plan["wmsUrl"], params=tile_query("composite")).status_code
            == 200
        )
    assert len(requests) == 2
    assert (
        client.get(plans[0]["wmsUrl"], params=tile_query("composite")).status_code
        == 200
    )
    assert len(requests) == 2
    assert (
        client.get(
            "/geoserver/eolab/wms",
            params=tile_query() | {"raster_style": json.dumps(category_style())},
        ).status_code
        == 200
    )
    forms = [
        parse_qs(request.content.decode(), keep_blank_values=True)
        for request in requests
    ]
    # Composite requests explicitly select inline defaults; the rendering definition stays identical.
    definitions = [
        ElementTree.tostring(
            ElementTree.fromstring(form["sld_body"][0]).find(
                f".//{{{SLD_NAMESPACE}}}FeatureTypeStyle"
            )
        )
        for form in forms
    ]
    assert definitions[0] == definitions[2]
    assert definitions[0] != definitions[1]
    assert all(form["interpolations"] == ["nearest neighbor"] for form in forms)


def test_mixed_composite_preserves_default_resampling_and_layer_order(
    rendering_client: tuple[TestClient, list[httpx2.Request]],
) -> None:
    """Select each inline style and override only categorical resampling in drawing order.

    Args:
        rendering_client: Real routes with a capturing upstream boundary.
    """
    client, requests = rendering_client
    polygon = vector_style()
    response = client.post(
        "/api/map-rendering/plans",
        json={
            "layers": [
                {
                    "layerName": "eolab:boundaries",
                    "styleName": vector_style_name("boundaries", polygon),
                    "styleDefinition": polygon.model_dump(by_alias=True),
                    "opacity": 1,
                },
                {
                    "layerName": "eolab:landcover",
                    "styleName": "dynamic-raster",
                    "styleDefinition": category_style(),
                    "opacity": 0.4,
                },
                {
                    "layerName": "eolab:continuous",
                    "styleName": "dynamic-raster",
                    "styleEnvironment": "min:0;med:5;max:10;cmin:#000000;cmed:#888888;cmax:#ffffff",
                    "opacity": 1,
                },
            ]
        },
    )
    assert response.status_code == 200
    assert (
        client.get(
            response.json()["wmsUrl"], params=tile_query("composite")
        ).status_code
        == 200
    )
    form = parse_qs(requests[0].content.decode(), keep_blank_values=True)
    assert form["layers"] == ["eolab:continuous,eolab:landcover,eolab:boundaries"]
    assert form["interpolations"] == [",nearest neighbor,"]
    root = ElementTree.fromstring(form["sld_body"][0])
    layers = root.findall(f"{{{SLD_NAMESPACE}}}NamedLayer")
    assert [layer.findtext(f"{{{SLD_NAMESPACE}}}Name") for layer in layers] == [
        "eolab:continuous",
        "eolab:landcover",
        "eolab:boundaries",
    ]
    assert [
        layer.findtext(f"{{{SLD_NAMESPACE}}}UserStyle/{{{SLD_NAMESPACE}}}IsDefault")
        for layer in layers
    ] == ["1", "1", "1"]
    assert (
        layers[-1].findtext(f".//{{{SLD_NAMESPACE}}}CssParameter[@name='fill']")
        == polygon.fill_color
    )
    assert [
        float(node.text) for node in root.findall(f".//{{{SLD_NAMESPACE}}}Opacity")
    ] == [1, 0.4]


def test_plan_payload_limit_precedes_retention(
    rendering_client: tuple[TestClient, list[httpx2.Request]],
) -> None:
    """Reject a large structured plan even when its layer count is small.

    Args:
        rendering_client: Real routes with a capturing upstream boundary.
    """
    client, requests = rendering_client
    response = client.post(
        "/api/map-rendering/plans",
        json={
            "layers": [
                {
                    "layerName": "eolab:landcover",
                    "styleName": "dynamic-raster",
                    "opacity": 1,
                    "styleDefinition": {"oversized": "x" * (512 * 1024)},
                }
            ]
        },
    )
    assert response.status_code == 422
    assert requests == []
