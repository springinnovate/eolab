"""Test the EOLab application and its runtime settings contract."""

import asyncio
import base64
import json
from pathlib import Path
from unittest.mock import AsyncMock

import httpx2
import numpy
import pytest
import rasterio
from fastapi.testclient import TestClient
from rasterio.transform import from_origin

from eolab_app.catalog.geotiff import build_stac_item as build_geotiff_stac_item
from eolab_app.main import create_app
from eolab_app.raster.models import GEOSERVER_READER_CONTRACT
from eolab_app.raster.sources import source_signature
from eolab_app.settings import load_settings
from tests.app_support import (
    TEST_GEOTIFF_ITEM_ID,
    mounted_geotiff_item as _mounted_geotiff_item,
    write_geotiff as _write_geotiff,
)


def test_healthz(
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Report liveness using the baked Git-derived application version."""
    response = TestClient(create_app(version_file_path)).get("/healthz")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "eolab",
        "version": "0.1.0-2-gabcdef0",
    }


def test_configuration_endpoint_reads_environment(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    version_file_path: Path,
) -> None:
    """Expose the deployment environment through the public configuration."""
    monkeypatch.setenv("APP_TITLE", "WWF EOLab")
    monkeypatch.setenv("CATALOG_URL", "https://catalog.example.test")

    response = TestClient(create_app(version_file_path)).get("/api/config")

    assert response.status_code == 200
    assert response.json() == {
        "appTitle": "WWF EOLab",
        "appSubtitle": "Explore, visualize, and analyze Earth observation data",
        "appVersion": "0.1.0-2-gabcdef0",
        "catalogUrl": "https://catalog.example.test",
        "wmsUrl": "/geoserver/eolab/wms",
        "scanDisplayPathPrefix": "bigboi -- Z:\\bigbucket",
        "scanDisplayPaths": ["bigboi -- Z:\\bigbucket"],
        "basemap": {
            "url": "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
            "attribution": "&copy; OpenStreetMap contributors",
        },
        "initialView": {
            "latitude": 20,
            "longitude": 0,
            "zoom": 2,
        },
    }
    settings = load_settings(version_file_path)
    assert (
        settings.raster_pixel_read_concurrency,
        settings.raster_statistics_read_concurrency,
        settings.raster_statistics_cache_entries,
    ) == (2, 1, 32)
    assert "valid-admin-password" not in repr(settings)
    assert "http://geoserver:8080" not in response.text
    assert "http://geoserver:9404" not in response.text


def test_public_scan_paths_use_the_user_facing_prefix(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    version_file_path: Path,
) -> None:
    """Expose configured scan directories without leaking the container mount.

    Args:
        configured_environment: Complete baseline environment fixture.
        monkeypatch: Pytest environment mutation fixture.
        tmp_path: Isolated mounted-directory fixture root.
        version_file_path: File containing the test application version.
    """
    scan_mount = tmp_path / "scan-source"
    (scan_mount / "incoming").mkdir(parents=True)
    (scan_mount / "archive" / "2025").mkdir(parents=True)
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(scan_mount))
    monkeypatch.setenv(
        "SCAN_PATHS_WITHIN_MOUNT",
        '["incoming", "archive/2025"]',
    )

    settings = load_settings(version_file_path)

    assert settings.scan_display_paths() == (
        "bigboi -- Z:\\bigbucket\\incoming",
        "bigboi -- Z:\\bigbucket\\archive\\2025",
    )
    assert settings.as_public_dict()["scanDisplayPaths"] == [
        "bigboi -- Z:\\bigbucket\\incoming",
        "bigboi -- Z:\\bigbucket\\archive\\2025",
    ]
    assert str(scan_mount) not in str(settings.as_public_dict())


def test_load_settings_reads_scan_operational_limits(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    version_file_path: Path,
) -> None:
    """Load deployer-controlled scan bounds without exposing them publicly."""
    configured_limits = {
        "SCAN_ERROR_DETAIL_LIMIT": "17",
        "SCAN_RECONCILIATION_PAGE_SIZE": "211",
        "SCAN_RECONCILIATION_CONCURRENCY": "3",
        "SCAN_RECONCILIATION_SPOOL_MEMORY_BYTES": "4096",
        "SCAN_CATALOG_WRITE_TIMEOUT_SECONDS": "45.5",
        "SCAN_CATALOG_ERROR_DETAIL_LIMIT": "73",
    }
    for environment_variable_name, value in configured_limits.items():
        monkeypatch.setenv(environment_variable_name, value)

    settings = load_settings(version_file_path)

    assert settings.scan_error_detail_limit == 17
    assert settings.scan_reconciliation_page_size == 211
    assert settings.scan_reconciliation_concurrency == 3
    assert settings.scan_reconciliation_spool_memory_bytes == 4096
    assert settings.scan_catalog_write_timeout_seconds == 45.5
    assert settings.scan_catalog_error_detail_limit == 73
    assert not set(configured_limits).intersection(settings.as_public_dict())








def test_app_closes_every_http_pool_when_lifespan_exits_with_an_error(
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Keep connection-pool cleanup unconditional during abnormal shutdown."""

    class ClosingTransport(httpx2.AsyncBaseTransport):
        def __init__(self) -> None:
            self.close_count = 0

        async def handle_async_request(
            self,
            request: httpx2.Request,
        ) -> httpx2.Response:
            raise AssertionError(f"Unexpected request: {request.url}")

        async def aclose(self) -> None:
            self.close_count += 1

    catalog_transport = ClosingTransport()
    geoserver_transport = ClosingTransport()
    diagnostics_transport = ClosingTransport()
    application = create_app(
        version_file_path,
        catalog_transport=catalog_transport,
        geoserver_transport=geoserver_transport,
        geoserver_diagnostics_transport=diagnostics_transport,
    )

    with pytest.raises(RuntimeError, match="lifespan failed"):
        with TestClient(application):
            raise RuntimeError("lifespan failed")

    assert catalog_transport.close_count == 1
    assert geoserver_transport.close_count == 2
    assert diagnostics_transport.close_count == 1


def test_scan_status_is_available_before_first_scan(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    version_file_path: Path,
) -> None:
    """Expose an idle scanner state for the browser on initial startup."""
    monkeypatch.setenv("SCAN_BATCH_SIZE", "250")
    response = TestClient(create_app(version_file_path)).get("/api/scans/current")

    assert response.status_code == 200
    assert response.json()["state"] == "not_started"
    assert response.json()["discovered"] == 0
    assert response.json()["workerCount"] == 8
    assert response.json()["writerCount"] == 4
    assert response.json()["batchSize"] == 250
    assert response.json()["reconciliation"] == {
        "state": "not_started",
        "checked": 0,
        "missing": 0,
        "removed": 0,
        "error": None,
    }
    assert response.json()["timing"] == {
        "elapsedSeconds": 0.0,
        "catalogInventorySeconds": 0.0,
        "discoverySeconds": 0.0,
        "metadataResultWaitSeconds": 0.0,
        "metadataWorkerSeconds": 0.0,
        "metadataProcessingSeconds": 0.0,
        "metadataIoWaitSeconds": 0.0,
        "catalogWriteSeconds": 0.0,
        "reconciliationSeconds": 0.0,
        "cacheInvalidationSeconds": 0.0,
    }


@pytest.mark.parametrize(
    "asset_media_type",
    (
        "image/tiff; application=geotiff",
        "image/tiff; application=geotiff; profile=cloud-optimized",
    ),
    ids=("geotiff", "cog"),
)
def test_catalog_geotiff_is_published_idempotently(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    version_file_path: Path,
    asset_media_type: str,
) -> None:
    """Resolve STAC server-side and reuse one deterministic GeoServer layer."""
    source_path = tmp_path / "nested" / "raster with spaces.tif"
    _write_geotiff(source_path)
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(tmp_path))
    monkeypatch.setenv("SCAN_PATHS_WITHIN_MOUNT", '["."]')
    item = _mounted_geotiff_item(source_path.as_uri(), asset_media_type)
    item["bbox"] = [
        -180.000823370733,
        -90.0004116853666,
        180.000823370733,
        90.0004116853666,
    ]
    resource_name = TEST_GEOTIFF_ITEM_ID
    geoserver_requests: list[httpx2.Request] = []

    def upstream_response(request: httpx2.Request) -> httpx2.Response:
        if request.url.host == "stac-api":
            assert request.url.path == (
                "/collections/eolab-mounted-geotiffs/items/"
                + TEST_GEOTIFF_ITEM_ID
            )
            assert "authorization" not in request.headers
            return httpx2.Response(200, json=item)

        geoserver_requests.append(request)
        expected_authorization = "Basic " + base64.b64encode(
            b"eolab:valid-admin-password"
        ).decode()
        assert request.headers["authorization"] == expected_authorization
        external_geotiff_path = (
            "/geoserver/rest/workspaces/eolab/coveragestores/"
            f"{resource_name}/external.geotiff"
        )
        layer_path = f"/geoserver/rest/workspaces/eolab/layers/{resource_name}"
        if request.url.path == external_geotiff_path:
            assert request.method == "PUT"
            assert request.headers["accept"] == "application/json"
            assert request.headers["content-type"] == "text/plain"
            assert request.url.params["configure"] == "first"
            assert request.url.params["coverageName"] == resource_name
            assert request.content.decode() == source_path.resolve().as_uri()
            return httpx2.Response(201)
        if request.url.path == f"{layer_path}.xml":
            assert request.method == "PUT"
            assert request.headers["content-type"] == "application/xml"
            assert b"<name>dynamic-raster</name>" in request.content
            assert b"<workspace>eolab</workspace>" in request.content
            return httpx2.Response(200)
        raise AssertionError(f"Unexpected GeoServer request: {request}")

    with TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(upstream_response),
            geoserver_transport=httpx2.MockTransport(upstream_response),
        )
    ) as client:
        first_response = client.post(
            "/api/rendering/layers",
            json={
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": TEST_GEOTIFF_ITEM_ID,
            },
        )
        repeated_response = client.post(
            "/api/rendering/layers",
            json={
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": TEST_GEOTIFF_ITEM_ID,
            },
        )

    expected_response = {
        "layerName": f"eolab:{resource_name}",
        "bbox": item["bbox"],
    }
    assert first_response.status_code == 200
    assert first_response.json() == expected_response
    assert repeated_response.json() == expected_response
    assert [request.method for request in geoserver_requests] == ["PUT"] * 4
    assert len({request.url.path for request in geoserver_requests}) == 2


