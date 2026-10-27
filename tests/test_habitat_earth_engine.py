"""Download Habitat tiles through the official Earth Engine client without network access."""

from collections.abc import Iterator
from dataclasses import replace
from functools import partial
from importlib.resources import files
import io
import json
from pathlib import Path
from unittest.mock import Mock

import ee
from google.auth.exceptions import GoogleAuthError
from googleapiclient.http import HttpMockSequence
from nhi_terrestrial_integrity_modeling.analysis_config import RasterStackConfiguration
import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.io import MemoryFile
from rasterio.transform import from_origin
from shapely.geometry import MultiPolygon, box

from eolab_app.processing.habitat_earth_engine import (
    HabitatEarthEngineSettings,
    download_habitat_tiles,
    load_habitat_stack,
)
from eolab_app.raster.read_cancellation import RasterReadCancelled


@pytest.fixture
def stack() -> RasterStackConfiguration:
    """Use original reference, response and predictor bands on a tiny fixed grid.

    Returns:
        Packaged scientific settings with three bands and two-pixel test tiles.
    """
    original = load_habitat_stack(2019)
    return replace(
        original,
        bands=tuple(
            next(band for band in original.bands if band.role == role)
            for role in ("reference", "response", "predictor")
        ),
        grid=replace(
            original.grid,
            pixel_size_meters=10,
            tile_size_pixels=2,
            origin_x=7,
            origin_y=11,
        ),
    )


def _use_offline_earth_engine(
    monkeypatch: pytest.MonkeyPatch, responses: list[tuple[dict[str, str], bytes | str]]
) -> Mock:
    """Feed discovery metadata and pixel responses to the official HTTP client.

    Args:
        monkeypatch: Restore client initialization and credential loading afterward.
        responses: HTTP status headers and bodies for pixel requests.

    Returns:
        Spy recording HTTP requests handled by the in-memory transport.
    """
    metadata = files(ee).joinpath("tests")
    discovery = metadata.joinpath("cloud_api_discovery_document.json").read_text(
        encoding="utf-8"
    )
    algorithms = metadata.joinpath("algorithms.json").read_text(encoding="utf-8")
    transport = HttpMockSequence(
        [
            ({"status": "200"}, discovery),
            ({"status": "200"}, discovery),
            ({"status": "200"}, algorithms),
            *responses,
        ]
    )
    requests = Mock(wraps=transport.request)
    transport.request = requests
    ee.Reset()
    monkeypatch.setattr(ee, "ServiceAccountCredentials", Mock(return_value=None))
    monkeypatch.setattr(
        ee, "Initialize", partial(ee.Initialize, http_transport=transport)
    )
    monkeypatch.setattr(
        "urllib.request.urlopen", lambda *args, **kwargs: io.BytesIO(b"{}")
    )
    return requests


@pytest.fixture(autouse=True)
def reset_earth_engine() -> Iterator[None]:
    """Keep the process-global Earth Engine client isolated between tests.

    Yields:
        No value; reset the client after each test.
    """
    yield
    ee.Reset()


def _tile_bytes(left: float, top: float) -> bytes:
    """Create two float bands with valid zeros and different missing pixels.

    Args:
        left: Tile's western grid coordinate.
        top: Tile's northern grid coordinate.

    Returns:
        Complete GeoTIFF bytes in the original acquisition projection.
    """
    with MemoryFile() as memory:
        with memory.open(
            driver="GTiff",
            width=2,
            height=2,
            count=2,
            dtype="float32",
            crs="EPSG:6933",
            transform=from_origin(left, top, 10, 10),
            nodata=-9999,
        ) as dataset:
            dataset.write(
                np.array([[[0, -9999], [2, 3]], [[4, 0], [-9999, 7]]], dtype="float32")
            )
        return memory.read()


def test_download_preserves_grid_bands_and_missing_pixels(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stack: RasterStackConfiguration
) -> None:
    """Fetch only positive-area tiles and preserve each original band's pixels.

    Args:
        tmp_path: Existing private attempt directory.
        monkeypatch: Install the offline Earth Engine transport.
        stack: Original scientific definitions with a small acquisition grid.
    """
    requests = _use_offline_earth_engine(
        monkeypatch,
        [
            (dict(status="200"), _tile_bytes(7, 51)),
            (dict(status="200"), _tile_bytes(27, 31)),
        ],
    )
    progress = Mock()
    settings = HabitatEarthEngineSettings("habitat-test", tmp_path / "key.json")
    result = download_habitat_tiles(
        MultiPolygon([box(7, 31, 27, 51), box(27, 11, 47, 31)]),
        stack,
        settings,
        tmp_path,
        progress=progress,
        check_cancelled=Mock(),
    )
    names = stack.band_names()[1:]
    assert result.directory.parent == tmp_path
    assert len(result.tiles) == 2
    assert tuple(result.bands) == names
    assert tuple(result.bands.values()) == stack.bands[1:]
    assert [call.args for call in progress.call_args_list] == [(0, 2), (1, 2), (2, 2)]
    ee.ServiceAccountCredentials.assert_called_once_with(
        key_file=str(settings.credentials_file)
    )
    pixel_requests = [
        call
        for call in requests.call_args_list
        if "image:computePixels" in call.args[0]
    ]
    assert len(pixel_requests) == 2
    for path, call, (left, top) in zip(
        result.tiles, pixel_requests, [(7, 51), (27, 31)], strict=True
    ):
        assert path.parent == result.directory
        assert "/projects/habitat-test/image:computePixels" in call.args[0]
        request = json.loads(call.kwargs["body"])
        assert request["fileFormat"] == "GEO_TIFF"
        assert request["bandIds"] == list(names)
        assert request["grid"]["dimensions"] == {"width": 2, "height": 2}
        assert request["grid"]["affineTransform"] == {
            "scaleX": 10,
            "shearX": 0,
            "translateX": left,
            "shearY": 0,
            "scaleY": -10,
            "translateY": top,
        }
        assert CRS.from_wkt(request["grid"]["crsWkt"]) == CRS.from_epsg(6933)
        with rasterio.open(path) as dataset:
            assert dataset.descriptions == names
            assert dataset.transform == from_origin(left, top, 10, 10)
            assert dataset.crs == CRS.from_epsg(6933)
            assert dataset.dtypes == ("float32", "float32")
            pixels = dataset.read(masked=True)
            np.testing.assert_array_equal(
                pixels.mask,
                [[[False, True], [False, False]], [[False, False], [True, False]]],
            )
            assert pixels[0, 0, 0] == pixels[1, 0, 1] == 0
            assert pixels[0, 1, 1] == 3
            assert pixels[1, 1, 1] == 7


