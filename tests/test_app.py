import pytest
from fastapi.testclient import TestClient

from eolab_app.main import app


client = TestClient(app)

EOLAB_ENVIRONMENT_VARIABLES = (
    "EOLAB_APP_TITLE",
    "EOLAB_APP_SUBTITLE",
    "EOLAB_APP_VERSION",
    "EOLAB_CATALOG_URL",
    "EOLAB_BASEMAP_URL",
    "EOLAB_BASEMAP_ATTRIBUTION",
    "EOLAB_INITIAL_LATITUDE",
    "EOLAB_INITIAL_LONGITUDE",
    "EOLAB_INITIAL_ZOOM",
)


@pytest.fixture(autouse=True)
def clear_eolab_environment(monkeypatch) -> None:
    for variable_name in EOLAB_ENVIRONMENT_VARIABLES:
        monkeypatch.delenv(variable_name, raising=False)


def test_healthz() -> None:
    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "eolab",
        "version": "dev",
    }


def test_config_has_safe_defaults() -> None:
    response = client.get("/api/config")

    assert response.status_code == 200
    assert response.json() == {
        "appTitle": "EOLab",
        "appSubtitle": "Catalog-driven Earth observation",
        "appVersion": "dev",
        "catalogUrl": None,
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


def test_config_reads_and_bounds_runtime_environment(monkeypatch) -> None:
    monkeypatch.setenv("EOLAB_APP_TITLE", "WWF EOLab")
    monkeypatch.setenv("EOLAB_CATALOG_URL", "https://catalog.example.test")
    monkeypatch.setenv("EOLAB_INITIAL_LATITUDE", "100")
    monkeypatch.setenv("EOLAB_INITIAL_LONGITUDE", "-200")
    monkeypatch.setenv("EOLAB_INITIAL_ZOOM", "30")

    response = client.get("/api/config")
    payload = response.json()

    assert response.status_code == 200
    assert payload["appTitle"] == "WWF EOLab"
    assert payload["catalogUrl"] == "https://catalog.example.test"
    assert payload["initialView"] == {
        "latitude": 90,
        "longitude": -180,
        "zoom": 22,
    }