def test_one_outdated_raster_is_assessed_and_updated(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    version_file_path: Path,
) -> None:
    """Upgrade one selected Item without scanning the mounted directory."""
    source_path = tmp_path / "raster.tif"
    _write_geotiff(source_path)
    current_item = build_geotiff_stac_item(tmp_path, source_path)
    item_id = current_item["id"]
    current_item["assets"]["data"]["eolab:rendering"] = {
        "policy": "raster-v1",
        "eligible": False,
        "reason": "Visualization unavailable under the former policy.",
    }
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(tmp_path))
    monkeypatch.setenv("SCAN_PATHS_WITHIN_MOUNT", '["."]')
    catalog_requests = []

    def catalog_response(request: httpx2.Request) -> httpx2.Response:
        nonlocal current_item
        catalog_requests.append(request)
        item_path = (
            "/collections/eolab-mounted-geotiffs/items/" + item_id
        )
        if request.method == "GET" and request.url.path == item_path:
            return httpx2.Response(200, json=current_item)
        if request.method == "POST":
            assert request.url.path == (
                "/collections/eolab-mounted-geotiffs/bulk_items"
            )
            request_document = json.loads(request.content)
            assert request_document["method"] == "upsert"
            assert list(request_document["items"]) == [item_id]
            current_item = request_document["items"][item_id]
            return httpx2.Response(200, json="Successfully upserted 1 item.")
        raise AssertionError(f"Unexpected catalog request: {request}")

    def geoserver_response(request: httpx2.Request) -> httpx2.Response:
        """Return one compatible deployed-reader assessment.

        Args:
            request: Captured authenticated GeoServer assessment request.

        Returns:
            Controlled compatible reader response.
        """
        assert request.url.path == (
            "/geoserver/rest/eolab/reader-assessments"
        )
        assert request.method == "POST"
        assert request.content.decode() == source_path.resolve().as_uri()
        return httpx2.Response(200, json={
            "contract": GEOSERVER_READER_CONTRACT,
            "compatible": True,
            "reasonCode": None,
        })

    with TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(catalog_response),
            geoserver_transport=httpx2.MockTransport(geoserver_response),
        )
    ) as client:
        request_body = {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": item_id,
        }
        first_response = client.post(
            "/api/rendering/assessments",
            json=request_body,
        )
        repeated_response = client.post(
            "/api/rendering/assessments",
            json=request_body,
        )

    assert first_response.status_code == 200
    assert first_response.json()["assets"]["data"]["eolab:rendering"] == {
        "policy": "raster-v3",
        "eligible": True,
        "reader_contract": GEOSERVER_READER_CONTRACT,
        "reader_compatible": True,
        "source_signature": list(source_signature(source_path)),
        "bounded_blocks": True,
        "block_shapes": [[1, 1]],
        "overview_factors": [[]],
        "overview_storage": "none",
        "compression": None,
        "estimated_uncompressed_bytes": 1,
    }
    assert repeated_response.json() == first_response.json()
    assert [request.method for request in catalog_requests] == [
        "GET",
        "POST",
        "GET",
        "POST",
    ]


