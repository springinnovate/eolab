"""Run Habitat model requests through native calculation and result publication."""

import asyncio
from collections.abc import AsyncIterator
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Literal
from unittest.mock import Mock
from zipfile import ZipFile

import numpy as np
import pytest
from pydantic import ValidationError
import rasterio
from rasterio.features import geometry_mask
from rasterio.io import MemoryFile
from rasterio.transform import from_origin
from rasterio.warp import transform, transform_geom
from shapely.geometry import Point, box, mapping

from nhi_terrestrial_integrity_modeling.habitat_training import IntegrityConfiguration
from nhi_terrestrial_integrity_modeling.prepared_rasters import RasterBand
from nhi_terrestrial_integrity_modeling.prepared_runner import run_habitat_condition

from eolab_app.catalog_selection import ResolvedCatalogSelection, VectorSelection
from eolab_app.processing.aggregate_models import AggregateArea
from eolab_app.processing.artifacts import LocalJobArtifacts
from eolab_app.processing.clip_models import RasterClipLimits
from eolab_app.processing.habitat_calculation import HabitatSources, read_habitat_area
from eolab_app.processing.habitat_models import HabitatEarthEngineStack
from eolab_app.processing.model_definitions import ModelDefinition, ModelRegistry
from eolab_app.processing.model_operations import get_model_operation
from eolab_app.processing.model_run_contracts import (
    ModelJobResponse,
    ModelRunRequest,
    RunDocument,
)
from eolab_app.processing.model_runs import (
    build_model_calculation_request,
    build_model_job_submission,
    export_model_job_yaml,
)
from eolab_app.processing.model_yaml import parse_yaml
from eolab_app.processing.models import JobInputFile, ProcessingError
from eolab_app.processing.native_processes import create_native_process
from eolab_app.polygon_areas import PolygonSummaryInput
from eolab_app.processing.service import serialize_processing_job
from eolab_app.processing.worker import ProcessingWorker
from eolab_app.raster.models import AuthorizedRaster, CatalogRasterRequest
from eolab_app.raster.source_identity import RasterSourceIdentity
from eolab_app.raster.source_models import UploadedRasterReference
from eolab_app.raster_uploads import RasterUploadStore
from eolab_app.upload_storage import UploadStorage
from eolab_app.vector.filters import VectorFilter
from catalog_selection_support import write_selection
from test_processing_worker_results import configure_prepared_job_store


def test_automatic_dataset_defaults_and_selections_survive_saved_roundtrip() -> None:
    """Expand default roles and retain independent canonical choices when persisted."""
    defaults = HabitatEarthEngineStack(kind="earthEngine", year=2018)
    assert len(defaults.predictorDatasets) == 13
    assert len(defaults.responseDatasets) == 6
    assert "modis_phenology" in defaults.predictorDatasets
    assert "modis_phenology" in defaults.responseDatasets
    assert HabitatEarthEngineStack.model_validate(defaults) == defaults
    assert (
        HabitatEarthEngineStack.model_validate_json(defaults.model_dump_json())
        == defaults
    )

    selected = HabitatEarthEngineStack(
        kind="earthEngine",
        year=2018,
        predictorDatasets=("srtm_landforms", "era5_daily"),
        responseDatasets=("modis_phenology",),
    )
    assert selected.predictorDatasets == ("era5_daily", "srtm_landforms")
    assert selected.responseDatasets == ("modis_phenology",)
    assert (
        HabitatEarthEngineStack.model_validate_json(selected.model_dump_json())
        == selected
    )


