"""Run Habitat condition with authorized inputs in a Processing attempt."""

from contextlib import ExitStack
from dataclasses import asdict, dataclass, field
import hashlib
import json
from pathlib import Path
from typing import Any, Literal
from zipfile import ZipFile, ZIP_STORED

import numpy as np
import pandas as pd
import rasterio
from rasterio.windows import Window, transform as window_transform
from rasterio.features import geometry_window
from shapely.geometry import mapping, shape, box
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from nhi_terrestrial_integrity_modeling.habitat_training import IntegrityConfiguration
from nhi_terrestrial_integrity_modeling.prepared_rasters import RasterBand
from nhi_terrestrial_integrity_modeling.prepared_runner import run_habitat_condition

from eolab_app.bounded_vector import PolygonRasterizer
from eolab_app.catalog_selection import ResolvedCatalogSelection
from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing.aggregate_models import AggregateArea, RasterAggregateLimits
from eolab_app.processing.artifact_manifest import ProducedFile
from eolab_app.processing.artifacts import write_progress
from eolab_app.processing.clip_models import ClipGrid
from eolab_app.processing.habitat_models import HabitatPlan, HabitatRequest
from eolab_app.processing.models import Artifact, ProcessingError
from eolab_app.processing.raster_input import select_area, count_native_raster_blocks
from eolab_app.processing.raster_mask import temporary_polygon_mask


@dataclass(frozen=True)
class HabitatSources:
    """Authorized file paths and vector readers for one native calculation.

    Attributes:
        rasters: Input files keyed by predictor/response slot or mask role.
        vectors: Independently filtered AOI and reference-site sources.
    """

    rasters: dict[str, Path]
    vectors: dict[str, ResolvedCatalogSelection]


@dataclass(frozen=True)
class HabitatArtifact(Artifact):
    """Completed Reference similarity map and supporting diagnostic files."""

    valid_pixels: int
    media_type: str = field(default="image/tiff", kw_only=True)


def read_habitat_area(
    dataset: rasterio.io.DatasetReader, area: AggregateArea, sources: HabitatSources
) -> BaseGeometry:
    """Read the exact selected AOI in the input raster's coordinate system.

    Args:
        dataset: Open primary predictor supplying the common grid.
        area: Captured box, polygon input, filtered vector or whole-raster area.
        sources: Authorized vector readers for this attempt.

    Returns:
        Process-local AOI geometry for the upstream sampler and prediction mask.

    Raises:
        ProcessingError: If the AOI is empty, unavailable or outside the raster.
    """
    if area.kind == "wholeRaster":
        return box(*dataset.bounds)
    selection = select_area(
        dataset,
        area.kind,
        area.bounds,
        area.geometries,
        None,
        sources.vectors.get("area"),
        max_retained_polygon_bytes=None,
    )
    polygons = selection.projected_geometries
    try:
        geometries = (
            polygons.iter_projected_polygons()
            if isinstance(polygons, PolygonRasterizer)
            else iter(polygons)
        )
        return unary_union([shape(geometry) for geometry in geometries])
    finally:
        if isinstance(polygons, PolygonRasterizer):
            polygons.close()


def plan_habitat(
    sources: HabitatSources, request: HabitatRequest, area: AggregateArea
) -> HabitatPlan:
    """Describe the source-aligned output crop without scanning raster values.

    Args:
        sources: Authorized input paths and AOI vector reader.
        request: Captured layer choices and model-owned scientific settings.
        area: Prepared area descriptor; filtered geometry is not persisted.

    Returns:
        Path-free input plan and common output grid for Processing and Run YAML.

    Raises:
        ProcessingError: If the selected AOI cannot be read or projected.
        RasterioError: If the primary predictor cannot be opened or has no overlap.
    """
    with rasterio.open(sources.rasters["predictor_0"]) as dataset:
        aoi = read_habitat_area(dataset, area, sources)
        window = geometry_window(dataset, [mapping(aoi)])
        width, height = int(window.width), int(window.height)
        grid = ClipGrid(
            crs=dataset.crs.to_string(),
            transform=tuple(window_transform(window, dataset.transform))[:6],
            window=tuple(int(value) for value in window.flatten()),
            width=width,
            height=height,
            dtype="float32",
            nodata="-9999",
            nativeBlocks=count_native_raster_blocks(dataset, window),
            estimatedRawBytes=width * height * 4,
        )
    return HabitatPlan(inputs=request, area=area, grid=grid)


def describe_habitat_file(path: Path, name: str, media_type: str) -> ProducedFile:
    """Measure one completed output for the ordinary publication manifest.

    Args:
        path: Closed result file in the private attempt directory.
        name: Registered operation output name.
        media_type: GeoTIFF for the primary map or ZIP for its diagnostics.

    Returns:
        File size, checksum and download name for publication integrity checks.
    """
    with path.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
    return ProducedFile(
        name=name,
        storage_name=path.name,
        filename=f"{name}{path.suffix}",
        media_type=media_type,
        size=path.stat().st_size,
        sha256=checksum,
    )


