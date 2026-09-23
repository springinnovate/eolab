"""Verify the public basemap configuration and optional tile providers."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from eolab_app.main import create_app
from eolab_app.settings import load_settings


@pytest.mark.parametrize("key", [None, "", "   "])
@pytest.mark.parametrize("variable", ["CARTO_BASEMAP_API_KEY", "MAPTILER_API_KEY"])
def test_unconfigured_optional_basemap_is_absent(
    configured_environment: None,
    version_file_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    key: str | None,
    variable: str,
) -> None:
    """Omit unconfigured providers while preserving the default tile configuration.

    Args:
        configured_environment: Baseline application environment.
        version_file_path: Test version file.
        monkeypatch: Environment overrides.
        key: Missing or blank optional provider key.
        variable: Provider environment variable to leave unconfigured.
    """
    if key is None:
        monkeypatch.delenv(variable, raising=False)
    else:
        monkeypatch.setenv(variable, key)
    response = TestClient(create_app(version_file_path)).get("/api/config")
    assert response.status_code == 200
    assert response.json()["basemap"] == {
        "url": "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        "attribution": "&copy; OpenStreetMap contributors",
    }


def test_carto_key_builds_attributed_browser_tile_url(
    configured_environment: None,
    version_file_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Encode the key as one query value and publish only provider configuration.

    Args:
        configured_environment: Baseline application environment.
        version_file_path: Test version file.
        monkeypatch: Environment overrides.
    """
    monkeypatch.setenv("CARTO_BASEMAP_API_KEY", "  test-key&other=unsafe/#  ")
    response = TestClient(create_app(version_file_path)).get("/api/config")
    assert response.status_code == 200
    basemap = response.json()["basemap"]
    carto = basemap["carto"]
    assert carto["url"] == (
        "https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png"
        "?key=test-key%26other%3Dunsafe%2F%23"
    )
    assert carto["maxNativeZoom"] == 20
    assert "openstreetmap.org/copyright" in carto["attribution"]
    assert "carto.com/attributions" in carto["attribution"]
    assert basemap["url"].startswith("https://{s}.tile.openstreetmap.org/")
    assert "test-key" not in repr(load_settings(version_file_path))


def test_maptiler_key_builds_attributed_satellite_url(
    configured_environment: None,
    version_file_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Publish optional satellite tiles with an encoded key and required credits.

    Args:
        configured_environment: Baseline application environment.
        version_file_path: Test version file.
        monkeypatch: Environment overrides.
    """
    monkeypatch.setenv("MAPTILER_API_KEY", "  satellite-key&other=unsafe/#  ")
    monkeypatch.setenv("CARTO_BASEMAP_API_KEY", "carto-key")
    response = TestClient(create_app(version_file_path)).get("/api/config")
    assert response.status_code == 200
    basemap = response.json()["basemap"]
    satellite = basemap["maptiler"]
    assert satellite["url"] == (
        "https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg"
        "?key=satellite-key%26other%3Dunsafe%2F%23"
    )
    assert satellite["maxNativeZoom"] == 22
    assert "www.maptiler.com/copyright/" in satellite["attribution"]
    assert "openstreetmap.org/copyright" in satellite["attribution"]
    assert "api.maptiler.com/resources/logo.svg" in satellite["attribution"]
    assert 'alt="MapTiler logo"' in satellite["attribution"]
    assert 'href="https://www.maptiler.com/"' in satellite["attribution"]
    assert "carto-key" in basemap["carto"]["url"]
    assert "satellite-key" not in repr(load_settings(version_file_path))