@pytest.mark.parametrize(
    "selection",
    [
        {"predictorDatasets": []},
        {"responseDatasets": []},
        {"predictorDatasets": ["modis_phenology"]},
        {"responseDatasets": ["landsat_ndvi", "landsat_ndvi"]},
        {"responseDatasets": ["era5_daily"]},
        {"predictorDatasets": ["srtm_landforms", "unknown"]},
    ],
)
def test_automatic_dataset_selection_rejects_invalid_role_choices(
    selection: dict[str, list[str]],
) -> None:
    """Reject empty, duplicate, unknown, wrong-role or incomplete band selections.

    Args:
        selection: One invalid public selection field; the other uses its default.
    """
    with pytest.raises(ValidationError):
        HabitatEarthEngineStack.model_validate(
            {"kind": "earthEngine", "year": 2018, **selection}
        )


@pytest.fixture
def habitat_definition() -> ModelDefinition:
    """Use the installed 500 m recipe with fitting settings for a small test area.

    Returns:
        Habitat recipe retaining its actual inputs, outputs and operation binding.
    """
    document = (
        ModelRegistry.load_installed().get("habitat-condition", "1.0.0").to_document()
    )
    document["steps"][0]["inputs"]["settings"]["value"].update(
        fold_count=3,
        sampling_block_size_meters=2000,
        validation_block_size_meters=4000,
        maximum_row_missing_fraction=0.5,
        spline_knot_count=3,
        random_seed=17,
        tile_size_pixels=8,
        window_size_pixels=5,
    )
    return ModelDefinition.model_validate(document)


def test_whole_raster_aoi_preserves_curved_projected_edges(tmp_path: Path) -> None:
    """Keep source pixels beyond the straight lines between projected corners.

    Args:
        tmp_path: Original UTM raster whose north edge curves in EPSG:6933.
    """
    path = tmp_path / "utm.tif"
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        count=1,
        width=24,
        height=28,
        dtype="float32",
        crs="EPSG:32613",
        transform=from_origin(200000, 5500000, 25000, 25000),
    ):
        pass
    aoi = read_habitat_area(
        AggregateArea(kind="wholeRaster"),
        HabitatSources(rasters={"predictor_0": path}, vectors={}),
        rasterio.crs.CRS.from_epsg(6933),
        (25000, 25000),
    )
    x, y = transform("EPSG:32613", "EPSG:6933", [500000, 500000], [5499900, 5500000])
    assert aoi.contains(Point(x[0], y[0]))
    assert aoi.bounds[3] == pytest.approx(y[1])


