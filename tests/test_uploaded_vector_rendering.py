"""Exercise private vector rendering through the real application composition."""

import json
import os
from pathlib import Path
from threading import Event
from typing import Any, TypeAlias
from urllib.parse import parse_qsl, urlencode

import httpx2
import pytest
from fastapi.testclient import TestClient

import eolab_app.main as application_module
from eolab_app.vector.filters import VectorFilter, VectorFilterCount
from eolab_app.vector.models import (
    ResolvedVectorSource,
    VectorCategoryRead,
    VectorNumericRead,
)
from eolab_app.vector.styles import default_vector_style
from tests.test_vector_publication import RecordingPublisher
from tests.test_vector_styling import RecordingStyler
from tests.test_vector_uploads import HEADERS, write_layer

FILTER = {
    "enabled": True,
    "match": "all",
    "rules": [{"field": "count", "operator": "eq", "value": 7}],
}


class RecordingRenderer(RecordingPublisher, RecordingStyler):
    """Record publication and styling at the ordinary GeoServer adapter boundary."""


class FixtureFieldReader:
    """Return the single admitted fixture row through the native reader contract."""

    def __init__(self) -> None:
        """Record the authorized original sources supplied by real services."""
        self.sources: list[ResolvedVectorSource] = []

    def read_categories(
        self,
        source: ResolvedVectorSource,
        field: str,
        feature_limit: int,
        cancel_event: Event,
    ) -> VectorCategoryRead:
        """Return the fixture's text attribute without a GeoServer dependency.

        Args:
            source: Source authorized by the upload boundary.
            field: Requested text field.
            feature_limit: Ordinary interactive read budget.
            cancel_event: Service-owned cancellation signal.

        Returns:
            Complete category count for the fixture's one feature.
        """
        self.sources.append(source)
        return VectorCategoryRead((("Café wetlands", 1),), 1, 0, 0, True)

    def read_numbers(
        self,
        source: ResolvedVectorSource,
        field: str,
        feature_limit: int,
        cancel_event: Event,
    ) -> VectorNumericRead:
        """Return the fixture's numeric attribute through the ordinary read contract.

        Args:
            source: Source authorized by the upload boundary.
            field: Requested numeric field.
            feature_limit: Ordinary interactive read budget.
            cancel_event: Service-owned cancellation signal.

        Returns:
            Complete numeric values for the fixture's one feature.
        """
        self.sources.append(source)
        return VectorNumericRead((7.0,), 1, 0, 0, True)

    def count_filter(
        self,
        source: ResolvedVectorSource,
        candidate: VectorFilter,
        feature_limit: int,
        cancel_event: Event,
    ) -> VectorFilterCount:
        """Return the fixture's exact count for its matching predicate.

        Args:
            source: Source authorized by the upload boundary.
            candidate: Validated count-equals-seven predicate.
            feature_limit: Ordinary interactive read budget.
            cancel_event: Service-owned cancellation signal.

        Returns:
            One matched feature out of one total feature.
        """
        self.sources.append(source)
        return VectorFilterCount(matched=1, total=1, complete=True)


RenderingFixture: TypeAlias = tuple[
    TestClient,
    TestClient,
    dict[str, Any],
    RecordingRenderer,
    FixtureFieldReader,
    list[httpx2.Request],
]


