"""Read Habitat source choices without requiring an Earth Engine connection."""

from pathlib import Path
from unittest.mock import Mock

import ee
from fastapi.testclient import TestClient
import pytest

from eolab_app.main import create_app


def test_habitat_options_use_the_packaged_configuration_without_credentials(
    configured_environment: None,
    version_file_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Expose the original source choices through the composed application.

    Args:
        configured_environment: Application settings without a live deployment.
        version_file_path: File containing the application's test version.
        monkeypatch: Prevent credential loading and Earth Engine initialization.
    """
    monkeypatch.delenv("HABITAT_EARTH_ENGINE_PROJECT", raising=False)
    monkeypatch.delenv("HABITAT_EARTH_ENGINE_CREDENTIALS_FILE", raising=False)
    monkeypatch.setattr(
        ee, "Initialize", Mock(side_effect=AssertionError("No GEE initialization"))
    )
    monkeypatch.setattr(
        ee,
        "ServiceAccountCredentials",
        Mock(side_effect=AssertionError("No credential loading")),
    )

    with TestClient(create_app(version_file_path)) as client:
        response = client.get(
            "/api/processing/models/habitat-condition/earth-engine-options"
        )

    assert response.status_code == 200
    assert response.json() == {
        "defaultYear": 2018,
        "minimumYear": 2015,
        "maximumYear": 2019,
        "grid": {
            "crs": "EPSG:6933",
            "pixelSize": [500.0, 500.0],
            "origin": [0.0, 0.0],
            "unit": "metre",
            "approximate": False,
        },
    }
