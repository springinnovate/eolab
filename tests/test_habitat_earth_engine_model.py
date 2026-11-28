"""Run downloaded Habitat tiles through the existing supervised model pipeline."""

import asyncio
from dataclasses import asdict, replace
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Literal
from unittest.mock import AsyncMock, Mock
from zipfile import ZipFile

import numpy as np
import ee
from numpy.typing import NDArray
import pytest
import rasterio
from rasterio.io import MemoryFile
from rasterio.transform import from_origin
from shapely.geometry import box, mapping
from shapely.ops import unary_union

from nhi_terrestrial_integrity_modeling.analysis_config import RasterStackConfiguration
from nhi_terrestrial_integrity_modeling.habitat_training import IntegrityConfiguration
from nhi_terrestrial_integrity_modeling.prepared_rasters import RasterBand
from nhi_terrestrial_integrity_modeling.prepared_runner import run_habitat_condition

from eolab_app.bounded_vector import summary_process
from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.execution.reusable_process import ReusableProcess
from eolab_app.processing import habitat_calculation, habitat_operation
from eolab_app.processing.artifacts import LocalJobArtifacts
from eolab_app.processing.clip_models import RasterClipLimits
from eolab_app.processing.habitat_earth_engine import (
    HabitatEarthEngineSettings,
    HabitatTiles,
    get_habitat_tiles,
    get_cached_habitat_tiles,
    load_habitat_stack,
    prepare_habitat_band_views,
)
from eolab_app.processing.raster_preparation import RasterGrid
from eolab_app.processing.model_definitions import ModelDefinition, ModelRegistry
from eolab_app.processing.model_operations import get_model_operation
from eolab_app.processing.model_run_contracts import ModelJobResponse, ModelRunRequest
from eolab_app.processing.model_runs import (
    build_model_calculation_request,
    build_model_job_submission,
    export_model_job_yaml,
)
from eolab_app.processing.service import serialize_processing_job
from eolab_app.processing.worker import ProcessingWorker
from catalog_selection_support import write_selection
from test_habitat_earth_engine import _use_offline_earth_engine
from test_habitat_model import habitat_definition
from test_processing_worker_results import configure_prepared_job_store


def _fixture_configuration(year: int) -> RasterStackConfiguration:
    """Use nine original variables, including shared sources, on six cache tiles.

    Args:
        year: Supported source year passed by the production operation.

    Returns:
        Scientific definitions with a tiny grid, six predictors and three responses.
    """
    original = load_habitat_stack(year)
    return replace(
        original,
        bands=tuple(
            band
            for band in original.bands
            if band.identifier
            in {"d02", "d03", "d04", "d20", "d25", "d26", "d28", "d29", "d35"}
        ),
        grid=replace(original.grid, pixel_size_meters=1000, tile_size_pixels=8),
    )