@pytest.fixture
def rendered_upload(
    configured_environment: None,
    version_file_path: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> RenderingFixture:
    """Upload a real GeoPackage using application-owned authorization and services.

    Args:
        configured_environment: Deployment settings with an isolated upload volume.
        version_file_path: Baked application version fixture.
        tmp_path: Directory containing the original GeoPackage.
        monkeypatch: Replace only external publisher and native field adapters.

    Returns:
        Owning and unrelated browsers, admitted metadata, external adapter logs,
        and requests forwarded to the internal WMS server.
    """
    publisher = RecordingRenderer()
    reader = FixtureFieldReader()
    forwarded: list[httpx2.Request] = []
    monkeypatch.setattr(
        application_module, "GeoServerVectorPublisher", lambda *_: publisher
    )
    monkeypatch.setattr(application_module, "OgrVectorFieldReader", lambda: reader)

    def reject_catalog(request: httpx2.Request) -> httpx2.Response:
        """Reject any attempt to register or read an upload as a public catalog Item.

        Args:
            request: Unexpected catalog request.

        Raises:
            AssertionError: Always, because private uploads do not use the catalog.
        """
        raise AssertionError(f"Private upload contacted the catalog: {request.url}")

    def render(request: httpx2.Request) -> httpx2.Response:
        """Return inspectable WMS output after the real authorization boundary.

        Args:
            request: Authorized internal GeoServer request.

        Returns:
            A small capabilities, feature-information, or image response.
        """
        forwarded.append(request)
        parameters = dict(request.url.params)
        if request.headers.get("content-type", "").startswith(
            "application/x-www-form-urlencoded"
        ):
            parameters.update(
                parse_qsl(request.content.decode(), keep_blank_values=True)
            )
        operation = parameters.get("request", "").lower()
        if operation == "getcapabilities":
            names = [
                f"eolab:{entry[0]}" for entry in publisher.requests if len(entry) == 5
            ]
            layers = "".join(f"<Layer><Name>{name}</Name></Layer>" for name in names)
            return httpx2.Response(
                200,
                text=(
                    "<WMS_Capabilities><Capability><Layer>"
                    "<Layer><Name>eolab:public-demo</Name></Layer>"
                    f"{layers}</Layer></Capability></WMS_Capabilities>"
                ),
                headers={"Content-Type": "application/xml"},
            )
        if operation == "getfeatureinfo":
            return httpx2.Response(
                200, json={"type": "FeatureCollection", "features": []}
            )
        return httpx2.Response(
            200,
            content=b"private vector image",
            headers={
                "Content-Type": "image/png",
                "Cache-Control": "public, max-age=60",
            },
        )

    application = application_module.create_app(
        version_file_path,
        catalog_transport=httpx2.MockTransport(reject_catalog),
        geoserver_transport=httpx2.MockTransport(render),
    )
    owner = TestClient(application, base_url="https://testserver")
    other = TestClient(application, base_url="https://testserver")
    assert other.get("/api/vector-uploads").json() == []
    response = owner.post(
        "/api/vector-uploads",
        params={"name": "Private wetlands"},
        headers=HEADERS,
        content=write_layer(tmp_path / "original.gpkg"),
    )
    assert response.status_code == 201, response.text
    if os.name == "posix":
        original = next((tmp_path / "vector-uploads").glob("*/*/source.gpkg"))
        original.chmod(0o600)
        original.parent.chmod(0o700)
        original.parent.parent.chmod(0o700)
    return owner, other, response.json(), publisher, reader, forwarded


def test_each_private_rendering_action_uses_the_owned_original_source(
    rendered_upload: RenderingFixture,
    tmp_path: Path,
) -> None:
    """Authorize every rendering action and preserve the ordinary vector contracts.

    Args:
        rendered_upload: Real application and admitted private GeoPackage.
        tmp_path: Isolated source and upload volume.
    """
    owner, other, upload, publisher, reader, _ = rendered_upload
    base = f"/api/vector-rendering/uploads/{upload['id']}"
    actions = {
        "layers": {},
        "styles": {"style": default_vector_style("polygon").model_dump(by_alias=True)},
        "category-summaries": {"field": "label"},
        "numeric-classifications": {
            "field": "count",
            "method": "equal-interval",
            "classCount": 2,
        },
        "filters": {"filter": FILTER},
        "filter-counts": {"filter": FILTER},
    }
    results = {}
    for action, body in actions.items():
        response = owner.post(f"{base}/{action}", json=body, headers=HEADERS)
        assert response.status_code == 200, response.text
        assert response.headers["Cache-Control"] == "private, no-store"
        assert str(tmp_path) not in response.text
        results[action] = response.json()
        calls = (len(publisher.requests), len(reader.sources))
        denied = other.post(f"{base}/{action}", json=body, headers=HEADERS)
        assert denied.status_code == 404, denied.text
        assert denied.headers["Cache-Control"] == "private, no-store"
        assert owner.post(f"{base}/{action}", json=body).status_code == 403
        assert calls == (len(publisher.requests), len(reader.sources))
    assert results["layers"]["geometryKind"] == "polygon"
    assert results["layers"]["bbox"] == pytest.approx(
        [0, 0, 0.00898315284, 0.00898315280]
    )
    assert results["category-summaries"]["values"] == [
        {"value": {"kind": "string", "value": "Café wetlands"}, "count": 1}
    ]
    assert results["numeric-classifications"]["observedMinimum"] == 7
    assert results["filter-counts"] == {"matched": 1, "total": 1, "complete": True}
    assert results["filters"]["layerName"] != results["layers"]["layerName"]
    original = publisher.requests[0][2]
    assert original.read_bytes() == (tmp_path / "original.gpkg").read_bytes()
    assert all(source.source_path == original for source in reader.sources)
    if os.name == "posix":
        assert original.stat().st_mode & 0o004
        for directory in (
            original.parent,
            original.parent.parent,
            original.parent.parent.parent,
        ):
            assert directory.stat().st_mode & 0o005 == 0o005
    assert (
        owner.delete(f"/api/vector-uploads/{upload['id']}", headers=HEADERS).status_code
        == 204
    )
    calls = (len(publisher.requests), len(reader.sources))
    for action, body in actions.items():
        response = owner.post(f"{base}/{action}", json=body, headers=HEADERS)
        assert response.status_code == 404, response.text
        assert response.headers["Cache-Control"] == "private, no-store"
    assert calls == (len(publisher.requests), len(reader.sources))


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_private_wms_and_cached_composites_reject_other_browsers_and_deleted_uploads(
    rendered_upload: RenderingFixture,
    method: str,
) -> None:
    """Protect signed appearances over GET and POST at the real ownership boundary.

    Args:
        rendered_upload: Real application and admitted private GeoPackage.
        method: Direct WMS query or form transport to exercise.
    """
    owner, other, upload, _, _, forwarded = rendered_upload
    base = f"/api/vector-rendering/uploads/{upload['id']}"
    publication = owner.post(f"{base}/layers", headers=HEADERS).json()
    appearance = default_vector_style("polygon").model_copy(
        update={"fill_color": "#db2777"}
    )
    styled = owner.post(
        f"{base}/styles",
        json={"style": appearance.model_dump(by_alias=True)},
        headers=HEADERS,
    )
    assert styled.status_code == 200, styled.text
    publication.update(styled.json())
    filtered = owner.post(
        f"{base}/filters", json={"filter": FILTER}, headers=HEADERS
    ).json()
    wms_requests = []
    for layer in (publication["layerName"], filtered["layerName"]):
        common = {
            "service": "WMS",
            "version": "1.3.0",
            "format": "image/png",
            "vector_style": json.dumps(publication["style"]),
        }
        tile = {
            **common,
            "layers": layer,
            "styles": publication["styleName"],
            "crs": "EPSG:3857",
            "bbox": "0,0,1000,1000",
            "width": 256,
            "height": 256,
        }
        for parameters in (
            {**tile, "request": "GetMap", "transparent": "true"},
            {
                **common,
                "request": "GetLegendGraphic",
                "layer": layer,
                "style": publication["styleName"],
            },
            {
                **tile,
                "request": "GetFeatureInfo",
                "query_layers": layer,
                "info_format": "application/json",
                "i": 1,
                "j": 1,
                "feature_count": 1,
            },
        ):
            transport = (
                {"params": parameters}
                if method == "GET"
                else {"data": parameters, "headers": HEADERS}
            )
            wms_requests.append(transport)
            response = owner.request(method, "/geoserver/eolab/wms", **transport)
            assert response.status_code == 200, response.text
            assert response.headers["Cache-Control"] == "private, no-store"
            calls = len(forwarded)
            denied = other.request(method, "/geoserver/eolab/wms", **transport)
            assert denied.status_code == 404, denied.text
            assert denied.headers["Cache-Control"] == "private, no-store"
            assert len(forwarded) == calls
            if method == "POST":
                missing_header = owner.post("/geoserver/eolab/wms", data=parameters)
                assert missing_header.status_code == 403, missing_header.text
                assert len(forwarded) == calls

    plan_body = {
        "layers": [
            {
                "layerName": filtered["layerName"],
                "styleName": publication["styleName"],
                "styleDefinition": publication["style"],
                "opacity": 1,
            }
        ]
    }
    plan_response = owner.post(
        "/api/map-rendering/plans", json=plan_body, headers=HEADERS
    )
    assert plan_response.status_code == 200, plan_response.text
    assert plan_response.headers["Cache-Control"] == "private, no-store"
    assert (
        other.post(
            "/api/map-rendering/plans", json=plan_body, headers=HEADERS
        ).status_code
        == 404
    )
    tile_url = (
        plan_response.json()["wmsUrl"]
        + "?"
        + urlencode(
            {
                "service": "WMS",
                "version": "1.1.1",
                "request": "GetMap",
                "layers": "composite",
                "styles": "",
                "srs": "EPSG:3857",
                "bbox": "0,0,1000,1000",
                "width": 256,
                "height": 256,
                "format": "image/png",
                "transparent": "true",
            }
        )
    )
    first = owner.get(tile_url)
    assert first.status_code == 200, first.text
    calls = len(forwarded)
    cached = owner.get(tile_url)
    assert cached.content == first.content
    assert cached.headers["Cache-Control"] == "private, no-store"
    assert other.get(tile_url).status_code == 404
    assert len(forwarded) == calls

    capabilities = other.get("/geoserver/eolab/wms?service=WMS&request=GetCapabilities")
    assert capabilities.status_code == 200
    assert "eolab:public-demo" in capabilities.text
    assert publication["layerName"] not in capabilities.text
    assert (
        owner.delete(f"/api/vector-uploads/{upload['id']}", headers=HEADERS).status_code
        == 204
    )
    calls = len(forwarded)
    for transport in wms_requests:
        response = owner.request(method, "/geoserver/eolab/wms", **transport)
        assert response.status_code == 404, response.text
        assert response.headers["Cache-Control"] == "private, no-store"
    deleted_tile = owner.get(tile_url)
    assert deleted_tile.status_code == 404, deleted_tile.text
    assert deleted_tile.headers["Cache-Control"] == "private, no-store"
    assert len(forwarded) == calls