@pytest.mark.parametrize(
    "reference_kind", ["raster", "uploadedRaster", "vector", "polygonArea"]
)
def test_habitat_worker_matches_library_and_publishes_outputs(
    tmp_path: Path,
    habitat_definition: ModelDefinition,
    reference_kind: Literal["raster", "uploadedRaster", "vector", "polygonArea"],
) -> None:
    """Match nonzero raster references and polygons to an independent binary run.

    Args:
        tmp_path: Isolated source files, direct library outputs and worker artifacts.
        habitat_definition: Installed recipe with settings suitable for this fixture.
        reference_kind: Coarse catalog/uploaded raster, filtered vector, or drawing.
            The drawn case uses independent polygons for both area and references.
            The upload case admits a Byte mask and deletes its public source before execution.
            The catalog case includes negative references and invalid nonzero cells.
    """
    rows, columns = np.indices((16, 24))
    environment = rows * 0.3 + columns * 0.07
    habitat_type = (rows // 2 + columns // 2) % 3
    references = rows < 6
    values = {
        "environment": environment,
        "habitat_type": habitat_type,
        "canopy": 1
        + 0.3 * environment
        + 0.1 * habitat_type
        + 0.04 * np.sin(rows + columns)
        + 0.2 * (columns % 3) * ~references,
        "productivity": 2
        + 0.2 * environment
        - 0.15 * habitat_type
        + 0.03 * np.cos(rows * 2 + columns)
        + 0.1 * (rows % 3) * ~references,
        "references": references.astype("float64"),
        "assessment": np.where(columns < 22, 1, 2),
    }
    grid = from_origin(0, 8000, 500, 500)
    aoi = box(50, 50, 11950, 7950).difference(box(3000, 1000, 5000, 2500))
    outside = geometry_mask([mapping(aoi)], (16, 24), grid)
    paths = {name: tmp_path / f"{name}.tif" for name in values}
    prepared_paths = {name: tmp_path / f"prepared-{name}.tif" for name in values}
    for name, data in values.items():
        prepared = data.astype("float64")
        prepared[outside] = np.nan
        if name == "environment":
            prepared[:, 20:] = np.nan
        with rasterio.open(
            prepared_paths[name],
            "w",
            driver="GTiff",
            count=1,
            width=24,
            height=16,
            dtype="float64",
            crs="EPSG:6933",
            transform=grid,
            nodata=np.nan,
        ) as destination:
            destination.write(prepared, 1)
        spacing = 500
        if name == "environment":
            data = data[:, :20]
        elif name in {"habitat_type", "references", "assessment"}:
            data = data[::2, ::2]
            spacing = 1000
        if name == "references" and reference_kind == "raster":
            # Expected membership above is independent of these source encodings.
            data = data.copy()
            data[:3] = np.resize([1, 2, -3], data[:3].shape)
            data[3:, :5] = [-9999, np.nan, np.inf, -np.inf, 7]
        source_dtype = (
            "uint8"
            if reference_kind == "uploadedRaster" and name == "references"
            else "float64"
        )
        with rasterio.open(
            paths[name],
            "w",
            driver="GTiff",
            count=1,
            width=data.shape[1],
            height=data.shape[0],
            dtype=source_dtype,
            crs="EPSG:6933",
            transform=from_origin(0, 8000, spacing, spacing),
            nodata=(
                -9999 if name == "references" and reference_kind == "raster" else None
            ),
        ) as destination:
            destination.write(data.astype(source_dtype), 1)
            if name == "references" and reference_kind == "raster":
                valid = np.full(data.shape, 255, dtype="uint8")
                valid[3:, 4] = 0
                destination.write_mask(valid)
    sources = {
        name: {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": f"geotiff-{index:024x}",
        }
        for index, name in enumerate(paths)
    }
    catalog_paths = {sources[name]["itemId"]: path for name, path in paths.items()}
    upload_storage: UploadStorage | None = None
    retained_uploads: dict[str, str] = {}
    if reference_kind == "uploadedRaster":
        upload_storage = UploadStorage(tmp_path / "uploads")
        upload_storage.initialize()

        async def mask_chunks() -> AsyncIterator[bytes]:
            """Stream the fixture's original Byte GeoTIFF through real upload admission.

            Yields:
                Complete bytes from the closed, single-band mask fixture.
            """
            yield paths["references"].read_bytes()

        uploaded = asyncio.run(
            RasterUploadStore(upload_storage).create(
                "c" * 64, "Reference sites", mask_chunks()
            )
        )
        upload_record, uploaded_path = upload_storage.get_upload_source(
            "c" * 64, uploaded.id, "raster"
        )
        sources["references"] = {"kind": "uploadedRaster", "uploadId": str(uploaded.id)}
        retained_uploads[str(uploaded.id)] = upload_storage.retain_source(uploaded_path)
        upload_storage.delete("c" * 64, uploaded.id)
        assert not upload_storage.is_available(uploaded.id, "raster")
    area = write_selection(tmp_path / "area.gpkg", [mapping(aoi)], crs="EPSG:6933")
    selected_references = write_selection(
        tmp_path / "references.gpkg",
        [mapping(box(0, 5000, 12000, 8000)), mapping(box(0, 0, 12000, 5000))],
        crs="EPSG:6933",
        values=[1, 2],
        candidate=VectorFilter(
            enabled=True,
            match="all",
            rules=[{"field": "selected", "operator": "eq", "value": 1}],
        ),
    )
    uses_assessment_mask = reference_kind in {"vector", "polygonArea"}
    selections = {item.selection.item_id: item for item in (area, selected_references)}
    inputs = {
        "stack": {
            "predictors": [
                {"name": name, "source": sources[name]}
                for name in ("environment", "habitat_type")
            ],
            "responses": [
                {"name": name, "source": sources[name]}
                for name in ("productivity", "canopy")
            ],
            "categoricalPredictor": "habitat_type",
        },
        "area": {
            "kind": "catalogSelection",
            "selection": area.selection.model_dump(mode="json", by_alias=True),
        },
        "references": (
            {
                "kind": "vector",
                "selection": selected_references.selection.model_dump(
                    mode="json", by_alias=True
                ),
            }
            if uses_assessment_mask
            else {"kind": "raster", "source": sources["references"]}
        ),
        "habitat_mask": sources["assessment"] if uses_assessment_mask else None,
        "preparation": {
            "resampling": {
                "predictor_0": "bilinear",
                "predictor_1": "nearest",
                "response_0": "nearest",
                "response_1": "nearest",
                (
                    "habitat_mask" if uses_assessment_mask else "reference_mask"
                ): "nearest",
            },
        },
    }
    polygon_inputs = {}
    if reference_kind == "polygonArea":
        # Four drawable polygons reproduce the vector AOI's single interior hole.
        assessment_polygons = (
            box(50, 50, 3000, 7950),
            box(5000, 50, 11950, 7950),
            box(3000, 50, 5000, 1000),
            box(3000, 2500, 5000, 7950),
        )
        for field, role, identifier, shapes in (
            ("area", "area", "a" * 32, assessment_polygons),
            ("references", "reference_sites", "b" * 32, (box(0, 5000, 12000, 8000),)),
        ):
            geometries = tuple(
                transform_geom("EPSG:6933", "EPSG:4326", mapping(polygon))
                for polygon in shapes
            )
            payload = PolygonSummaryInput(polygons=geometries)
            checksum = payload.geometry_hash()
            inputs[field] = {
                "kind": "polygonArea",
                "reference": {"id": identifier, "sha256": checksum},
            }
            polygon_inputs[role] = AggregateArea(
                kind="polygons",
                bounds=payload.bounds(),
                geometryHash=checksum,
                geometries=geometries,
            )
    request = ModelRunRequest(
        requestId="habitat-boundary-run",
        label="Habitat fixture",
        utcOffsetMinutes=0,
        model={
            "id": habitat_definition.id,
            "version": habitat_definition.version,
            "definitionSha256": habitat_definition.digest,
        },
        inputs=inputs,
        parameters={},
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
    identities = {
        item_id: RasterSourceIdentity.read(path)
        for item_id, path in catalog_paths.items()
    }
    submission = build_model_job_submission(
        operation.queue(calculation, polygon_inputs),
        invocation,
        None,
        {
            name: (
                upload_record
                if isinstance(source, UploadedRasterReference)
                else tuple(identities[source.item_id].to_catalog())
            )
            for name, source in operation.extra_sources(calculation).items()
        },
    )

    assert (
        submission.summary["model"]["title"]
        == "Map ecosystem similarity to reference conditions"
    )
    assert submission.summary["model"]["id"] == "habitat-condition"
    assert submission.summary["label"] == "Habitat fixture"

    async def authorize(source: CatalogRasterRequest) -> AuthorizedRaster:
        """Return the fixture's admitted raster identity and native file.

        Args:
            source: Catalog identity supplied by the production worker.

        Returns:
            Authorized fixture raster without a second metadata inspection.
        """
        return AuthorizedRaster(
            catalog_paths[source.item_id], identities[source.item_id]
        )

    async def resolve_selection(selection: VectorSelection) -> ResolvedCatalogSelection:
        """Return the separately authorized AOI or filtered reference source.

        Args:
            selection: Public descriptor requested by the operation.

        Returns:
            The corresponding real GeoPackage and compiled filter.
        """
        resolved = selections[selection.item_id]
        assert resolved.selection == selection
        return resolved

    now = datetime.now(timezone.utc)
    row: dict[str, Any] = {
        "id": "a" * 32,
        "input_uploads": retained_uploads,
        "attempt_id": "b" * 32,
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
    store = Mock()
    configure_prepared_job_store(store, row)
    store.claim_next_job.return_value = row
    store.heartbeat.return_value = True
    store.finish.return_value = True
    artifacts = LocalJobArtifacts(tmp_path / "artifacts")
    artifacts.initialize()
    limits = RasterClipLimits()
    native = create_native_process(limits)
    worker = ProcessingWorker(
        SimpleNamespace(authorize=authorize),
        store,
        artifacts,
        limits,
        native=native,
        areas=SimpleNamespace(resolve_for_sampling=resolve_selection),
        upload_storage=upload_storage,
    )

    async def execute() -> bool:
        """Run the queued operation and close its supervised native process.

        Returns:
            Whether the worker handled the queued attempt.
        """
        try:
            return await worker.run_once()
        finally:
            await native.close()

    assert asyncio.run(execute())
    artifact = store.finish.call_args.args[2]
    assert artifact is not None, store.finish.call_args
    ready = {
        **row,
        "status": "ready",
        "artifact": asdict(artifact),
        "retained_outcome": {"status": "ready", "artifact": asdict(artifact)},
    }
    response = ModelJobResponse.model_validate(serialize_processing_job(ready))
    assert response.result.name == "reference_similarity"
    assert response.result.label == "Reference similarity score (0–1)"
    assert response.result.presentation == "map"
    assert response.result.preparedInputCoverage is None
    assert "preparedInputCoverage" not in response.model_dump(mode="json")["result"]
    assert {file.name for file in response.artifacts.files} == {
        "reference_similarity",
        "diagnostics",
        "provenance",
    }
    diagnostics = next(
        file for file in response.artifacts.files if file.name == "diagnostics"
    )
    assert diagnostics.role == "intermediate"
    assert diagnostics.mediaType == "application/zip"
    assert habitat_definition.outputs["diagnostics"].presentation == "download"
    provenance = json.loads(
        artifacts.artifact_path(row["attempt_id"], "provenance.json").read_text()
    )
    assert provenance["inputs"]["settings"]["output_grid"] == {
        "crs": "EPSG:6933",
        "pixel_size": [500, 500],
        "origin": [0, 0],
    }
    run_yaml = export_model_job_yaml(ready, run=True).decode()
    assert str(tmp_path) not in run_yaml
    assert "coordinates:" not in run_yaml

    settings = calculation.settings
    expected = run_habitat_condition(
        [
            RasterBand(name, prepared_paths[name])
            for name in ("environment", "habitat_type")
        ],
        [RasterBand(name, prepared_paths[name]) for name in ("productivity", "canopy")],
        RasterBand("references", prepared_paths["references"]),
        aoi,
        tmp_path / "direct",
        IntegrityConfiguration(
            **{
                name: getattr(settings, name)
                for name in IntegrityConfiguration.__dataclass_fields__
            }
        ),
        categorical_predictor_name="habitat_type",
        samples_per_class_per_block=settings.samples_per_class_per_block,
        random_seed=settings.random_seed,
        tile_size_pixels=settings.tile_size_pixels,
        tile_origin=settings.tile_origin,
        window_size_pixels=settings.window_size_pixels,
        covariance_shrinkage=settings.covariance_shrinkage,
        assessment_mask=(
            RasterBand("assessment", prepared_paths["assessment"])
            if uses_assessment_mask
            else None
        ),
    )
    diagnostic_names = (
        "expected_reference",
        "observed_minus_expected",
        "standardized_deviation",
        "inference_status",
    )
    actual_path = artifacts.artifact_path(row["attempt_id"], "result.tif")
    with rasterio.open(actual_path) as similarity:
        assert similarity.shape == (16, 24)
        assert similarity.transform == grid
        assert similarity.crs == rasterio.crs.CRS.from_epsg(6933)
        assert similarity.dtypes == (response.result.grid.dtype,) == ("float32",)
        assert similarity.nodata == float(row["summary"]["grid"]["nodata"]) == -9999.0
        similarity_values = similarity.read(1, masked=True)
        assert similarity_values[6:, 20:22].count() > 0
        assert 0 <= similarity_values.min() <= similarity_values.max() <= 1
        assert similarity_values.mask[outside].all()
        assert similarity_values.mask[references].all()
        if uses_assessment_mask:
            assert similarity_values.mask[:, 22:].all()
    with ZipFile(
        artifacts.artifact_path(row["attempt_id"], "diagnostics.zip")
    ) as archive:
        assert set(archive.namelist()) == {f"{name}.tif" for name in diagnostic_names}
        for name in ("reference_similarity", *diagnostic_names):
            data = (
                actual_path.read_bytes()
                if name == "reference_similarity"
                else archive.read(f"{name}.tif")
            )
            with (
                MemoryFile(data) as memory,
                memory.open() as actual,
                rasterio.open(getattr(expected, name)) as original,
            ):
                assert actual.transform == original.transform
                assert actual.descriptions == original.descriptions
                np.testing.assert_array_equal(actual.read(), original.read())
    assert all(path.is_file() for path in actual_path.parent.iterdir())


@pytest.mark.parametrize(
    "invalid",
    [
        "duplicate-name",
        "missing-category",
        "reserved-name",
        "missing-resampling",
        "grid-crs",
        "grid-pixel-size",
        "grid-origin",
        "automatic-grid-crs",
        "automatic-grid-pixel-size",
        "automatic-grid-origin",
        "automatic-whole-raster",
        "automatic-mask-method",
        "reference-bilinear",
        "reference-cubic",
        "reference-average",
        "reference-mode",
    ],
)
def test_habitat_rejects_ambiguous_stack_or_preparation(
    habitat_definition: ModelDefinition, invalid: str
) -> None:
    """Reject ambiguous variables, invalid resampling and user grid overrides.

    Args:
        habitat_definition: Installed Habitat recipe with fixture settings.
        invalid: Invalid variable choices or preparation submitted by the caller.
    """
    layer = {
        "name": "spatial_fold" if invalid == "reserved-name" else "environment",
        "source": {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-aaaaaaaaaaaaaaaaaaaaaaaa",
        },
    }
    preparation: dict[str, Any] = {
        "resampling": {
            "predictor_0": "nearest",
            "response_0": "nearest",
            "reference_mask": "nearest",
        },
    }
    if invalid == "missing-resampling":
        del preparation["resampling"]["reference_mask"]
    elif invalid.startswith("reference-"):
        preparation["resampling"]["reference_mask"] = invalid.removeprefix("reference-")
    elif invalid.removeprefix("automatic-") == "grid-crs":
        preparation["crs"] = "EPSG:6933"
    elif invalid.removeprefix("automatic-") == "grid-pixel-size":
        preparation["pixelSize"] = [750, 750]
    elif invalid.removeprefix("automatic-") == "grid-origin":
        preparation["origin"] = [0, 0]
    request = ModelRunRequest(
        requestId="invalid-habitat-run",
        label="Invalid stack",
        utcOffsetMinutes=0,
        model={
            "id": habitat_definition.id,
            "version": habitat_definition.version,
            "definitionSha256": habitat_definition.digest,
        },
        inputs={
            "stack": {
                "predictors": [layer],
                "responses": [
                    {
                        **layer,
                        "name": (
                            "environment"
                            if invalid == "duplicate-name"
                            else "condition"
                        ),
                    }
                ],
                "categoricalPredictor": (
                    "missing" if invalid == "missing-category" else layer["name"]
                ),
            },
            "area": {"kind": "wholeRaster"},
            "references": {"kind": "raster", "source": layer["source"]},
            "habitat_mask": None,
            "preparation": preparation,
        },
        parameters={},
    )
    if invalid.startswith("automatic-"):
        request.inputs["stack"] = {"kind": "earthEngine", "year": 2018}
        if invalid == "automatic-whole-raster":
            request.inputs["preparation"]["resampling"] = {"reference_mask": "nearest"}
        else:
            request.inputs["area"] = {
                "kind": "selectedArea",
                "selectedBounds": {
                    "west": -110,
                    "south": 45,
                    "east": -109,
                    "north": 46,
                },
            }
            if invalid.startswith("automatic-grid-"):
                request.inputs["preparation"]["resampling"] = {
                    "reference_mask": "nearest"
                }
    if "grid-" in invalid:
        baseline = request.model_copy(deep=True)
        baseline.inputs["preparation"] = {
            "resampling": request.inputs["preparation"]["resampling"]
        }
        build_model_calculation_request(baseline, ModelRegistry((habitat_definition,)))
    with pytest.raises(ProcessingError) as error:
        build_model_calculation_request(request, ModelRegistry((habitat_definition,)))
    assert error.value.code == "invalid_model_inputs"


def test_habitat_exports_private_predictor_source(
    habitat_definition: ModelDefinition,
) -> None:
    """Keep a published predictor's identity when it is nested inside a stack.

    Args:
        habitat_definition: Installed recipe with small-fixture scientific settings.
    """
    file = JobInputFile("c" * 32, "d" * 32, "e" * 64, 321, "image/tiff", "result")
    private = {
        "kind": "runArtifact",
        "jobId": file.run_id,
        "artifactId": file.artifact_id,
    }
    catalog = {
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": "geotiff-aaaaaaaaaaaaaaaaaaaaaaaa",
    }
    request = ModelRunRequest(
        requestId="private-habitat-run",
        label="Private predictor",
        utcOffsetMinutes=0,
        model={
            "id": habitat_definition.id,
            "version": habitat_definition.version,
            "definitionSha256": habitat_definition.digest,
        },
        inputs={
            "stack": {
                "predictors": [{"name": "environment", "source": private}],
                "responses": [{"name": "condition", "source": catalog}],
                "categoricalPredictor": "environment",
            },
            "area": {"kind": "wholeRaster"},
            "references": {"kind": "raster", "source": catalog},
            "habitat_mask": None,
            "preparation": {
                "resampling": {
                    "predictor_0": "nearest",
                    "response_0": "nearest",
                    "reference_mask": "nearest",
                },
            },
        },
        parameters={},
    )
    calculation, invocation = build_model_calculation_request(
        request, ModelRegistry((habitat_definition,))
    )
    operation = get_model_operation("habitat.condition.v1")
    submission = build_model_job_submission(
        operation.queue(calculation, {}),
        invocation,
        None,
        {
            name: file if name == "predictor_0" else (1, 2, 3, 4)
            for name in operation.extra_sources(calculation)
        },
    )
    document = RunDocument.model_validate(
        parse_yaml(
            export_model_job_yaml(
                {
                    "id": "a" * 32,
                    "operation": "model.run.v1",
                    "status": "queued",
                    "created_at": datetime.now(timezone.utc),
                    "presentation": {"utcOffsetMinutes": 0},
                    "retained_metadata": submission.retained_metadata,
                },
                run=True,
            ),
            run=True,
        )
    )
    assert document.invocation.inputs["stack"]["predictors"][0]["source"] == private
    assert document.invocation.inputs["preparation"] == request.inputs["preparation"]
    assert document.execution.sources == {}
    assert document.execution.additionalSources["predictor_0"].sha256 == file.sha256
    assert document.execution.additionalSources["predictor_0"].bytes == file.size