@pytest.mark.parametrize(
    ("rendering_metadata", "expected_detail"),
    (
        (
            None,
            "Visualization unavailable: assess this raster first.",
        ),
        (
            {
                "policy": "raster-v3",
                "eligible": False,
                "reason_code": "blocks_too_large",
                "reason": (
                    "Visualization unavailable: this raster needs smaller "
                    "internal blocks."
                ),
            },
            (
                "Visualization unavailable: this raster needs smaller "
                "internal blocks."
            ),
        ),
    ),
    ids=("unassessed", "ineligible"),
)
def test_raster_publication_requires_scanner_eligibility(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    version_file_path: Path,
    rendering_metadata: dict[str, object] | None,
    expected_detail: str,
) -> None:
    """Refuse legacy and unsuitable Items before contacting GeoServer."""
    source_path = tmp_path / "raster.tif"
    _write_geotiff(source_path)
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(tmp_path))
    monkeypatch.setenv("SCAN_PATHS_WITHIN_MOUNT", '["."]')
    item = _mounted_geotiff_item(source_path.as_uri())
    if rendering_metadata is None:
        del item["assets"]["data"]["eolab:rendering"]
    else:
        item["assets"]["data"]["eolab:rendering"] = rendering_metadata
    geoserver_requests = []

    def catalog_response(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json=item)

    def geoserver_response(request: httpx2.Request) -> httpx2.Response:
        geoserver_requests.append(request)
        return httpx2.Response(500)

    response = TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(catalog_response),
            geoserver_transport=httpx2.MockTransport(geoserver_response),
        )
    ).post(
        "/api/rendering/layers",
        json={
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": TEST_GEOTIFF_ITEM_ID,
        },
    )

    assert response.status_code == 409
    assert response.json() == {"detail": expected_detail}
    assert geoserver_requests == []


