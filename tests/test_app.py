"""Test the EOLab application and its runtime settings contract."""

import json
from pathlib import Path

import httpx2
import pytest
from fastapi.testclient import TestClient

from eolab_app.main import create_app
from eolab_app.settings import load_settings


DEFAULT_ENVIRONMENT = {
    "APP_TITLE": "EOLab",
    "APP_SUBTITLE": "Explore, process, and visualize geospatial data",
    "CATALOG_URL": "/stac",
    "CATALOG_INTERNAL_URL": "http://stac-api:8080",
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

    def catalog_response(request: httpx2.Request) -> httpx2.Response:
        assert request.method == "POST"
        assert str(request.url) == "http://stac-api:8080/search"
        assert json.loads(request.content) == {"limit": 20}
        return httpx2.Response(
            200,
            json={"type": "FeatureCollection", "features": []},
            headers={"Content-Type": "application/geo+json"},
        )

    response = TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(catalog_response),
        )
    ).post("/stac/search", json={"limit": 20})

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/geo+json"
    assert response.json() == {"type": "FeatureCollection", "features": []}


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


def test_load_settings_rejects_malformed_number(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    version_file_path: Path,
) -> None:
    """Reject a numeric setting that cannot be parsed as a number."""
    monkeypatch.setenv("INITIAL_ZOOM", "not-a-number")

    with pytest.raises(ValueError):
        load_settings(version_file_path)


@pytest.mark.parametrize(
    ("environment_variable_name", "invalid_value"),
    (
        ("INITIAL_LATITUDE", "91"),
        ("INITIAL_LONGITUDE", "-181"),
        ("INITIAL_ZOOM", "23"),
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
