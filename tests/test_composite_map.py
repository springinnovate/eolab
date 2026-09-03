"""Test bounded GeoServer-composed map plan and tile delivery."""

from collections.abc import Mapping
from pathlib import Path
from xml.etree import ElementTree

import httpx2
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eolab_app.diagnostics.tracker import GetMapRequestTracker
from eolab_app.raster.source_identity import RasterSourceIdentity
from eolab_app.raster.wms_authorization import PublishedRasterAuthorization
from eolab_app.rendering.composite import CompositeMapRenderingService
from eolab_app.rendering.errors import PublishedLayerNotAuthorizedError
from eolab_app.rendering.sld import SLD_NAMESPACE
from eolab_app.routes.composite_map import create_composite_map_router
from eolab_app.vector.styles import default_vector_style
from eolab_app.vector.wms_authorization import PublishedVectorAuthorization


class _TestAuthorization:
    """Authorize one fixed test style and emit its requested layer identity."""

    style_name = "test-style"

    def validate_parameters(
        self,
        operation: str,
        query: Mapping[str, str],
    ) -> None:
        """Accept the unused ordinary WMS contract.

        Args:
            operation: Unused normalized WMS operation.
            query: Unused normalized query.
        """
        del operation, query

    def build_composite_sld(
        self,
        layer_name: str,
        style_name: str,
        style_environment: str | None,
        style_definition: Mapping[str, object] | None,
        opacity: float,
    ) -> bytes:
        """Build one inspectable single-layer SLD.

        Args:
            layer_name: Requested published layer.
            style_name: Requested fixed style.
            style_environment: Unused raster representation.
            style_definition: Required test representation.
            opacity: Neutral layer opacity.

        Returns:
            Complete one-layer SLD containing the opacity as its title.
        """
        del style_name, style_environment, style_definition
        root = ElementTree.Element(
            f"{{{SLD_NAMESPACE}}}StyledLayerDescriptor",
            {"version": "1.0.0"},
        )
        named_layer = ElementTree.SubElement(
            root,
            f"{{{SLD_NAMESPACE}}}NamedLayer",
        )
        ElementTree.SubElement(
            named_layer,
            f"{{{SLD_NAMESPACE}}}Name",
        ).text = layer_name
        ElementTree.SubElement(
            named_layer,
            f"{{{SLD_NAMESPACE}}}Title",
        ).text = str(opacity)
        return ElementTree.tostring(root, encoding="utf-8")


class _TestRegistry:
    """Authorize test layers through one shared policy."""

    def require_current(self, layer_name: str) -> _TestAuthorization:
        """Authorize only names in the test workspace.

        Args:
            layer_name: Candidate workspace-qualified layer.

        Returns:
            Fixed test authorization.

        Raises:
            PublishedLayerNotAuthorizedError: If the layer is not a test layer.
        """
        if not layer_name.startswith("eolab:test-"):
            raise PublishedLayerNotAuthorizedError("not a test layer")
        return _TestAuthorization()


def _plan_layer(layer_name: str, opacity: float) -> dict[str, object]:
    """Build one public test layer request.

    Args:
        layer_name: Workspace-qualified test identity.
        opacity: Neutral layer opacity.

    Returns:
        JSON-compatible generic vector-style plan entry.
    """
    return {
        "layerName": layer_name,
        "styleName": "test-style",
        "styleDefinition": {"test": True},
        "opacity": opacity,
    }