def test_raster_publication_reassesses_a_changed_source(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    version_file_path: Path,
) -> None:
    """Require reassessment when source identity changed after assessment."""
    source_path = tmp_path / "raster.tif"
    _write_geotiff(source_path)
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(tmp_path))
    monkeypatch.setenv("SCAN_PATHS_WITHIN_MOUNT", '["."]')
    item = _mounted_geotiff_item(source_path.as_uri())
    geoserver_requests = []
    source_path.write_bytes(b"changed after assessment")

    def catalog_response(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json=item)

    def geoserver_response(request: httpx2.Request) -> httpx2.Response:
        geoserver_requests.append(request)
        return httpx2.Response(500)

    response = TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(catalog_response),
            geoserver_transport=httpx2.MockTransport(geoserver_response),
        )
    ).post(
        "/api/rendering/layers",
        json={
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": TEST_GEOTIFF_ITEM_ID,
        },
    )

    assert response.status_code == 409
    assert response.json() == {
        "detail": (
            "Visualization unavailable: the raster changed; reassess it "
            "before publication."
        )
    }
    assert geoserver_requests == []


def test_raster_changed_during_publication_is_not_authorized(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    version_file_path: Path,
) -> None:
    """Keep a source replacement out of WMS after GeoServer REST succeeds."""
    source_path = tmp_path / "raster.tif"
    _write_geotiff(source_path)
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(tmp_path))
    monkeypatch.setenv("SCAN_PATHS_WITHIN_MOUNT", '["."]')
    item = _mounted_geotiff_item(source_path.as_uri())
    geoserver_requests = []

    def upstream_response(request: httpx2.Request) -> httpx2.Response:
        if request.url.host == "stac-api":
            return httpx2.Response(200, json=item)
        geoserver_requests.append(request)
        if request.url.path.endswith("/external.geotiff"):
            source_path.write_bytes(b"replacement")
            return httpx2.Response(201)
        if request.url.path.endswith(f"/{TEST_GEOTIFF_ITEM_ID}.xml"):
            return httpx2.Response(200)
        raise AssertionError(f"Unexpected GeoServer request: {request}")

    with TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(upstream_response),
            geoserver_transport=httpx2.MockTransport(upstream_response),
        )
    ) as client:
        publication_response = client.post(
            "/api/rendering/layers",
            json={
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": TEST_GEOTIFF_ITEM_ID,
            },
        )
        tile_response = client.get(
            "/geoserver/eolab/wms?service=WMS&request=GetMap"
            f"&layers=eolab%3A{TEST_GEOTIFF_ITEM_ID}"
            "&width=256&height=256&format=image%2Fpng"
        )

    assert publication_response.status_code == 409
    assert publication_response.json() == {
        "detail": "The GeoTIFF changed while it was being published"
    }
    assert tile_response.status_code == 400
    assert len(geoserver_requests) == 2


@pytest.mark.parametrize(
    "endpoint",
    ("/api/rendering/assessments", "/api/rendering/layers"),
)
@pytest.mark.parametrize(
    "request_body",
    (
        {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-id",
            "href": "file:///etc/passwd",
        },
        {"collectionId": "eolab-mounted-vectors", "itemId": "vector-id"},
        {"collectionId": 1, "itemId": "geotiff-id"},
        {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "../geotiff?item#fragment",
        },
        {
            "collection_id": "eolab-mounted-geotiffs",
            "item_id": "geotiff-0123456789abcdef01234567",
        },
    ),
)
def test_raster_actions_reject_browser_paths_and_unsupported_items(
    configured_environment: None,
    version_file_path: Path,
    endpoint: str,
    request_body: dict[str, object],
) -> None:
    """Reject invalid public input before making any upstream request."""
    upstream_request = AsyncMock()
    client = TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(upstream_request),
            geoserver_transport=httpx2.MockTransport(upstream_request),
        )
    )

    response = client.post(endpoint, json=request_body)

    assert response.status_code == 422
    upstream_request.assert_not_awaited()