@pytest.mark.parametrize("invalid_raster", ["wrong-grid", "truncated-pixels"])
def test_invalid_download_removes_its_private_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    stack: RasterStackConfiguration,
    invalid_raster: str,
) -> None:
    """Reject invalid external raster data without retaining a partial download.

    Args:
        tmp_path: Caller directory containing an unrelated file.
        monkeypatch: Install the offline Earth Engine transport.
        stack: Scientific settings used to request one tile.
        invalid_raster: Return an incorrect grid or incomplete pixel data.
    """
    retained = tmp_path / "keep.txt"
    retained.write_text("caller-owned", encoding="utf-8")
    payload = (
        _tile_bytes(8, 31)
        if invalid_raster == "wrong-grid"
        else _tile_bytes(7, 31)[:-16]
    )
    _use_offline_earth_engine(monkeypatch, [({"status": "200"}, payload)])
    progress = Mock()
    expected = (
        ValueError if invalid_raster == "wrong-grid" else rasterio.errors.RasterioError
    )
    with pytest.raises(expected):
        download_habitat_tiles(
            box(7, 11, 27, 31),
            stack,
            HabitatEarthEngineSettings("habitat-test", tmp_path / "key.json"),
            tmp_path,
            progress=progress,
            check_cancelled=Mock(),
        )
    assert list(tmp_path.iterdir()) == [retained]
    assert [call.args for call in progress.call_args_list] == [(0, 1)]


@pytest.mark.parametrize("cancel", [False, True])
def test_failure_or_cancellation_removes_completed_tiles(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    stack: RasterStackConfiguration,
    cancel: bool,
) -> None:
    """Remove earlier tiles when a later request fails or the caller cancels.

    Args:
        tmp_path: Private attempt directory.
        monkeypatch: Install the offline Earth Engine transport.
        stack: Scientific settings used to request two tiles.
        cancel: Cancel after the first tile instead of returning a remote error.
    """
    _use_offline_earth_engine(
        monkeypatch,
        [
            ({"status": "200"}, _tile_bytes(7, 31)),
            (
                {"status": "403"},
                '{"error":{"code":403,"message":"private-server-detail"}}',
            ),
        ],
    )
    updates: list[tuple[int, int]] = []

    def check_cancelled() -> None:
        """Cancel once progress confirms the first downloaded tile was accepted."""
        if cancel and updates and updates[-1][0] == 1:
            raise RasterReadCancelled()

    with pytest.raises(RasterReadCancelled if cancel else RuntimeError) as error:
        download_habitat_tiles(
            box(7, 11, 47, 31),
            stack,
            HabitatEarthEngineSettings("habitat-test", tmp_path / "key.json"),
            tmp_path,
            progress=lambda done, total: updates.append((done, total)),
            check_cancelled=check_cancelled,
        )
    assert list(tmp_path.iterdir()) == []
    assert updates == [(0, 2), (1, 2)]
    assert "private-server-detail" not in str(error.value)


def test_server_settings_and_authentication_errors_do_not_expose_credentials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stack: RasterStackConfiguration
) -> None:
    """Read server settings and report authentication failures without key contents.

    Args:
        tmp_path: Private attempt and credential locations.
        monkeypatch: Supply environment settings and a rejected credential load.
        stack: Scientific settings used by the download request.
    """
    monkeypatch.setenv("HABITAT_GEE_PROJECT", "habitat-test")
    monkeypatch.setenv("HABITAT_GEE_CREDENTIALS_FILE", str(tmp_path / "key.json"))
    settings = HabitatEarthEngineSettings.from_environment()
    assert settings == HabitatEarthEngineSettings("habitat-test", tmp_path / "key.json")
    for name in ("HABITAT_GEE_PROJECT", "HABITAT_GEE_CREDENTIALS_FILE"):
        with monkeypatch.context() as missing:
            missing.delenv(name)
            with pytest.raises(ValueError, match=name):
                HabitatEarthEngineSettings.from_environment()
    monkeypatch.setattr(
        ee,
        "ServiceAccountCredentials",
        Mock(side_effect=GoogleAuthError("private-key-content")),
    )
    with pytest.raises(RuntimeError, match="mounted service-account") as error:
        download_habitat_tiles(
            box(7, 11, 27, 31),
            stack,
            settings,
            tmp_path,
            progress=Mock(),
            check_cancelled=Mock(),
        )
    assert "private-key-content" not in str(error.value)
    assert error.value.__suppress_context__
    assert list(tmp_path.iterdir()) == []
