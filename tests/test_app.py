"""Test the EOLab application and its runtime settings contract."""

import asyncio
import base64
import json
from pathlib import Path
from unittest.mock import AsyncMock

import httpx2
import psycopg
import pytest
import rasterio
from fastapi.testclient import TestClient
from rasterio.transform import from_origin

from eolab_app.geotiff import build_stac_item as build_geotiff_stac_item
from eolab_app.main import _number_matched_is_estimated, create_app
from eolab_app.settings import load_settings


DEFAULT_ENVIRONMENT = {
    "APP_TITLE": "EOLab",
    "APP_SUBTITLE": "Explore, process, and visualize geospatial data",
    "CATALOG_URL": "/stac",
    "CATALOG_INTERNAL_URL": "http://stac-api:8080",
    "WMS_URL": "/geoserver/eolab/wms",
    "GEOSERVER_INTERNAL_URL": "http://geoserver:8080/geoserver",
    "GEOSERVER_ADMIN_USER": "eolab",
    "GEOSERVER_ADMIN_PASSWORD": "valid-admin-password",
    "SCAN_MOUNT_PATH": str(Path.cwd()),
    "SCAN_PATHS_WITHIN_MOUNT": '["."]',
    "SCAN_DISPLAY_PATH_PREFIX": "bigboi -- Z:\\bigbucket",
    "SCAN_WORKER_COUNT": "8",
    "SCAN_WRITER_COUNT": "4",
    "SCAN_BATCH_SIZE": "100",
    "BASEMAP_URL": "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    "BASEMAP_ATTRIBUTION": "&copy; OpenStreetMap contributors",
    "INITIAL_LATITUDE": "20",
    "INITIAL_LONGITUDE": "0",
    "INITIAL_ZOOM": "2",
}
TEST_GEOTIFF_ITEM_ID = "geotiff-0123456789abcdef01234567"


def _mounted_geotiff_item(
    asset_href: str,
    asset_media_type: str = "image/tiff; application=geotiff",
) -> dict[str, object]:
    """Build the scanner-owned STAC Item contract used by rendering tests."""
    return {
        "type": "Feature",
        "id": TEST_GEOTIFF_ITEM_ID,
        "collection": "eolab-mounted-geotiffs",
        "bbox": [-123.0, 48.0, -122.0, 49.0],
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                [
                    [-123.0, 48.0],
                    [-122.0, 48.0],
                    [-122.0, 49.0],
                    [-123.0, 49.0],
                    [-123.0, 48.0],
                ]
            ],
        },
        "properties": {"datetime": "2025-01-01T00:00:00Z"},
        "assets": {
            "data": {
                "href": asset_href,
                "type": asset_media_type,
                "roles": ["data"],
                "eolab:rendering": {
                    "policy": "raster-v1",
                    "eligible": True,
                    "bounded_blocks": True,
                    "block_shapes": [[1, 1]],
                    "overview_factors": [[]],
                    "overview_storage": "none",
                    "compression": None,
                    "estimated_uncompressed_bytes": 1,
                },
            }
        },
    }


def _write_geotiff(path: Path) -> None:
    """Create a minimal GeoTIFF whose current structure can be reassessed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=1,
        height=1,
        count=1,
        dtype="uint8",
        crs="EPSG:4326",
        transform=from_origin(-123, 49, 1, 1),
    ):
        pass


@pytest.fixture
def configured_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Set the complete default deployment environment for a test."""
    for environment_variable_name, environment_variable_value in DEFAULT_ENVIRONMENT.items():
        monkeypatch.setenv(environment_variable_name, environment_variable_value)


@pytest.fixture
def version_file_path(tmp_path: Path) -> Path:
    """Create a representative Git-derived application version file."""
    version_path = tmp_path / "version"
    version_path.write_text("0.1.0-2-gabcdef0\n", encoding="utf-8")
    return version_path


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
        "appSubtitle": "Explore, process, and visualize geospatial data",
        "appVersion": "0.1.0-2-gabcdef0",
        "catalogUrl": "https://catalog.example.test",
        "wmsUrl": "/geoserver/eolab/wms",
        "scanDisplayPathPrefix": "bigboi -- Z:\\bigbucket",
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
    assert "valid-admin-password" not in repr(load_settings(version_file_path))


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
    assert response.json()["timing"] == {
        "elapsedSeconds": 0.0,
        "catalogInventorySeconds": 0.0,
        "discoverySeconds": 0.0,
        "metadataResultWaitSeconds": 0.0,
        "metadataWorkerSeconds": 0.0,
        "metadataProcessingSeconds": 0.0,
        "metadataIoWaitSeconds": 0.0,
        "catalogWriteSeconds": 0.0,
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


def test_one_legacy_raster_is_assessed_and_updated(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    version_file_path: Path,
) -> None:
    """Backfill one selected Item without scanning the mounted directory."""
    source_path = tmp_path / "raster.tif"
    _write_geotiff(source_path)
    current_item = build_geotiff_stac_item(tmp_path, source_path)
    item_id = current_item["id"]
    del current_item["assets"]["data"]["eolab:rendering"]
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

    with TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(catalog_response),
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
        "policy": "raster-v1",
        "eligible": True,
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
                "policy": "raster-v1",
                "eligible": False,
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
    """Refuse a source that became unsuitable after its catalog scan."""
    source_path = tmp_path / "raster.tif"
    _write_geotiff(source_path)
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(tmp_path))
    monkeypatch.setenv("SCAN_PATHS_WITHIN_MOUNT", '["."]')
    item = _mounted_geotiff_item(source_path.as_uri())
    geoserver_requests = []
    monkeypatch.setattr(
        "eolab_app.rendering.inspect_geotiff_renderability",
        lambda _: {
            "eligible": False,
            "reason": (
                "Visualization unavailable: this raster needs a complete "
                "internal overview pyramid."
            ),
        },
    )

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
            "Visualization unavailable: this raster needs a complete "
            "internal overview pyramid."
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