@pytest.mark.parametrize(
    "asset_location",
    ("remote", "outside", "traversal"),
)
def test_raster_publication_rejects_assets_outside_the_scan_mount(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    version_file_path: Path,
    asset_location: str,
) -> None:
    """Never let a catalog record expand GeoServer's filesystem boundary."""
    scan_mount_path = tmp_path / "scan-source"
    scan_mount_path.mkdir()
    outside_path = tmp_path / "outside.tif"
    outside_path.write_bytes(b"outside")
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(scan_mount_path))
    monkeypatch.setenv("SCAN_PATHS_WITHIN_MOUNT", '["."]')
    asset_hrefs = {
        "remote": "https://example.test/raster.tif",
        "outside": outside_path.as_uri(),
        "traversal": f"{scan_mount_path.as_uri()}/../outside.tif",
    }
    item = _mounted_geotiff_item(asset_hrefs[asset_location])
    geoserver_requests = []

    def catalog_response(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json=item)

    def geoserver_response(request: httpx2.Request) -> httpx2.Response:
        geoserver_requests.append(request)
        return httpx2.Response(500)

    response = TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(catalog_response),
            geoserver_transport=httpx2.MockTransport(geoserver_response),
        )
    ).post(
        "/api/rendering/layers",
        json={
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": TEST_GEOTIFF_ITEM_ID,
        },
    )

    assert response.status_code == 422
    assert geoserver_requests == []


