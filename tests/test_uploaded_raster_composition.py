"""Verify uploaded raster privacy through the actual application composition."""

from pathlib import Path

from fastapi.testclient import TestClient
import httpx2

from eolab_app.main import create_app
from eolab_app.routes.browser_identity import COOKIE
from test_composite_map import _tile_url
from test_raster_uploads import mask_bytes
from test_temporary_raster_publication import OutputGeoServer, map_query, plan_request


def test_upload_browser_owns_publication_wms_composites_and_analysis(
    configured_environment: None, version_file_path: Path, tmp_path: Path
) -> None:
    """Use ordinary source routes and enforce upload ownership before cached tiles.

    Args:
        configured_environment: Complete application settings with isolated uploads.
        version_file_path: Real application build metadata fixture.
        tmp_path: Original GeoTIFF fixture directory.
    """
    upstream = OutputGeoServer()

    def unavailable_catalog(request: httpx2.Request) -> httpx2.Response:
        """Fail unexpected catalog reads for an independently owned upload.

        Args:
            request: Unexpected external catalog request.

        Raises:
            AssertionError: Uploaded source resolution must not use Catalog.
        """
        raise AssertionError(f"Uploads do not require Catalog: {request.url.path}")

    application = create_app(
        version_file_path,
        catalog_transport=httpx2.MockTransport(unavailable_catalog),
        geoserver_transport=httpx2.MockTransport(upstream),
    )
    client = TestClient(application, base_url="https://testserver")
    headers = {"X-EOLab-Uploads": "1"}
    try:
        uploaded = client.post(
            "/api/raster-uploads",
            params={"name": "Reference sites"},
            content=mask_bytes(tmp_path / "mask.tif"),
            headers=headers,
        )
        assert uploaded.status_code == 201, uploaded.text
        identifier = uploaded.json()["id"]
        source = {"kind": "uploadedRaster", "uploadId": identifier}
        pixel = client.post(
            "/api/raster-analysis/pixels",
            json={
                "source": source,
                "longitude": -3.5,
                "latitude": 3.5,
            },
            headers=headers,
        )
        assert pixel.status_code == 200 and pixel.json()["value"] == 1, pixel.text
        published = client.post(
            "/api/rendering/layers", json={"source": source}, headers=headers
        )
        assert published.status_code == 200, published.text
        layer = published.json()["layerName"]
        capabilities = client.get(
            "/geoserver/eolab/wms",
            params={"service": "WMS", "request": "GetCapabilities"},
        )
        assert capabilities.status_code == 200 and layer not in capabilities.text
        direct = client.get("/geoserver/eolab/wms", params=map_query(layer))
        assert (
            direct.content == b"tile"
            and direct.headers["Cache-Control"] == "private, no-store"
        )
        planned = client.post(
            "/api/map-rendering/plans", json=plan_request(layer), headers=headers
        )
        assert planned.status_code == 200, planned.text
        tile = _tile_url(planned.json()["wmsUrl"])
        assert client.get(tile).content == b"tile"
        assert client.get(tile).content == b"tile"
        owned_cookie = client.cookies.get(COOKIE)
        client.cookies.clear()
        before = len(upstream.requests)
        assert client.get(tile).status_code == 404
        assert (
            client.get("/geoserver/eolab/wms", params=map_query(layer)).status_code
            == 404
        )
        assert (
            client.post(
                "/api/rendering/layers", json={"source": source}, headers=headers
            ).status_code
            == 404
        )
        assert len(upstream.requests) == before
        client.cookies.set(COOKIE, owned_cookie)
        assert (
            client.delete(
                f"/api/raster-uploads/{identifier}", headers=headers
            ).status_code
            == 204
        )
        assert client.get(tile).status_code == 404
    finally:
        client.close()
