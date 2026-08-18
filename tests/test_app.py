"""Test the EOLab application and its runtime settings contract."""

import pytest
from fastapi.testclient import TestClient

from eolab_app.main import create_app
from eolab_app.settings import load_settings


DEFAULT_ENVIRONMENT = {
    "EOLAB_APP_TITLE": "EOLab",
    "EOLAB_APP_SUBTITLE": "Explore, process, and visualize geospatial data",
    "EOLAB_APP_VERSION": "dev",
    "EOLAB_CATALOG_URL": "",
    "EOLAB_BASEMAP_URL": "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    "EOLAB_BASEMAP_ATTRIBUTION": "&copy; OpenStreetMap contributors",
    "EOLAB_INITIAL_LATITUDE": "20",
    "EOLAB_INITIAL_LONGITUDE": "0",
    "EOLAB_INITIAL_ZOOM": "2",
}


@pytest.fixture
def configured_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Set the complete default deployment environment for a test."""
    for environment_variable_name, environment_variable_value in DEFAULT_ENVIRONMENT.items():
        monkeypatch.setenv(environment_variable_name, environment_variable_value)


def test_healthz(configured_environment: None) -> None:
    """Report liveness using the configured application version."""
    response = TestClient(create_app()).get("/healthz")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "eolab",
        "version": "dev",
    }


def test_configuration_endpoint_reads_environment(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Expose the deployment environment through the public configuration."""
    monkeypatch.setenv("EOLAB_APP_TITLE", "WWF EOLab")
    monkeypatch.setenv("EOLAB_CATALOG_URL", "https://catalog.example.test")

    response = TestClient(create_app()).get("/api/config")

    assert response.status_code == 200
    assert response.json() == {
        "appTitle": "WWF EOLab",
        "appSubtitle": "Explore, process, and visualize geospatial data",
        "appVersion": "dev",
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


def test_load_settings_requires_complete_environment(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reject a deployment that omits a contracted environment variable."""
    monkeypatch.delenv("EOLAB_APP_TITLE")

    with pytest.raises(KeyError, match="EOLAB_APP_TITLE"):
        load_settings()


def test_load_settings_rejects_malformed_number(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reject a numeric setting that cannot be parsed as a number."""
    monkeypatch.setenv("EOLAB_INITIAL_ZOOM", "not-a-number")

    with pytest.raises(ValueError):
        load_settings()


@pytest.mark.parametrize(
    ("environment_variable_name", "invalid_value"),
    (
        ("EOLAB_INITIAL_LATITUDE", "91"),
        ("EOLAB_INITIAL_LONGITUDE", "-181"),
        ("EOLAB_INITIAL_ZOOM", "23"),
    ),
)
def test_load_settings_rejects_out_of_range_number(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    environment_variable_name: str,
    invalid_value: str,
) -> None:
    """Reject a numeric setting outside its documented range."""
    monkeypatch.setenv(environment_variable_name, invalid_value)

    with pytest.raises(ValueError, match=environment_variable_name):
        load_settings()