def test_raster_publication_rejects_a_mismatched_catalog_item(
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Require the authoritative STAC response to match the requested Item."""
    item = _mounted_geotiff_item("file:///scan-source/raster.tif")
    item["id"] = "geotiff-abcdef0123456789abcdef01"
    geoserver_requests = []

    def catalog_response(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json=item)

    def geoserver_response(request: httpx2.Request) -> httpx2.Response:
        geoserver_requests.append(request)
        return httpx2.Response(500)

    response = TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(catalog_response),
            geoserver_transport=httpx2.MockTransport(geoserver_response),
        )
    ).post(
        "/api/rendering/layers",
        json={
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": TEST_GEOTIFF_ITEM_ID,
        },
    )

    assert response.status_code == 502
    assert geoserver_requests == []
















def test_pixel_probe_samples_nodata_and_outside_the_published_raster(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    version_file_path: Path,
) -> None:
    """Read one band-1 cell and distinguish nodata from out-of-bounds."""
    source_path = tmp_path / "raster.tif"
    with rasterio.open(
        source_path,
        "w",
        driver="GTiff",
        width=2,
        height=2,
        count=1,
        dtype="uint8",
        nodata=255,
        crs="EPSG:3857",
        transform=from_origin(-100_000, 100_000, 100_000, 100_000),
    ) as dataset:
        dataset.write(
            numpy.array([[12, 255], [34, 56]], dtype="uint8"),
            1,
        )
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(tmp_path))
    monkeypatch.setenv("SCAN_PATHS_WITHIN_MOUNT", '["."]')
    item = _mounted_geotiff_item(source_path.as_uri())

    def upstream_response(request: httpx2.Request) -> httpx2.Response:
        if request.url.host == "stac-api":
            return httpx2.Response(200, json=item)
        if request.url.path.endswith("/external.geotiff"):
            return httpx2.Response(201)
        if request.url.path.endswith(f"/{TEST_GEOTIFF_ITEM_ID}.xml"):
            return httpx2.Response(200)
        raise AssertionError(f"Unexpected upstream request: {request}")

    request_identity = {
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": TEST_GEOTIFF_ITEM_ID,
    }
    with TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(upstream_response),
            geoserver_transport=httpx2.MockTransport(upstream_response),
        )
    ) as client:
        assert client.post(
            "/api/rendering/layers",
            json=request_identity,
        ).status_code == 200
        value_response = client.post(
            "/api/rendering/pixels",
            json={**request_identity, "longitude": -0.5, "latitude": 0.5},
        )
        nodata_response = client.post(
            "/api/rendering/pixels",
            json={**request_identity, "longitude": 0.5, "latitude": 0.5},
        )
        outside_response = client.post(
            "/api/rendering/pixels",
            json={**request_identity, "longitude": 10, "latitude": 10},
        )

    assert value_response.status_code == 200
    assert value_response.json() == {
        "longitude": -0.5,
        "latitude": 0.5,
        "row": 0,
        "column": 0,
        "inBounds": True,
        "value": 12.0,
    }
    assert nodata_response.json() == {
        "longitude": 0.5,
        "latitude": 0.5,
        "row": 0,
        "column": 1,
        "inBounds": True,
        "value": None,
    }
    assert outside_response.json() == {
        "longitude": 10.0,
        "latitude": 10.0,
        "row": None,
        "column": None,
        "inBounds": False,
        "value": None,
    }


def test_raster_statistics_sample_a_published_projected_raster(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    version_file_path: Path,
) -> None:
    """Transform, clip, and summarize a WGS 84 area in a projected raster."""
    source_path = tmp_path / "projected.tif"
    with rasterio.open(
        source_path,
        "w",
        driver="GTiff",
        width=2,
        height=2,
        count=1,
        dtype="int16",
        crs="EPSG:3857",
        transform=from_origin(-100_000, 100_000, 100_000, 100_000),
    ) as dataset:
        dataset.write(
            numpy.array([[10, 20], [30, 40]], dtype="int16"),
            1,
        )
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(tmp_path))
    monkeypatch.setenv("SCAN_PATHS_WITHIN_MOUNT", '["."]')
    item = _mounted_geotiff_item(source_path.as_uri())

    def upstream_response(request: httpx2.Request) -> httpx2.Response:
        if request.url.host == "stac-api":
            return httpx2.Response(200, json=item)
        if request.url.path.endswith("/external.geotiff"):
            return httpx2.Response(201)
        if request.url.path.endswith(f"/{TEST_GEOTIFF_ITEM_ID}.xml"):
            return httpx2.Response(200)
        raise AssertionError(f"Unexpected upstream request: {request}")

    request_identity = {
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": TEST_GEOTIFF_ITEM_ID,
    }
    with TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(upstream_response),
            geoserver_transport=httpx2.MockTransport(upstream_response),
        )
    ) as client:
        assert client.post(
            "/api/rendering/layers",
            json=request_identity,
        ).status_code == 200
        response = client.post(
            "/api/rendering/statistics",
            json=request_identity,
        )
        selected_response = client.post(
            "/api/rendering/statistics",
            json={
                **request_identity,
                "selectedBounds": {
                    "west": -2,
                    "south": -2,
                    "east": 0,
                    "north": 2,
                },
            },
        )
        outside_response = client.post(
            "/api/rendering/statistics",
            json={
                **request_identity,
                "selectedBounds": {
                    "west": 10,
                    "south": 10,
                    "east": 11,
                    "north": 11,
                },
            },
        )

    assert response.status_code == 200
    response_document = response.json()
    assert response_document == {
        "band": 1,
        "scope": "wholeRaster",
        "selectedBounds": None,
        "sourceWidth": 2,
        "sourceHeight": 2,
        "sourcePixelCount": 4,
        "sampleWidth": 2,
        "sampleHeight": 2,
        "sampledPixelCount": 4,
        "validSampleCount": 4,
        "estimated": False,
        "sampleMinimum": 10.0,
        "sampleMaximum": 40.0,
        "percentiles": {"p05": 11.5, "p50": 25.0, "p95": 38.5},
        "histogram": response_document["histogram"],
        "suggestedRange": {
            "minimum": 11.5,
            "midpoint": 25.0,
            "maximum": 38.5,
        },
    }
    assert len(response_document["histogram"]["counts"]) == 64
    assert len(response_document["histogram"]["edges"]) == 65
    assert sum(response_document["histogram"]["counts"]) == 4

    assert selected_response.status_code == 200
    selected_document = selected_response.json()
    assert selected_document == {
        "band": 1,
        "scope": "selectedArea",
        "selectedBounds": {
            "west": -2.0,
            "south": -2.0,
            "east": 0.0,
            "north": 2.0,
        },
        "sourceWidth": 1,
        "sourceHeight": 2,
        "sourcePixelCount": 2,
        "sampleWidth": 1,
        "sampleHeight": 2,
        "sampledPixelCount": 2,
        "validSampleCount": 2,
        "estimated": False,
        "sampleMinimum": 10.0,
        "sampleMaximum": 30.0,
        "percentiles": {"p05": 11.0, "p50": 20.0, "p95": 29.0},
        "histogram": selected_document["histogram"],
        "suggestedRange": {
            "minimum": 11.0,
            "midpoint": 20.0,
            "maximum": 29.0,
        },
    }
    assert sum(selected_document["histogram"]["counts"]) == 2

    assert outside_response.status_code == 409
    assert outside_response.json() == {
        "detail": "The selected area does not overlap the raster"
    }


def test_raster_statistics_disconnect_cancels_the_service_waiter(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    version_file_path: Path,
) -> None:
    """Discard queued statistics work when an aborted fetch disconnects."""

    class BlockingStatisticsService:
        def __init__(self) -> None:
            self.started = asyncio.Event()
            self.canceled = asyncio.Event()

        async def get(self, _request: object) -> None:
            self.started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                self.canceled.set()
                raise

    statistics_service = BlockingStatisticsService()
    monkeypatch.setattr(
        "eolab_app.main.RasterStatisticsService",
        lambda _registry, _read_concurrency, _cache_entries: statistics_service,
    )
    application = create_app(version_file_path)
    request_body = json.dumps(
        {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": TEST_GEOTIFF_ITEM_ID,
        }
    ).encode()
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/api/rendering/statistics",
        "raw_path": b"/api/rendering/statistics",
        "query_string": b"",
        "headers": [
            (b"host", b"testserver"),
            (b"content-type", b"application/json"),
            (b"content-length", str(len(request_body)).encode()),
        ],
        "client": ("127.0.0.1", 12345),
        "server": ("testserver", 80),
        "root_path": "",
        "state": {},
    }

    async def exercise_disconnect() -> list[dict[str, object]]:
        request_messages: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        await request_messages.put(
            {
                "type": "http.request",
                "body": request_body,
                "more_body": False,
            }
        )
        response_messages: list[dict[str, object]] = []

        async def receive() -> dict[str, object]:
            return await request_messages.get()

        async def send(message: dict[str, object]) -> None:
            response_messages.append(message)

        async with application.router.lifespan_context(application):
            request_task = asyncio.create_task(
                application(scope, receive, send)
            )
            await asyncio.wait_for(statistics_service.started.wait(), 1)
            await request_messages.put({"type": "http.disconnect"})
            await asyncio.wait_for(request_task, 1)
        return response_messages

    response_messages = asyncio.run(exercise_disconnect())

    assert statistics_service.canceled.is_set()
    assert next(
        message["status"]
        for message in response_messages
        if message["type"] == "http.response.start"
    ) == 499


@pytest.mark.parametrize(
    ("request_body", "expected_status"),
    (
        (
            {
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": TEST_GEOTIFF_ITEM_ID,
            },
            400,
        ),
        (
            {
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": TEST_GEOTIFF_ITEM_ID,
                "href": "file:///etc/passwd",
            },
            422,
        ),
        (
            {
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": TEST_GEOTIFF_ITEM_ID,
                "selectedBounds": {
                    "west": 170,
                    "south": -10,
                    "east": -170,
                    "north": 10,
                },
            },
            422,
        ),
        (
            {
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": TEST_GEOTIFF_ITEM_ID,
                "selectedBounds": {
                    "west": -10,
                    "south": 5,
                    "east": 10,
                    "north": 5,
                },
            },
            422,
        ),
        (
            {
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": TEST_GEOTIFF_ITEM_ID,
                "histogramBins": 1_000_000,
            },
            422,
        ),
    ),
)
def test_raster_statistics_require_the_published_identity_contract(
    configured_environment: None,
    version_file_path: Path,
    request_body: dict[str, object],
    expected_status: int,
) -> None:
    """Reject unpublished raster identities and every browser-supplied path."""
    response = TestClient(create_app(version_file_path)).post(
        "/api/rendering/statistics",
        json=request_body,
    )

    assert response.status_code == expected_status


def test_pixel_probe_requires_an_approved_current_raster(
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Reject a valid Item identity until this app process publishes it."""
    response = TestClient(create_app(version_file_path)).post(
        "/api/rendering/pixels",
        json={
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": TEST_GEOTIFF_ITEM_ID,
            "longitude": -123,
            "latitude": 48,
        },
    )

    assert response.status_code == 400
    assert response.json() == {
        "detail": "The WMS layer has not been approved for visualization"
    }


@pytest.mark.parametrize(
    "request_body",
    (
        {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": TEST_GEOTIFF_ITEM_ID,
            "longitude": 181,
            "latitude": 0,
        },
        {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": TEST_GEOTIFF_ITEM_ID,
            "longitude": 0,
            "latitude": -91,
        },
        {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": TEST_GEOTIFF_ITEM_ID,
            "longitude": "0",
            "latitude": 0,
        },
        {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": TEST_GEOTIFF_ITEM_ID,
            "longitude": 0,
            "latitude": 0,
            "href": "file:///etc/passwd",
        },
        {
            "collectionId": "eolab-mounted-vectors",
            "itemId": TEST_GEOTIFF_ITEM_ID,
            "longitude": 0,
            "latitude": 0,
        },
    ),
)
def test_pixel_probe_rejects_input_outside_its_public_contract(
    configured_environment: None,
    version_file_path: Path,
    request_body: dict[str, object],
) -> None:
    """Accept only mounted-raster identity and finite WGS 84 coordinates."""
    response = TestClient(create_app(version_file_path)).post(
        "/api/rendering/pixels",
        json=request_body,
    )

    assert response.status_code == 422










def test_load_settings_requires_complete_environment(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    version_file_path: Path,
) -> None:
    """Reject a deployment that omits a contracted environment variable."""
    monkeypatch.delenv("APP_TITLE")

    with pytest.raises(KeyError, match="APP_TITLE"):
        load_settings(version_file_path)


def test_load_settings_requires_version_file(
    configured_environment: None,
    tmp_path: Path,
) -> None:
    """Reject a deployment without its baked Git-derived version file."""
    with pytest.raises(FileNotFoundError):
        load_settings(tmp_path / "missing-version")


def test_load_settings_rejects_blank_version(
    configured_environment: None,
    tmp_path: Path,
) -> None:
    """Reject a deployment whose baked version file is blank."""
    blank_version_path = tmp_path / "version"
    blank_version_path.write_text("  \n", encoding="utf-8")

    with pytest.raises(ValueError, match="application version"):
        load_settings(blank_version_path)


@pytest.mark.parametrize(
    ("environment_variable_name", "invalid_value"),
    (
        ("INITIAL_ZOOM", "not-a-number"),
        ("SCAN_WORKER_COUNT", "1.5"),
        ("SCAN_WRITER_COUNT", "1.5"),
        ("SCAN_BATCH_SIZE", "1.5"),
        ("SCAN_ERROR_DETAIL_LIMIT", "1.5"),
        ("SCAN_RECONCILIATION_PAGE_SIZE", "1.5"),
        ("SCAN_RECONCILIATION_CONCURRENCY", "1.5"),
        ("SCAN_RECONCILIATION_SPOOL_MEMORY_BYTES", "1.5"),
        ("SCAN_CATALOG_ERROR_DETAIL_LIMIT", "1.5"),
        ("GEOSERVER_WMS_RENDER_COUNT", "1.5"),
        ("RASTER_PIXEL_READ_CONCURRENCY", "1.5"),
        ("RASTER_STATISTICS_READ_CONCURRENCY", "1.5"),
        ("RASTER_STATISTICS_CACHE_ENTRIES", "1.5"),
    ),
)
def test_load_settings_rejects_malformed_number(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    environment_variable_name: str,
    invalid_value: str,
    version_file_path: Path,
) -> None:
    """Reject a numeric setting that cannot be parsed as a number."""
    monkeypatch.setenv(environment_variable_name, invalid_value)

    with pytest.raises(ValueError):
        load_settings(version_file_path)


def test_load_settings_requires_an_existing_absolute_scan_directory(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    version_file_path: Path,
) -> None:
    """Reject a missing or relative internal scan mount."""
    monkeypatch.setenv("SCAN_MOUNT_PATH", "relative/path")
    with pytest.raises(ValueError, match="absolute path"):
        load_settings(version_file_path)

    monkeypatch.setenv(
        "SCAN_MOUNT_PATH",
        str((Path.cwd() / "missing-scan-directory").resolve()),
    )
    with pytest.raises(ValueError, match="existing directory"):
        load_settings(version_file_path)


def test_load_settings_rejects_invalid_scan_path_lists(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    version_file_path: Path,
) -> None:
    """Reject malformed, escaping, missing, duplicate, or overlapping paths."""
    (tmp_path / "first" / "nested").mkdir(parents=True)
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(tmp_path))

    monkeypatch.setenv("SCAN_PATHS_WITHIN_MOUNT", "not JSON")
    with pytest.raises(ValueError):
        load_settings(version_file_path)

    invalid_path_lists = (
        ('"first"', "JSON array"),
        ("[]", "at least one"),
        (json.dumps([str(tmp_path / "first")]), "relative"),
        ('["../outside"]', "must not contain"),
        ('["missing"]', "existing directories"),
        ('["first", "first"]', "duplicated"),
        ('["first", "first/nested"]', "overlap"),
    )
    for scan_paths, expected_error in invalid_path_lists:
        monkeypatch.setenv("SCAN_PATHS_WITHIN_MOUNT", scan_paths)
        with pytest.raises(ValueError, match=expected_error):
            load_settings(version_file_path)