def calculate_habitat(
    sources: HabitatSources,
    plan: HabitatPlan,
    directory: Path,
    limits: RasterAggregateLimits,
) -> HabitatArtifact:
    """Fit selected reference sites and prepare the runner's maps for publication.

    Args:
        sources: Authorized raster paths and independently filtered vector inputs.
        plan: Captured stack, AOI and scientific settings.
        directory: Private attempt directory owned and cleaned by Processing.
        limits: Existing Processing settings used by temporary polygon rasterization.

    Returns:
        Primary Reference similarity metadata and a ZIP of diagnostic TIFFs.

    Raises:
        ValueError: If the upstream reader or numerical calculation rejects inputs.
        RasterioError: If a raster cannot be read or written.
        OSError: If result creation or cleanup fails.
    """
    request = plan.inputs
    settings = request.settings
    with ExitStack() as resources:
        dataset = resources.enter_context(rasterio.open(sources.rasters["predictor_0"]))
        aoi = read_habitat_area(dataset, plan.area, sources)
        if request.references.kind == "vector":
            selection = select_area(
                dataset,
                "catalogSelection",
                None,
                (),
                None,
                sources.vectors["reference_sites"],
                max_retained_polygon_bytes=None,
            )
            polygons = selection.projected_geometries
            if isinstance(polygons, PolygonRasterizer):
                resources.callback(polygons.close)
            reference = resources.enter_context(
                temporary_polygon_mask(
                    dataset,
                    Window(0, 0, dataset.width, dataset.height),
                    polygons,
                    directory,
                    limits,
                )
            )
            reference_path = Path(reference.name)
        else:
            reference_path = sources.rasters["reference_mask"]
        configuration = IntegrityConfiguration(
            **{
                name: getattr(settings, name)
                for name in IntegrityConfiguration.__dataclass_fields__
            }
        )
        result = run_habitat_condition(
            [
                RasterBand(layer.name, sources.rasters[f"predictor_{index}"])
                for index, layer in enumerate(request.stack.predictors)
            ],
            [
                RasterBand(layer.name, sources.rasters[f"response_{index}"])
                for index, layer in enumerate(request.stack.responses)
            ],
            RasterBand("reference_sites", reference_path),
            aoi,
            directory / "habitat-output",
            configuration,
            categorical_predictor_name=request.stack.categoricalPredictor,
            samples_per_class_per_block=settings.samples_per_class_per_block,
            random_seed=settings.random_seed,
            tile_size_pixels=settings.tile_size_pixels,
            tile_origin=settings.tile_origin,
            window_size_pixels=settings.window_size_pixels,
            covariance_shrinkage=settings.covariance_shrinkage,
            assessment_mask=(
                RasterBand("habitat_mask", sources.rasters["habitat_mask"])
                if request.habitat_mask is not None
                else None
            ),
            progress=lambda phase, complete, total: write_progress(
                directory, phase, complete, total, unit="steps"
            ),
        )
    result.reference_similarity.replace(directory / "result.tif")
    with ZipFile(directory / "diagnostics.zip", "w", compression=ZIP_STORED) as archive:
        for name in (
            "expected_reference",
            "observed_minus_expected",
            "standardized_deviation",
            "inference_status",
        ):
            path = getattr(result, name)
            archive.write(path, arcname=path.name)
            path.unlink()
    (directory / "habitat-output").rmdir()
    with rasterio.open(directory / "result.tif") as similarity:
        valid_pixels = sum(
            int(np.count_nonzero(similarity.read_masks(1, window=window)))
            for _, window in similarity.block_windows(1)
        )
    primary = describe_habitat_file(
        directory / "result.tif", "reference_similarity", "image/tiff"
    )
    diagnostics = describe_habitat_file(
        directory / "diagnostics.zip", "diagnostics", "application/zip"
    )
    artifact = HabitatArtifact(
        size=primary.size,
        sha256=primary.sha256,
        filename=primary.filename,
        valid_pixels=valid_pixels,
        additional_outputs=(diagnostics,),
    )
    fitted = result.fitted
    provenance = {
        **plan.model_dump(mode="json", by_alias=True),
        "fit": {
            "predictorCoverage": json.loads(
                fitted.prepared_data.predictor_coverage.to_json(orient="records")
            ),
            "responseCoverage": json.loads(
                fitted.response_coverage.to_json(orient="records")
            ),
            "validationMetrics": json.loads(
                pd.DataFrame(
                    {
                        name: response.overall_metrics
                        for name, response in fitted.responses.items()
                    }
                ).to_json()
            ),
        },
        **asdict(artifact),
    }
    (directory / "provenance.json").write_text(
        json.dumps(provenance, allow_nan=False), encoding="utf-8"
    )
    return artifact


def habitat_process_target(
    queue: ProcessResultWriter,
    operation: Literal["plan", "calculate"],
    arguments: tuple[Any, ...],
) -> None:
    """Execute Habitat planning or calculation under the existing supervisor.

    Args:
        queue: Worker-owned result writer.
        operation: Requested planning or calculation phase.
        arguments: Validated, authorized arguments for that phase.
    """
    try:
        value = (
            plan_habitat(*arguments)
            if operation == "plan"
            else calculate_habitat(*arguments)
        )
        queue.put(("ok", value))
    except ProcessingError as error:
        queue.put(("error", (error.code, error.detail, error.status)))
    except ValueError as error:
        detail = str(error)
        locations = {path: name for name, path in arguments[0].rasters.items()}
        if operation == "calculate":
            locations[arguments[2]] = "run files"
        for path, name in locations.items():
            detail = detail.replace(str(path), name).replace(path.as_posix(), name)
        queue.put(("error", ("invalid_habitat_inputs", detail, 422)))
    except (OSError, rasterio.errors.RasterioError):
        queue.put(
            (
                "error",
                (
                    "habitat_read_failed",
                    "A Habitat input or result file could not be read or written.",
                    409,
                ),
            )
        )
    except Exception:
        queue.put(
            (
                "error",
                (
                    "habitat_calculation_failed",
                    "Habitat condition could not be calculated.",
                    500,
                ),
            )
        )