def _fixture_values() -> dict[str, NDArray[np.float32]]:
    """Return input pixels with entirely missing drought predictors.

    Returns:
        Float32 scientific variables and a separate reference mask. Drought
        predictors d28 and d29 contain only NaN; other variables retain valid
        values, including zero, and isolated NoData across tile boundaries.
    """
    rows, columns = np.indices((16, 24))
    environment = rows * 0.3 + columns * 0.07
    category = (rows // 2 + columns // 2) % 3
    references = rows < 6
    values = {
        "d02": 1
        + 0.3 * environment
        + 0.1 * category
        + 0.04 * np.sin(rows + columns)
        + 0.2 * (columns % 3) * ~references,
        "d03": 2
        + 0.2 * environment
        - 0.15 * category
        + 0.03 * np.cos(rows * 2 + columns)
        + 0.1 * (rows % 3) * ~references,
        "d04": 3 + 0.1 * environment + 0.2 * category + 0.05 * np.cos(columns),
        "d20": environment,
        "d25": environment * 0.2,
        "d26": environment * 0.3,
        "d28": np.full_like(environment, np.nan),
        "d29": np.full_like(environment, np.nan),
        "d35": category,
        "references": references,
    }
    values = {name: data.astype("float32") for name, data in values.items()}
    values["d20"][9, 8] = np.nan
    values["d02"][12, 16] = np.nan
    values["d03"][8, 7] = 0
    return values


def _tile_response(column: int, row: int) -> bytes:
    """Encode one controlled GEE response in the configured multiband order.

    Args:
        column: Zero-based tile column in the fixture extent.
        row: Zero-based tile row in the fixture extent.

    Returns:
        Complete float32 GeoTIFF bytes, preserving NaN NoData and valid zero.
    """
    values = _fixture_values()
    configuration = _fixture_configuration(2018)
    with MemoryFile() as memory:
        with memory.open(
            driver="GTiff",
            count=len(configuration.bands),
            width=8,
            height=8,
            dtype="float32",
            crs="EPSG:6933",
            nodata=np.nan,
            transform=from_origin(column * 8000, 16000 - row * 8000, 1000, 1000),
        ) as destination:
            destination.write(
                np.stack(
                    [
                        values[band.identifier][
                            row * 8 : row * 8 + 8, column * 8 : column * 8 + 8
                        ]
                        for band in configuration.bands
                    ]
                )
            )
        return memory.read()


@pytest.mark.parametrize("interleave", ["pixel", "band"])
def test_prepared_band_views_keep_source_validity_and_selected_order(
    tmp_path: Path,
    interleave: str,
) -> None:
    """Read nonconsecutive bands with a dataset mask, declared NoData and zero.

    Args:
        tmp_path: Private directory for the input tile and temporary mosaics.
        interleave: Pixel- or band-contiguous original with both sources of validity.
    """
    configuration = _fixture_configuration(2018)
    bands = dict(zip(configuration.band_names(), configuration.bands, strict=True))
    names = tuple(bands)
    selected = (names[-1], names[0], names[3])
    pixels = np.arange(len(bands) * 6, dtype="float32").reshape(len(bands), 2, 3)
    pixels[-1, 0, 1] = -9999
    scales = tuple(float(index + 1) for index in range(len(bands)))
    offsets = tuple(float(index + 4) for index in range(len(bands)))
    tile = tmp_path / "tile.tif"
    with rasterio.open(
        tile,
        "w",
        driver="GTiff",
        width=3,
        height=2,
        count=len(bands),
        dtype="float32",
        crs="EPSG:6933",
        transform=from_origin(0, 2000, 1000, 1000),
        nodata=-9999,
        compress="DEFLATE",
        interleave=interleave,
    ) as dataset:
        dataset.write(pixels)
        dataset.scales = scales
        dataset.offsets = offsets
        dataset.write_mask(np.array([[255, 255, 255], [0, 255, 255]], dtype="uint8"))

    with prepare_habitat_band_views(
        HabitatTiles((tile,), bands, 1), tmp_path, selected
    ) as views:
        assert set(views) == set(selected)
        for name in selected:
            source_index = names.index(name)
            expected = pixels[source_index].copy()
            expected[1, 0] = np.nan
            expected[expected == -9999] = np.nan
            with rasterio.open(views[name]) as view:
                assert view.scales == (scales[source_index],)
                assert view.offsets == (offsets[source_index],)
                np.testing.assert_array_equal(
                    view.read(1, masked=True).filled(np.nan), expected
                )


def test_prepared_reruns_read_new_coverage_and_only_write_missing_selected_channels(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Add geographic coverage and switch both dataset roles off then on again.

    Args:
        tmp_path: Published acquisition tiles and separate per-job views.
        monkeypatch: Return controlled real raster bytes at the acquisition boundary.
    """
    from eolab_app.processing import habitat_earth_engine

    config = _fixture_configuration(2018)
    cache = tmp_path / "cache"
    staging = tmp_path / "downloads"
    staging.mkdir()
    area = box(0, 8000, 16000, 16000)
    grid = RasterGrid(
        rasterio.crs.CRS.from_epsg(6933), from_origin(0, 16000, 500, 500), 32, 16
    )
    scientific = dict(zip(config.band_names(), config.bands, strict=True))
    by_id = {band.identifier: name for name, band in scientific.items()}
    full = tuple(by_id[band] for band in ("d35", "d20", "d04", "d02"))
    subset = (full[1], full[3])
    writes: list[Path] = []
    original_publish = habitat_earth_engine.publish_band_tile

    def publish(local: Path, destination: Path) -> None:
        """Count complete selected-channel files actually offered for publication.

        Args:
            local: Closed attempt-local raster.
            destination: Its immutable shared cache name.
        """
        original_publish(local, destination)
        writes.append(destination)

    monkeypatch.setattr(habitat_earth_engine, "publish_band_tile", publish)
    for run, (selected, added_column, expected_writes) in enumerate(
        (
            (subset, 0, 2),
            (full, None, 2),
            (subset, None, 0),
            (full, None, 0),
            (full, 1, 4),
        )
    ):
        if added_column is not None:
            with monkeypatch.context() as acquisition:
                _use_offline_earth_engine(
                    acquisition, [({"status": "200"}, _tile_response(added_column, 0))]
                )
                get_habitat_tiles(
                    box(added_column * 8000, 8000, (added_column + 1) * 8000, 16000),
                    config,
                    HabitatEarthEngineSettings(
                        "fixture", tmp_path / "private-key.json"
                    ),
                    cache_directory=cache,
                    working_directory=staging,
                    progress=lambda _: None,
                    check_cancelled=lambda: None,
                )
        inputs = get_cached_habitat_tiles(area, config, cache)
        assert inputs.required_tiles == 2 and len(inputs.tiles) == (
            2 if run == 4 else 1
        )
        before = len(writes)
        seen: list[int] = []
        attempt = tmp_path / f"run-{run}"
        attempt.mkdir()
        with prepare_habitat_band_views(
            inputs, attempt, selected, grid=grid, on_tile=seen.append
        ) as paths:
            assert tuple(paths) == selected
            for name in selected:
                original = _fixture_values()[scientific[name].identifier][
                    :8, :16
                ].copy()
                if run < 4:
                    original[:, 8:] = np.nan
                with rasterio.open(paths[name]) as raster:
                    expected = original.repeat(2, axis=0).repeat(2, axis=1)
                    np.testing.assert_array_equal(
                        raster.read(1, masked=True).filled(np.nan), expected
                    )
        assert seen == list(range(1, len(inputs.tiles) + 1))
        assert len(writes) - before == expected_writes


def _fixture_native_target(
    queue: ProcessResultWriter,
    operation: Literal["prepare", "calculate"],
    arguments: tuple[Any, ...],
) -> None:
    """Run the production target while rejecting all Earth Engine access.

    Args:
        queue: Actual native worker result channel.
        operation: Preparation or calculation selected by the Habitat operation.
        arguments: Production arguments; local paths remain private to the worker.
    """
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(habitat_calculation, "load_habitat_stack", _fixture_configuration)
        for owner, name in (
            (ee, "Initialize"),
            (ee, "ServiceAccountCredentials"),
            (ee.data, "computePixels"),
        ):
            patch.setattr(
                owner,
                name,
                Mock(
                    side_effect=AssertionError("Model runs only read prepared inputs")
                ),
            )
        habitat_calculation.habitat_process_target(queue, operation, arguments)


@pytest.mark.parametrize(
    "coverage",
    [
        "complete",
        "partial",
        "new_tile",
        "empty",
        "wrong_year",
        "no_references",
        "selected",
        "categorical_only",
        "continuous_only",
    ],
)
def test_earth_engine_run_uses_prepared_geographic_coverage(
    tmp_path: Path,
    habitat_definition: ModelDefinition,
    monkeypatch: pytest.MonkeyPatch,
    coverage: Literal[
        "complete",
        "partial",
        "new_tile",
        "empty",
        "wrong_year",
        "no_references",
        "selected",
        "categorical_only",
        "continuous_only",
    ],
) -> None:
    """Use prepared tiles without downloads and retain model screening and NoData.

    Args:
        tmp_path: Separate cache, reference polygons and ordinary worker storage.
        habitat_definition: Installed recipe with small-fixture fitting settings.
        monkeypatch: Supply controlled preparation pixels and reject model downloads.
        coverage: Geographic cache availability, absence of reference sites, or
            selected dataset subsets including the minimum categorical-only fit.
    """
    aoi = box(0, 0, 24000, 16000)
    if coverage == "selected":
        aoi = aoi.difference(box(12200, 2200, 14900, 4700))
    area = write_selection(tmp_path / "area.gpkg", [mapping(aoi)], crs="EPSG:6933")
    references = write_selection(
        tmp_path / "references.gpkg",
        [mapping(box(-2000, 10000, 26000, 18000))],
        crs="EPSG:6933",
    )
    selected = {item.selection.item_id: item for item in (area, references)}
    request = ModelRunRequest(
        requestId="earth-engine-model",
        label="Habitat fixture",
        utcOffsetMinutes=0,
        model={
            "id": habitat_definition.id,
            "version": habitat_definition.version,
            "definitionSha256": habitat_definition.digest,
        },
        inputs={
            "stack": {"kind": "earthEngine", "year": 2018},
            "area": {
                "kind": "catalogSelection",
                "selection": area.selection.model_dump(mode="json", by_alias=True),
            },
            "references": {
                "kind": "vector",
                "selection": references.selection.model_dump(
                    mode="json", by_alias=True
                ),
            },
            "habitat_mask": None,
            "preparation": {
                "resampling": {},
            },
        },
        parameters={},
    )
    if coverage in {"selected", "categorical_only", "continuous_only"}:
        request.inputs["stack"].update(
            predictorDatasets={
                "selected": ["srtm_landforms", "era5_daily"],
                "continuous_only": ["era5_daily"],
                "categorical_only": ["srtm_landforms"],
            }[coverage],
            responseDatasets=["modis_phenology"],
        )
    calculation, invocation = build_model_calculation_request(
        request, ModelRegistry((habitat_definition,))
    )
    assert calculation.settings.output_grid.model_dump(mode="json") == {
        "crs": "EPSG:6933",
        "pixel_size": [500, 500],
        "origin": [0, 0],
    }
    operation = get_model_operation("habitat.condition.v1")
    assert operation.source is None and operation.primary_input is None
    assert operation.extra_sources(calculation) == {}
    submission = build_model_job_submission(
        operation.queue(calculation, {}), invocation, None, {}
    )
    cache = tmp_path / "habitat-cache"
    prepared_tiles = [
        (column, row)
        for row in range(2)
        for column in range(3)
        if coverage != "empty"
        and not (coverage in {"partial", "new_tile"} and (column, row) == (1, 1))
        and not (coverage == "selected" and (column, row) == (2, 1))
        and not (coverage == "no_references" and row == 0)
    ]
    if prepared_tiles:
        staging = tmp_path / "preparation"
        staging.mkdir()
        with monkeypatch.context() as acquisition:
            _use_offline_earth_engine(
                acquisition,
                [
                    ({"status": "200"}, _tile_response(column, row))
                    for column, row in prepared_tiles
                ],
            )
            prepared_area = unary_union(
                [
                    box(
                        column * 8000,
                        8000 - row * 8000,
                        (column + 1) * 8000,
                        16000 - row * 8000,
                    )
                    for column, row in prepared_tiles
                ]
            )
            get_habitat_tiles(
                prepared_area,
                _fixture_configuration(2015 if coverage == "wrong_year" else 2018),
                HabitatEarthEngineSettings(
                    "private-project", tmp_path / "private-key.json"
                ),
                cache_directory=cache,
                working_directory=staging,
                progress=lambda update: None,
                check_cancelled=lambda: None,
            )
    authorizer = SimpleNamespace(
        authorize=AsyncMock(side_effect=AssertionError("No Catalog raster is needed"))
    )
    areas = SimpleNamespace(
        resolve_for_sampling=AsyncMock(
            side_effect=lambda selection: selected[selection.item_id]
        )
    )
    store = Mock()
    store.finish.return_value = True
    store.heartbeat.return_value = True
    artifacts = LocalJobArtifacts(tmp_path / "artifacts")
    artifacts.initialize()
    native = ReusableProcess(
        (_fixture_native_target, summary_process), recycle_bytes=1024**3
    )
    monkeypatch.setattr(
        habitat_operation, "habitat_process_target", _fixture_native_target
    )
    worker = ProcessingWorker(
        authorizer,
        store,
        artifacts,
        RasterClipLimits(),
        native=native,
        areas=areas,
        operation_settings={operation.id: cache},
    )

    async def run() -> dict[str, Any]:
        """Run against unchanged prepared inputs through the ordinary native worker.

        Returns:
            The completed or failed job, including its artifact when ready.
        """
        try:
            first_valid_count = None
            for index in range(
                2 if coverage in {"complete", "partial", "new_tile"} else 1
            ):
                if coverage == "new_tile" and index == 1:
                    with monkeypatch.context() as acquisition:
                        _use_offline_earth_engine(
                            acquisition, [({"status": "200"}, _tile_response(1, 1))]
                        )
                        get_habitat_tiles(
                            box(8000, 0, 16000, 8000),
                            _fixture_configuration(2018),
                            HabitatEarthEngineSettings(
                                "private-project", tmp_path / "private-key.json"
                            ),
                            cache_directory=cache,
                            working_directory=staging,
                            progress=lambda _: None,
                            check_cancelled=lambda: None,
                        )
                    prepared_tiles.append((1, 1))
                now = datetime.now(timezone.utc)
                row = {
                    "id": str(index + 1) * 32,
                    "attempt_id": str(index + 3) * 32,
                    "input_uploads": {},
                    "operation": "model.run.v1",
                    "spec": submission.specification,
                    "summary": submission.summary,
                    "retained_metadata": submission.retained_metadata,
                    "presentation": {"utcOffsetMinutes": 0},
                    "reserved_bytes": 0,
                    "created_at": now,
                    "updated_at": now,
                    "expires_at": now + timedelta(hours=1),
                    "status": "running",
                    "progress": {},
                    "error": None,
                }
                configure_prepared_job_store(store, row)
                store.claim_next_job.return_value = row
                assert await worker.run_once()
                artifact = store.finish.call_args.args[2]
                if coverage in {"empty", "wrong_year", "no_references"}:
                    assert artifact is None
                    error = store.finish.call_args.args[3]
                    if coverage == "no_references":
                        assert error["code"] == "invalid_habitat_inputs"
                        assert "no_reference_values" in error["detail"]
                    else:
                        assert error["code"] == "habitat_inputs_not_prepared"
                        assert error["detail"] == (
                            "No Ecosystem Condition inputs are prepared for this area and year. "
                            "Ask an administrator to prepare the saved area and year, "
                            "then try running the model again."
                        )
                    store.cleanup_candidates.return_value = [row]
                    store.active_attempts.return_value = set()
                    await worker.cleanup()
                    assert not (
                        artifacts.root / "attempts" / row["attempt_id"]
                    ).exists()
                else:
                    assert artifact is not None, store.finish.call_args
                    if coverage == "new_tile":
                        if first_valid_count is None:
                            first_valid_count = artifact.valid_pixels
                        else:
                            assert artifact.valid_pixels > first_valid_count
                    row.update(
                        status="ready",
                        artifact=asdict(artifact),
                        retained_outcome={
                            "status": "ready",
                            "artifact": asdict(artifact),
                        },
                    )
                assert len(list(cache.rglob("tile.tif"))) == len(prepared_tiles)
            return row
        finally:
            await native.close()

    ready = asyncio.run(run())
    authorizer.authorize.assert_not_awaited()
    if coverage in {"empty", "wrong_year", "no_references"}:
        return
    response = ModelJobResponse.model_validate(serialize_processing_job(ready))
    assert response.completionEstimate is None
    assert response.result.name == "reference_similarity"
    assert response.result.preparedInputCoverage.model_dump() == {
        "requiredTiles": 6,
        "cachedTiles": len(prepared_tiles),
        "missingTiles": 6 - len(prepared_tiles),
    }
    assert {file.name for file in response.artifacts.files} == {
        "reference_similarity",
        "diagnostics",
        "provenance",
    }
    provenance_path = artifacts.artifact_path(ready["attempt_id"], "provenance.json")
    provenance_text = provenance_path.read_text()
    for secret in (str(tmp_path), "private-project", "private-key"):
        assert secret not in provenance_text
        assert secret not in export_model_job_yaml(ready, run=True).decode()
    provenance = json.loads(provenance_text)
    assert provenance["prepared_input_coverage"] == {
        "configuration_sha256": _fixture_configuration(
            2018
        ).raster_configuration_sha256,
        "year": 2018,
        "required_tiles": 6,
        "cached_tiles": len(prepared_tiles),
        "missing_tiles": 6 - len(prepared_tiles),
    }
    assert provenance["inputs"]["stack"] == calculation.stack.model_dump(mode="json")

    configuration = _fixture_configuration(2018)
    assert provenance["earthEngine"]["year"] == 2018
    assert provenance["earthEngine"]["datasets"] == dict(configuration.datasets)
    assert [band["identifier"] for band in provenance["earthEngine"]["bands"]] == [
        band.identifier for band in configuration.bands
    ]
    assert provenance["inputs"]["settings"] == calculation.settings.model_dump(
        mode="json"
    )
    named = list(zip(configuration.band_names(), configuration.bands))
    selected_names = {
        role: tuple(
            name
            for name, band in named
            if band.role == role
            and all(key in selected for key in band.source_dataset_keys)
        )
        for role, selected in (
            ("predictor", calculation.stack.predictorDatasets),
            ("response", calculation.stack.responseDatasets),
        )
    }
    assert provenance["variables"]["predictors"] == list(selected_names["predictor"])
    assert provenance["variables"]["responses"] == list(selected_names["response"])
    if coverage in {"selected", "categorical_only", "continuous_only"}:
        assert [
            band.identifier
            for name, band in named
            if name in selected_names["response"]
        ] == ["d04"]
        assert [
            band.identifier
            for name, band in named
            if name in selected_names["predictor"]
        ] == {
            "selected": ["d20", "d35"],
            "categorical_only": ["d35"],
            "continuous_only": ["d20"],
        }[
            coverage
        ]
    predictor_coverage = {
        item["predictor"]: item for item in provenance["fit"]["predictorCoverage"]
    }
    for name, band in named:
        if name not in selected_names["predictor"]:
            continue
        predictor = predictor_coverage[name]
        if band.identifier in {"d28", "d29"}:
            assert predictor["defined_rows"] == 0
            assert predictor["area_coverage"] == 0
            assert predictor["retained"] is False
        else:
            assert (
                predictor["area_coverage"]
                >= calculation.settings.minimum_predictor_coverage
            )
            assert predictor["retained"] is True
    values = _fixture_values()
    if coverage in {"partial", "selected"}:
        missing_columns = slice(8, 16) if coverage == "partial" else slice(16, 24)
        for name, pixels in values.items():
            if name != "references":
                pixels[8:16, missing_columns] = np.nan
    paths = {}
    for name, pixels in values.items():
        # Cached 1000 m cells cover four cells of the fixed 500 m output grid.
        pixels = pixels.repeat(2, axis=0).repeat(2, axis=1)
        path = tmp_path / f"expected-{name}.tif"
        with rasterio.open(
            path,
            "w",
            driver="GTiff",
            count=1,
            width=48,
            height=32,
            dtype="float64",
            crs="EPSG:6933",
            nodata=np.nan,
            transform=from_origin(0, 16000, 500, 500),
        ) as destination:
            destination.write(pixels.astype("float64"), 1)
        paths[name] = path
    settings = calculation.settings
    expected = run_habitat_condition(
        [
            RasterBand(name, paths[band.identifier])
            for name, band in named
            if name in selected_names["predictor"]
        ],
        [
            RasterBand(name, paths[band.identifier])
            for name, band in named
            if name in selected_names["response"]
        ],
        RasterBand("reference_sites", paths["references"]),
        aoi,
        tmp_path / "expected",
        IntegrityConfiguration(
            **{
                name: getattr(settings, name)
                for name in IntegrityConfiguration.__dataclass_fields__
            }
        ),
        categorical_predictor_name=next(
            (
                name
                for name, band in named
                if name in selected_names["predictor"]
                and band.data_type == "categorical"
            ),
            None,
        ),
        samples_per_class_per_block=settings.samples_per_class_per_block,
        random_seed=settings.random_seed,
        tile_size_pixels=settings.tile_size_pixels,
        tile_origin=settings.tile_origin,
        window_size_pixels=settings.window_size_pixels,
        covariance_shrinkage=settings.covariance_shrinkage,
    )
    with ZipFile(
        artifacts.artifact_path(ready["attempt_id"], "diagnostics.zip")
    ) as archive:
        for name in (
            "reference_similarity",
            "expected_reference",
            "observed_minus_expected",
            "standardized_deviation",
            "inference_status",
        ):
            data = (
                artifacts.artifact_path(ready["attempt_id"], "result.tif").read_bytes()
                if name == "reference_similarity"
                else archive.read(f"{name}.tif")
            )
            with (
                MemoryFile(data) as memory,
                memory.open() as actual,
                rasterio.open(getattr(expected, name)) as direct,
            ):
                assert actual.transform == direct.transform
                assert actual.transform == from_origin(0, 16000, 500, 500)
                assert actual.crs == rasterio.crs.CRS.from_epsg(6933)
                assert actual.shape == (32, 48)
                assert actual.descriptions == direct.descriptions
                np.testing.assert_array_equal(actual.read(), direct.read())
                np.testing.assert_array_equal(actual.read_masks(), direct.read_masks())
                if name == "reference_similarity":
                    score_mask = actual.read(1, masked=True).mask
                    if coverage == "partial":
                        assert score_mask[16:32, 16:32].all()
                    if coverage == "selected":
                        assert score_mask[16:32, 32:48].all()  # Missing tile.
                        assert score_mask[23:27, 25:29].all()  # Hole in the AOI.
    assert all(path.is_file() for path in provenance_path.parent.iterdir())