@pytest.mark.parametrize(
    ("environment_variable_name", "invalid_value"),
    (
        ("INITIAL_LATITUDE", "91"),
        ("INITIAL_LONGITUDE", "-181"),
        ("INITIAL_ZOOM", "23"),
        ("SCAN_WORKER_COUNT", "0"),
        ("SCAN_WRITER_COUNT", "0"),
        ("SCAN_BATCH_SIZE", "0"),
        ("SCAN_ERROR_DETAIL_LIMIT", "0"),
        ("SCAN_RECONCILIATION_PAGE_SIZE", "0"),
        ("SCAN_RECONCILIATION_CONCURRENCY", "0"),
        ("SCAN_RECONCILIATION_SPOOL_MEMORY_BYTES", "0"),
        ("SCAN_CATALOG_WRITE_TIMEOUT_SECONDS", "0"),
        ("SCAN_CATALOG_WRITE_TIMEOUT_SECONDS", "nan"),
        ("SCAN_CATALOG_ERROR_DETAIL_LIMIT", "0"),
        ("GEOSERVER_WMS_RENDER_COUNT", "0"),
        ("RASTER_PIXEL_READ_CONCURRENCY", "0"),
        ("RASTER_STATISTICS_READ_CONCURRENCY", "0"),
        ("RASTER_STATISTICS_CACHE_ENTRIES", "0"),
    ),
)
def test_load_settings_rejects_out_of_range_number(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    environment_variable_name: str,
    invalid_value: str,
    version_file_path: Path,
) -> None:
    """Reject a numeric setting outside its documented range."""
    monkeypatch.setenv(environment_variable_name, invalid_value)

    with pytest.raises(ValueError, match=environment_variable_name):
        load_settings(version_file_path)
