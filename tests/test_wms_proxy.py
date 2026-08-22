"""Test the restricted public WMS proxy contract."""

from pathlib import Path

import httpx2
import pytest
from fastapi.testclient import TestClient

from eolab_app.main import create_app
from tests.app_support import (
    RASTER_STYLE_ENVIRONMENT_ERROR,
    TEST_GEOTIFF_ITEM_ID,
    VALID_GEOSERVER_METRICS,
    mounted_geotiff_item as _mounted_geotiff_item,
    write_geotiff as _write_geotiff,
)


def test_wms_proxy_forwards_supported_read_operation(
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Expose EOLab workspace WMS without exposing GeoServer itself."""

    def geoserver_response(request: httpx2.Request) -> httpx2.Response:
        assert request.method == "GET"
        assert "authorization" not in request.headers
        assert str(request.url) == (
            "http://geoserver:8080/geoserver/eolab/wms"
            "?service=WMS&version=1.3.0&request=GetCapabilities"
        )
        assert request.headers["x-forwarded-host"] == "testserver"
        assert request.headers["x-forwarded-proto"] == "http"
        return httpx2.Response(
            200,
            content=b'<WMS_Capabilities version="1.3.0"/>',
            headers={
                "Content-Type": "application/xml",
                "Cache-Control": "no-cache",
            },
        )

    response = TestClient(
        create_app(
            version_file_path,
            geoserver_transport=httpx2.MockTransport(geoserver_response),
        )
    ).get(
        "/geoserver/eolab/wms"
        "?service=WMS&version=1.3.0&request=GetCapabilities"
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/xml"
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.content == b'<WMS_Capabilities version="1.3.0"/>'


def test_wms_proxy_allows_bounded_png_rendering(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    version_file_path: Path,
) -> None:
    """Allow tiles only after this app process approves the current source."""

    source_path = tmp_path / "raster.tif"
    _write_geotiff(source_path)
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(tmp_path))
    monkeypatch.setenv("SCAN_PATHS_WITHIN_MOUNT", '["."]')
    item = _mounted_geotiff_item(source_path.as_uri())
    wms_requests = []

    def upstream_response(request: httpx2.Request) -> httpx2.Response:
        if request.url.host == "stac-api":
            return httpx2.Response(200, json=item)
        if request.url.path.endswith("/external.geotiff"):
            return httpx2.Response(201)
        if request.url.path.endswith(f"/{TEST_GEOTIFF_ITEM_ID}.xml"):
            return httpx2.Response(200)
        wms_requests.append(request)
        assert request.url.params["request"] == "GetMap"
        assert request.url.params["format"] == "image/png"
        assert request.url.params["width"] == "256"
        assert request.url.params["height"] == "256"
        assert request.url.params["env"] == (
            "min:0;med:50;max:100;cmin:#2b83ba;"
            "cmed:#ffffbf;cmax:#d7191c"
        )
        if len(wms_requests) == 2:
            return httpx2.Response(
                200,
                content=b"<ServiceException>render failed</ServiceException>",
                headers={"Content-Type": "application/xml"},
            )
        return httpx2.Response(
            200,
            content=b"png bytes",
            headers={"Content-Type": "image/png"},
        )

    def diagnostics_response(request: httpx2.Request) -> httpx2.Response:
        if request.url.port == 9404:
            return httpx2.Response(
                200,
                text=VALID_GEOSERVER_METRICS,
                headers={"content-type": "text/plain"},
            )
        return httpx2.Response(
            200,
            text="<WMS_Capabilities/>",
            headers={"content-type": "application/xml"},
        )

    with TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(upstream_response),
            geoserver_transport=httpx2.MockTransport(upstream_response),
            geoserver_diagnostics_transport=httpx2.MockTransport(
                diagnostics_response
            ),
        )
    ) as client:
        publication_response = client.post(
            "/api/rendering/layers",
            json={
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": TEST_GEOTIFF_ITEM_ID,
            },
        )
        tile_url = (
            "/geoserver/eolab/wms"
            "?service=WMS&version=1.3.0&request=GetMap"
            f"&layers=eolab%3A{TEST_GEOTIFF_ITEM_ID}"
            "&styles=dynamic-raster&crs=EPSG%3A3857"
            "&bbox=0%2C0%2C1%2C1&width=256&height=256"
            "&format=image%2Fpng&transparent=true"
            "&env=min%3A0%3Bmed%3A50%3Bmax%3A100%3B"
            "cmin%3A%232b83ba%3Bcmed%3A%23ffffbf%3Bcmax%3A%23d7191c"
        )
        response = client.get(tile_url)
        diagnostics = client.get("/api/rendering/diagnostics")
        exception_response = client.get(tile_url)
        failure_diagnostics = client.get("/api/rendering/diagnostics")
        source_path.write_bytes(b"replacement")
        changed_source_response = client.get(tile_url)

    assert publication_response.status_code == 200
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.content == b"png bytes"
    assert len(wms_requests) == 2
    request_diagnostics = diagnostics.json()["metrics"]["requests"]
    assert request_diagnostics["latestGetMapSeconds"] >= 0
    assert request_diagnostics | {"latestGetMapSeconds": None} == {
        "activeGetMap": 0,
        "concurrencyLimit": 2,
        "completedGetMap": 1,
        "latestGetMapSeconds": None,
        "recentGetMapFailures": 0,
        "recentWindowSize": 1,
    }
    assert exception_response.status_code == 200
    assert exception_response.headers["content-type"] == "application/xml"
    failure_document = failure_diagnostics.json()
    assert failure_document["state"] == "degraded"
    assert failure_document["metrics"]["requests"] | {
        "latestGetMapSeconds": None
    } == {
        "activeGetMap": 0,
        "concurrencyLimit": 2,
        "completedGetMap": 2,
        "latestGetMapSeconds": None,
        "recentGetMapFailures": 1,
        "recentWindowSize": 2,
    }
    assert changed_source_response.status_code == 409
    assert changed_source_response.json() == {
        "detail": "The visualized GeoTIFF changed; select it again"
    }


def test_wms_proxy_rejects_a_layer_not_approved_by_this_app_process(
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Keep layers persisted by an older deployment outside the public WMS."""
    geoserver_requests = []

    def geoserver_response(request: httpx2.Request) -> httpx2.Response:
        geoserver_requests.append(request)
        return httpx2.Response(500)

    response = TestClient(
        create_app(
            version_file_path,
            geoserver_transport=httpx2.MockTransport(geoserver_response),
        )
    ).get(
        "/geoserver/eolab/wms?service=WMS&request=GetMap"
        f"&layers=eolab%3A{TEST_GEOTIFF_ITEM_ID}"
        "&width=256&height=256&format=image%2Fpng"
    )

    assert response.status_code == 400
    assert response.json() == {
        "detail": "The WMS layer has not been approved for visualization"
    }
    assert geoserver_requests == []


@pytest.mark.parametrize(
    ("query", "detail"),
    (
        ("service=WFS&request=GetCapabilities", "service must be WMS"),
        ("service=WMS&request=DescribeLayer", "Unsupported WMS operation"),
        (
            "service=WMS&request=GetMap&sld=https://example.test/style.sld",
            "Unsupported WMS parameter: sld",
        ),
        (
            "service=WMS&request=GetMap&layers=eolab%3Afirst"
            "&LAYERS=eolab%3Asecond&format=image%2Fpng",
            "WMS parameters must not repeat",
        ),
        (
            "service=WMS&request=GetMap&layers=eolab%3Aexample"
            "&styles=expensive-style&format=image%2Fpng",
            "WMS style must be dynamic-raster",
        ),
        (
            "service=WMS&request=GetMap&layers=eolab%3Afirst%2Ceolab%3Asecond"
            "&format=image%2Fpng",
            "Exactly one WMS layer must be requested",
        ),
        (
            "service=WMS&request=GetFeatureInfo&layers=eolab%3Afirst"
            "&query_layers=eolab%3Asecond&info_format=text%2Fplain",
            "query_layers must match layers",
        ),
        (
            "service=WMS&request=GetLegendGraphic&format=image%2Fpng",
            "Exactly one WMS layer must be requested",
        ),
        (
            "service=WMS&request=GetMap&width=2049",
            "width must be between 1 and 2048",
        ),
        (
            "service=WMS&request=GetMap&format=application/openlayers",
            "WMS map and legend format must be image/png",
        ),
        (
            "service=WMS&request=GetFeatureInfo&info_format=text/html",
            (
                "WMS feature information format must be application/json "
                "or text/plain"
            ),
        ),
        (
            "service=WMS&request=GetMap&format=image%2Fpng&env=",
            RASTER_STYLE_ENVIRONMENT_ERROR,
        ),
        (
            "service=WMS&request=GetMap&format=image%2Fpng"
            "&env=min%3A0%3Bmed%3A50%3Bmax%3A100%3B"
            "cmin%3A%232b83ba%3Bcmed%3A%23ffffbf%3Bopacity%3A1",
            RASTER_STYLE_ENVIRONMENT_ERROR,
        ),
        (
            "service=WMS&request=GetMap&format=image%2Fpng"
            "&env=min%3A0%3Bmin%3A1%3Bmed%3A50%3Bmax%3A100%3B"
            "cmin%3A%232b83ba%3Bcmed%3A%23ffffbf",
            RASTER_STYLE_ENVIRONMENT_ERROR,
        ),
        (
            "service=WMS&request=GetMap&format=image%2Fpng"
            "&env=min%3A0%3Bmed%3ANaN%3Bmax%3A100%3B"
            "cmin%3A%232b83ba%3Bcmed%3A%23ffffbf%3Bcmax%3A%23d7191c",
            RASTER_STYLE_ENVIRONMENT_ERROR,
        ),
        (
            "service=WMS&request=GetMap&format=image%2Fpng"
            "&env=min%3A0%3Bmed%3A100%3Bmax%3A50%3B"
            "cmin%3A%232b83ba%3Bcmed%3A%23ffffbf%3Bcmax%3A%23d7191c",
            RASTER_STYLE_ENVIRONMENT_ERROR,
        ),
        (
            "service=WMS&request=GetMap&format=image%2Fpng"
            "&env=min%3A0%3Bmed%3A50%3Bmax%3A100%3B"
            "cmin%3Ablue%3Bcmed%3A%23ffffbf%3Bcmax%3A%23d7191c",
            RASTER_STYLE_ENVIRONMENT_ERROR,
        ),
    ),
)
def test_wms_proxy_rejects_requests_outside_its_public_contract(
    configured_environment: None,
    version_file_path: Path,
    query: str,
    detail: str,
) -> None:
    """Reject non-WMS operations, remote styles, and oversized rendering."""
    response = TestClient(create_app(version_file_path)).get(
        f"/geoserver/eolab/wms?{query}"
    )

    assert response.status_code == 400
    assert response.json() == {"detail": detail}


def test_wms_proxy_rejects_post(
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Keep every state-changing GeoServer operation off the public route."""
    response = TestClient(create_app(version_file_path)).post(
        "/geoserver/eolab/wms?service=WMS&request=GetCapabilities"
    )

    assert response.status_code == 405


def test_unavailable_geoserver_does_not_change_app_health(
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Keep application liveness independent from rendering readiness."""

    def unavailable_geoserver(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("GeoServer unavailable", request=request)

    client = TestClient(
        create_app(
            version_file_path,
            geoserver_transport=httpx2.MockTransport(unavailable_geoserver),
        )
    )

    assert client.get("/healthz").status_code == 200
    response = client.get(
        "/geoserver/eolab/wms?service=WMS&request=GetCapabilities"
    )
    assert response.status_code == 502
    assert response.json() == {
        "detail": "The rendering service is unavailable"
    }