def test_composite_map_posts_one_bottom_first_get_map_document() -> None:
    """Render a top-first browser plan as one bottom-first GeoServer request."""
    forwarded_requests: list[httpx2.Request] = []

    def geoserver_response(request: httpx2.Request) -> httpx2.Response:
        """Capture one internal GeoServer POST and return a PNG.

        Args:
            request: Internal WMS request.

        Returns:
            Controlled transparent PNG response.
        """
        forwarded_requests.append(request)
        return httpx2.Response(
            200,
            content=b"composite png",
            headers={"Content-Type": "image/png", "Cache-Control": "max-age=30"},
        )

    tracker = GetMapRequestTracker(4)
    application = FastAPI()
    application.include_router(create_composite_map_router(
        CompositeMapRenderingService((_TestRegistry(),)),
        httpx2.AsyncClient(transport=httpx2.MockTransport(geoserver_response)),
        "http://geoserver:8080/geoserver",
        tracker,
    ))
    client = TestClient(application)
    plan_response = client.post("/api/map-rendering/plans", json={
        "layers": [
            _plan_layer("eolab:test-top", 0.75),
            _plan_layer("eolab:test-bottom", 0.25),
        ]
    })

    assert plan_response.status_code == 200
    plan = plan_response.json()
    tile_response = client.get(
        f"{plan['wmsUrl']}?service=WMS&version=1.1.1&request=GetMap"
        "&layers=composite&styles=&srs=EPSG%3A3857"
        "&bbox=0%2C0%2C256%2C256&width=256&height=256"
        "&format=image%2Fpng&transparent=true"
    )

    assert tile_response.status_code == 200
    assert tile_response.content == b"composite png"
    assert tile_response.headers["cache-control"] == "max-age=30"
    assert len(forwarded_requests) == 1
    assert forwarded_requests[0].method == "POST"
    request_root = ElementTree.fromstring(forwarded_requests[0].content)
    layer_names = [
        element.text
        for element in request_root.findall(
            f".//{{{SLD_NAMESPACE}}}NamedLayer/{{{SLD_NAMESPACE}}}Name"
        )
    ]
    assert layer_names == ["eolab:test-bottom", "eolab:test-top"]
    assert request_root.findtext(".//Width") == "256"
    assert request_root.findtext(".//Transparent") == "true"
    assert tracker.snapshot().completed == 1


def test_composite_map_rejects_unapproved_layers_before_rendering() -> None:
    """Do not create a plan for an arbitrary GeoServer layer name."""
    application = FastAPI()
    application.include_router(create_composite_map_router(
        CompositeMapRenderingService((_TestRegistry(),)),
        httpx2.AsyncClient(transport=httpx2.MockTransport(
            lambda request: httpx2.Response(500)
        )),
        "http://geoserver:8080/geoserver",
        GetMapRequestTracker(1),
    ))
    response = TestClient(application).post(
        "/api/map-rendering/plans",
        json={"layers": [_plan_layer("eolab:arbitrary", 1)]},
    )

    assert response.status_code == 400
    assert "approved" in response.json()["detail"]


def test_raster_composite_sld_preserves_stop_and_layer_opacity() -> None:
    """Apply neutral opacity outside the raster's three stop opacities."""
    authorization = PublishedRasterAuthorization(
        Path("prepared.tif"),
        RasterSourceIdentity(1, 2, 3, 4),
    )
    document = authorization.build_composite_sld(
        "eolab:prepared",
        "dynamic-raster",
        (
            "min:0;med:5;max:10;cmin:#000000;cmed:#888888;cmax:#ffffff;"
            "amin:0.1;amed:0.5;amax:0.9"
        ),
        None,
        0.4,
    )
    root = ElementTree.fromstring(document)

    assert root.findtext(f".//{{{SLD_NAMESPACE}}}Opacity") == "0.4"
    entries = root.findall(f".//{{{SLD_NAMESPACE}}}ColorMapEntry")
    assert [entry.attrib["opacity"] for entry in entries] == ["0.1", "0.5", "0.9"]


def test_vector_composite_sld_multiplies_symbol_opacity() -> None:
    """Apply neutral opacity without changing the authorized vector style."""
    style = default_vector_style("polygon")
    authorization = PublishedVectorAuthorization(
        source=object(),  # type: ignore[arg-type]
        source_signature=(),
        style_name="vector-polygon",
    )
    document = authorization.build_composite_sld(
        "eolab:polygon-item",
        "vector-polygon",
        None,
        style.model_dump(by_alias=True),
        0.5,
    )
    root = ElementTree.fromstring(document)
    css_parameters = {
        parameter.attrib["name"]: parameter.text
        for parameter in root.findall(f".//{{{SLD_NAMESPACE}}}CssParameter")
    }

    assert css_parameters["fill-opacity"] == "0.5"
    assert css_parameters["stroke-opacity"] == "0"
