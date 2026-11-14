"""Keep download measurements accurate from acquisition through the admin API."""

from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock

from nhi_terrestrial_integrity_modeling.analysis_config import RasterStackConfiguration
import pytest
from shapely.geometry import box, mapping

from eolab_app.processing import habitat_earth_engine, habitat_preparation
from eolab_app.processing.artifacts import LocalJobArtifacts
from eolab_app.processing.habitat_earth_engine import (
    HabitatEarthEngineRuntime,
    HabitatEarthEngineSettings,
    get_habitat_tiles,
)
from eolab_app.processing.habitat_preparation import HabitatPreparationSources
from eolab_app.processing.habitat_preparation_models import (
    HabitatInputPreparationInputs,
    HabitatInputPreparationSpec,
)
from eolab_app.processing.service import ProcessingService
from test_habitat_earth_engine import _tile_bytes, _use_offline_earth_engine, stack
from test_habitat_preparation_admin import BASE, BODY, IDENTIFIER, PASSWORD, _client


def test_cached_failed_and_downloaded_tiles_reach_admin_with_distinct_measurements(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stack: RasterStackConfiguration
) -> None:
    """Persist only successful download throughput and expose it without private paths.

    Args:
        tmp_path: Isolated cache and ordinary Processing artifact storage.
        monkeypatch: Replace provider responses, polygon reading and elapsed time.
        stack: Small scientific grid with original Habitat band definitions.
    """
    artifacts = LocalJobArtifacts(tmp_path / "processing")
    artifacts.initialize()
    settings = HabitatEarthEngineSettings("test-project", tmp_path / "key.json")
    cache = tmp_path / "cache"
    _use_offline_earth_engine(monkeypatch, [({"status": "200"}, _tile_bytes(7, 31))])
    get_habitat_tiles(
        box(7, 11, 27, 31),
        stack,
        settings,
        cache_directory=cache,
        working_directory=artifacts.prepare("b" * 32),
        progress=Mock(),
        check_cancelled=Mock(),
    )
    responses = [_tile_bytes(47, 31), _tile_bytes(67, 31)]
    _use_offline_earth_engine(
        monkeypatch,
        [
            ({"status": "403"}, '{"error":{"code":403,"message":"Not available"}}'),
            *[({"status": "200"}, pixels) for pixels in responses],
        ],
    )
    monkeypatch.setattr(habitat_preparation, "load_habitat_stack", lambda year: stack)
    monkeypatch.setattr(
        habitat_preparation,
        "read_habitat_polygons",
        Mock(return_value=[mapping(box(7, 11, 87, 31))]),
    )
    monkeypatch.setattr(
        habitat_earth_engine, "monotonic", Mock(side_effect=[0, 0, 30, 60, 90])
    )
    inputs = HabitatInputPreparationInputs(
        **{
            key: value
            for key, value in BODY.items()
            if key not in {"requestId", "year"}
        },
        year=stack.year,
        configurationSha256=stack.raster_configuration_sha256,
    )
    attempt = "c" * 32
    directory = artifacts.prepare(attempt)
    result = habitat_preparation.prepare_habitat_input_cache(
        HabitatPreparationSources(Mock(), HabitatEarthEngineRuntime(settings, cache)),
        HabitatInputPreparationSpec(inputs=inputs),
        directory,
    )
    assert result.tile_count == 3 and result.failed_tile_count == 1
    progress = artifacts.progress(attempt)
    assert (progress["completed"], progress["total"]) == (3, 4)
    measured = progress["details"]
    assert measured["cachedTiles"] == 1
    assert measured["downloadedTiles"] == 2
    assert measured["failedTiles"] == 1
    assert measured["downloadedBytes"] == sum(map(len, responses))
    assert measured["elapsedSeconds"] == 90
    assert datetime.fromisoformat(measured["lastDownloadAt"]) <= datetime.fromisoformat(
        measured["observedAt"]
    )
    assert (directory / "progress.json").stat().st_size < 1024

    now = datetime.now(timezone.utc)
    jobs = Mock()
    jobs.get.return_value = {
        "id": IDENTIFIER,
        "operation": "habitat.prepare-inputs.v1",
        "status": "running",
        "created_at": now,
        "updated_at": now + timedelta(minutes=10),
        "expires_at": now + timedelta(days=1),
        "metadata_expires_at": None,
        "retained_metadata": {"inputs": inputs.model_dump(mode="json")},
        "artifact": None,
        "progress": progress,
        "error": None,
    }
    response = _client(ProcessingService(jobs, Mock(), model_registry=Mock())).get(
        f"{BASE}/{IDENTIFIER}", auth=("admin", PASSWORD)
    )
    assert response.status_code == 200
    exposed = response.json()["progress"]["details"]
    assert exposed["cachedTiles"] == 1 and exposed["downloadedTiles"] == 2
    assert datetime.fromisoformat(exposed["lastDownloadAt"]) == datetime.fromisoformat(
        measured["lastDownloadAt"]
    )
    assert response.headers["cache-control"] == "private, no-store"
    assert str(tmp_path) not in response.text and "test-project" not in response.text
