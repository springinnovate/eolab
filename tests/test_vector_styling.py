"""Test validated vector styles, authoritative workflow, and GeoServer SLDs."""

import asyncio
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

import httpx2
import pytest
from pydantic import ValidationError

from eolab_app.rendering.geoserver import GEOSERVER_WORKSPACE_NAME
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.geoserver import GeoServerVectorPublisher
from eolab_app.vector.models import (
    CatalogVectorStyleRequest,
    VectorSingleSymbolStyle,
)
from eolab_app.vector.sources import (
    MountedVectorResolver,
    PublishedVectorRegistry,
    vector_source_signature,
)
from eolab_app.vector.styles import (
    SLD_NAMESPACE,
    build_vector_sld,
    default_vector_style,
    vector_style_name,
)
from eolab_app.vector.styling import VectorStyleService
from tests.test_vector_publication import StaticCatalog, assessed_geopackage_item


class RecordingStyler:
    """Record server-derived resource identities and validated styles."""

    def __init__(self) -> None:
        """Create an empty style request log."""
        self.requests: list[tuple[str, VectorSingleSymbolStyle]] = []

    async def apply_style(
        self,
        resource_name: str,
        style: VectorSingleSymbolStyle,
    ) -> str:
        """Record one style request and return its deterministic name.

        Args:
            resource_name: Server-derived layer resource name.
            style: Validated vector style.

        Returns:
            Deterministic per-layer style name.
        """
        self.requests.append((resource_name, style))
        return vector_style_name(resource_name)


def polygon_request(
    item: dict[str, Any],
    geometry_kind: str = "polygon",
) -> CatalogVectorStyleRequest:
    """Build one style request for an assessed Item.

    Args:
        item: Authoritative catalog Item.
        geometry_kind: Requested geometry class.

    Returns:
        Validated style request.
    """
    style: dict[str, Any] = {
        "geometryKind": geometry_kind,
        "strokeColor": "#112233",
        "strokeOpacity": 0.8,
        "strokeWidth": 2.5,
    }
    if geometry_kind != "line":
        style.update(fillColor="#abcdef", fillOpacity=0.45)
    if geometry_kind == "point":
        style["pointSize"] = 11
    return CatalogVectorStyleRequest(
        collectionId=item["collection"],
        itemId=item["id"],
        style=style,
    )


def test_style_model_requires_geometry_specific_controls() -> None:
    """Normalize colors and reject controls belonging to another geometry."""
    line = VectorSingleSymbolStyle(
        geometryKind="line",
        strokeColor="#F97316",
        strokeOpacity=1,
        strokeWidth=3,
    )

    assert line.stroke_color == "#f97316"
    with pytest.raises(ValidationError):
        VectorSingleSymbolStyle(
            geometryKind="line",
            fillColor="#ffffff",
            fillOpacity=1,
            strokeColor="#000000",
            strokeOpacity=1,
            strokeWidth=2,
        )
    with pytest.raises(ValidationError):
        VectorSingleSymbolStyle(
            geometryKind="point",
            fillColor="#ffffff",
            fillOpacity=1,
            strokeColor="#000000",
            strokeOpacity=1,
            strokeWidth=2,
        )


@pytest.mark.parametrize(
    ("geometry_kind", "symbolizer"),
    [
        ("point", "PointSymbolizer"),
        ("line", "LineSymbolizer"),
        ("polygon", "PolygonSymbolizer"),
    ],
)
def test_sld_generation_uses_only_the_geometry_symbolizer(
    geometry_kind: str,
    symbolizer: str,
) -> None:
    """Serialize complete safe geometry-specific SLD parameters.

    Args:
        geometry_kind: Default style geometry.
        symbolizer: Expected SLD symbolizer element.
    """
    style_name = "vector-single-0123456789abcdef01234567"
    root = ElementTree.fromstring(
        build_vector_sld(style_name, default_vector_style(geometry_kind))
    )
    namespace = {"sld": SLD_NAMESPACE}

    assert root.find(f".//sld:{symbolizer}", namespace) is not None
    assert sum(
        root.find(f".//sld:{candidate}", namespace) is not None
        for candidate in (
            "PointSymbolizer",
            "LineSymbolizer",
            "PolygonSymbolizer",
        )
    ) == 1
    parameter_names = {
        parameter.attrib["name"]
        for parameter in root.findall(".//sld:CssParameter", namespace)
    }
    assert {"stroke", "stroke-opacity", "stroke-width"} <= parameter_names
    assert ("fill" in parameter_names) is (geometry_kind != "line")


