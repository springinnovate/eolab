"""Test the EOLab application and its runtime settings contract."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from eolab_app.main import create_app
from eolab_app.settings import load_settings


DEFAULT_ENVIRONMENT = {
    "EOLAB_APP_TITLE": "EOLab",
    "EOLAB_APP_SUBTITLE": "Explore, process, and visualize geospatial data",
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
    monkeypatch.setenv("EOLAB_APP_TITLE", "WWF EOLab")
    monkeypatch.setenv("EOLAB_CATALOG_URL", "https://catalog.example.test")

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


def test_load_settings_requires_complete_environment(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    version_file_path: Path,
) -> None:
    """Reject a deployment that omits a contracted environment variable."""
    monkeypatch.delenv("EOLAB_APP_TITLE")

    with pytest.raises(KeyError, match="EOLAB_APP_TITLE"):
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
    monkeypatch.setenv("EOLAB_INITIAL_ZOOM", "not-a-number")

    with pytest.raises(ValueError):
        load_settings(version_file_path)


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
    version_file_path: Path,
) -> None:
    """Reject a numeric setting outside its documented range."""
    monkeypatch.setenv(environment_variable_name, invalid_value)

    with pytest.raises(ValueError, match=environment_variable_name):
        load_settings(version_file_path)