def test_stac_proxy_forwards_public_read_request(
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Expose an internal STAC response through the public catalog path."""

    def catalog_response(request: httpx2.Request) -> httpx2.Response:
        assert str(request.url) == "http://stac-api:8080/collections?limit=4"
        assert request.headers["x-forwarded-host"] == "testserver"
        assert request.headers["x-forwarded-proto"] == "http"
        return httpx2.Response(
            200,
            json={"collections": []},
            headers={"Content-Type": "application/json"},
        )

    response = TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(catalog_response),
        )
    ).get("/stac/collections?limit=4")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    assert response.json() == {"collections": []}


def test_stac_proxy_forwards_item_search(
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Forward standard POST Item Search without exposing write endpoints."""

    async def number_matched_is_estimated(
        search_request_body: bytes,
        number_matched: int,
    ) -> bool:
        assert json.loads(search_request_body) == {
            "limit": 20,
            "filter-lang": "cql2-json",
            "filter": {
                "op": "like",
                "args": [{"property": "title"}, "%2004%"],
            },
        }
        assert number_matched == 106967
        return True

    def catalog_response(request: httpx2.Request) -> httpx2.Response:
        assert request.method == "POST"
        assert str(request.url) == "http://stac-api:8080/search"
        assert json.loads(request.content) == {
            "limit": 20,
            "filter-lang": "cql2-json",
            "filter": {
                "op": "like",
                "args": [{"property": "title"}, "%2004%"],
            },
        }
        return httpx2.Response(
            200,
            json={
                "type": "FeatureCollection",
                "features": [],
                "numberMatched": 106967,
            },
            headers={"Content-Type": "application/geo+json"},
        )

    response = TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(catalog_response),
            number_matched_estimate_lookup=number_matched_is_estimated,
        )
    ).post(
        "/stac/search",
        json={
            "limit": 20,
            "filter-lang": "cql2-json",
            "filter": {
                "op": "like",
                "args": [{"property": "title"}, "%2004%"],
            },
        },
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/geo+json"
    assert response.headers["x-eolab-number-matched-estimated"] == "true"
    assert response.json() == {
        "type": "FeatureCollection",
        "features": [],
        "numberMatched": 106967,
    }


def test_count_estimate_lookup_uses_pgstac_search_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Resolve pgSTAC functions called without schema-qualified names."""
    cursor = AsyncMock()
    cursor.fetchone.return_value = (True,)
    connection = AsyncMock()
    connection.__aenter__.return_value = connection
    connection.execute.return_value = cursor
    connect = AsyncMock(return_value=connection)
    monkeypatch.setattr(psycopg.AsyncConnection, "connect", connect)

    assert asyncio.run(
        _number_matched_is_estimated(b'{"limit": 20}', 106967)
    )
    connect.assert_awaited_once_with(options="-c search_path=pgstac,public")


def test_stac_proxy_rejects_catalog_writes(
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Keep STAC transaction routes private to the Compose network."""
    response = TestClient(create_app(version_file_path)).post(
        "/stac/collections",
        json={"id": "not-allowed"},
    )

    assert response.status_code == 405
    assert response.json() == {
        "detail": "Only STAC Item Search accepts POST requests"
    }


def test_stac_proxy_reports_unavailable_catalog(
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Report catalog connectivity failure without failing application startup."""

    def unavailable_catalog(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("catalog unavailable", request=request)

    response = TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(unavailable_catalog),
        )
    ).get("/stac")

    assert response.status_code == 502
    assert response.json() == {
        "detail": "The STAC catalog service is unavailable"
    }


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
        return httpx2.Response(
            200,
            content=b"png bytes",
            headers={"Content-Type": "image/png"},
        )

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
        tile_url = (
            "/geoserver/eolab/wms"
            "?service=WMS&version=1.3.0&request=GetMap"
            f"&layers=eolab%3A{TEST_GEOTIFF_ITEM_ID}"
            "&styles=dynamic-raster&crs=EPSG%3A3857"
            "&bbox=0%2C0%2C1%2C1&width=256&height=256"
            "&format=image%2Fpng&transparent=true"
        )
        response = client.get(tile_url)
        source_path.write_bytes(b"replacement")
        changed_source_response = client.get(tile_url)

    assert publication_response.status_code == 200
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.content == b"png bytes"
    assert len(wms_requests) == 1
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