def test_style_service_uses_catalog_identity_and_current_publication(
    tmp_path: Path,
) -> None:
    """Apply only through authoritative source and registry identities.

    Args:
        tmp_path: Isolated mounted scan source.
    """
    item, _ = assessed_geopackage_item(tmp_path)
    resolver = MountedVectorResolver(tmp_path)
    source = resolver.resolve(item)
    signature = vector_source_signature(source)
    registry = PublishedVectorRegistry()
    registry.authorize(
        f"{GEOSERVER_WORKSPACE_NAME}:{item['id']}",
        source,
        signature,
        "vector-polygon",
    )
    styler = RecordingStyler()
    service = VectorStyleService(
        StaticCatalog(item),
        resolver,
        styler,
        registry,
    )
    request = polygon_request(item)

    result = asyncio.run(service.apply(request))

    assert styler.requests == [(item["id"], request.style)]
    assert result.style == request.style
    authorization = registry.require_current(
        f"{GEOSERVER_WORKSPACE_NAME}:{item['id']}"
    )
    assert authorization.style_name == vector_style_name(item["id"])


def test_style_service_rejects_unpublished_or_wrong_geometry(
    tmp_path: Path,
) -> None:
    """Reject missing authorization and client geometry disagreements.

    Args:
        tmp_path: Isolated mounted scan source.
    """
    item, _ = assessed_geopackage_item(tmp_path)
    resolver = MountedVectorResolver(tmp_path)
    registry = PublishedVectorRegistry()
    service = VectorStyleService(
        StaticCatalog(item),
        resolver,
        RecordingStyler(),
        registry,
    )
    with pytest.raises(VectorConflictError, match="add the current vector"):
        asyncio.run(service.apply(polygon_request(item)))
    source = resolver.resolve(item)
    registry.authorize(
        f"{GEOSERVER_WORKSPACE_NAME}:{item['id']}",
        source,
        vector_source_signature(source),
        "vector-polygon",
    )
    with pytest.raises(VectorConflictError, match="does not match"):
        asyncio.run(service.apply(polygon_request(item, "line")))


def test_geoserver_style_adapter_creates_then_updates_per_layer_sld() -> None:
    """Use exact create/update status contracts and assign the current style."""
    resource_name = "geopackage-0123456789abcdef01234567"
    expected_style_name = vector_style_name(resource_name)
    style_exists = False
    requests: list[httpx2.Request] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        nonlocal style_exists
        requests.append(request)
        path = request.url.path.removeprefix("/geoserver/rest")
        if request.method == "GET" and path.endswith(
            f"/layers/{resource_name}.json"
        ):
            return httpx2.Response(200)
        if request.method == "GET" and path.endswith(
            f"/styles/{expected_style_name}.sld"
        ):
            return httpx2.Response(200 if style_exists else 404)
        if request.method == "POST" and path.endswith(
            "/workspaces/eolab/styles"
        ):
            assert request.url.params["name"] == expected_style_name
            assert request.headers["content-type"] == (
                "application/vnd.ogc.sld+xml"
            )
            ElementTree.fromstring(request.content)
            style_exists = True
            return httpx2.Response(201)
        if request.method == "PUT" and path.endswith(
            f"/styles/{expected_style_name}"
        ):
            ElementTree.fromstring(request.content)
            return httpx2.Response(200)
        if request.method == "PUT" and path.endswith(
            f"/layers/{resource_name}.json"
        ):
            document = __import__("json").loads(request.content)
            assert document["layer"]["defaultStyle"] == {
                "name": expected_style_name,
                "workspace": "eolab",
            }
            return httpx2.Response(200)
        raise AssertionError(f"Unexpected request: {request.method} {path}")

    client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    publisher = GeoServerVectorPublisher(client, "http://geoserver/geoserver")

    first = asyncio.run(
        publisher.apply_style(resource_name, default_vector_style("polygon"))
    )
    second = asyncio.run(
        publisher.apply_style(resource_name, polygon_request({
            "collection": "eolab-mounted-vectors",
            "id": resource_name,
        }).style)
    )
    asyncio.run(client.aclose())

    assert first == second == expected_style_name
    assert sum(request.method == "POST" for request in requests) == 1
    assert any(
        request.method == "PUT" and request.url.path.endswith(expected_style_name)
        for request in requests
    )
