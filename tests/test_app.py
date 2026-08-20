"""Test the EOLab application and its runtime settings contract."""

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock

import httpx2
import psycopg
import pytest
from fastapi.testclient import TestClient

from eolab_app.main import _number_matched_is_estimated, create_app
from eolab_app.settings import load_settings


DEFAULT_ENVIRONMENT = {
    "APP_TITLE": "EOLab",
    "APP_SUBTITLE": "Explore, process, and visualize geospatial data",
    "CATALOG_URL": "/stac",
    "CATALOG_INTERNAL_URL": "http://stac-api:8080",
    "SCAN_MOUNT_PATH": str(Path.cwd()),
    "SCAN_PATHS_WITHIN_MOUNT": '["."]',
    "SCAN_DISPLAY_PATH_PREFIX": "bigboi -- Z:\\bigbucket",
    "SCAN_WORKER_COUNT": "8",
    "SCAN_BATCH_SIZE": "100",
    "BASEMAP_URL": "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    "BASEMAP_ATTRIBUTION": "&copy; OpenStreetMap contributors",
    "INITIAL_LATITUDE": "20",
    "INITIAL_LONGITUDE": "0",
    "INITIAL_ZOOM": "2",
}


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
