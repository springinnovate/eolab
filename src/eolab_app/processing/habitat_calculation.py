"""Run Habitat condition with authorized inputs in a Processing attempt."""

from contextlib import ExitStack
from dataclasses import asdict, dataclass, field
import hashlib
import json
from math import ceil
from pathlib import Path
from typing import Any, Literal
from zipfile import ZipFile, ZIP_STORED

import numpy as np
import pandas as pd
import rasterio
from affine import Affine
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.windows import Window
from shapely.geometry import mapping, shape, box
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from nhi_terrestrial_integrity_modeling.habitat_training import IntegrityConfiguration
from nhi_terrestrial_integrity_modeling.prepared_rasters import RasterBand
from nhi_terrestrial_integrity_modeling.prepared_runner import run_habitat_condition

from eolab_app.bounded_vector import polygon_features
from eolab_app.catalog_selection import ResolvedCatalogSelection
from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing.aggregate_models import AggregateArea, RasterAggregateLimits
from eolab_app.processing.artifact_manifest import ProducedFile
from eolab_app.processing.artifacts import write_progress
from eolab_app.processing.clip_models import ClipGrid
from eolab_app.processing.habitat_models import HabitatCalculationInputs, HabitatRequest
from eolab_app.processing.models import Artifact, ProcessingError
from eolab_app.processing.raster_mask import temporary_polygon_mask
from eolab_app.processing.raster_preparation import (
    RasterGrid,
    calculate_raster_grid,
    prepare_raster_stack,
)
from eolab_app.raster.bounded_window import project_polygons_to_crs


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


def read_habitat_polygons(
    selection: ResolvedCatalogSelection, crs: CRS
) -> tuple[dict[str, object], ...]:
    """Read selected vector polygons in the calculation's coordinate system.

    Args:
        selection: Authorized original vector source and its exact filter.
        crs: Calculation CRS, independent of the input rasters' coverage.

    Returns:
        Projected polygons retained only inside this native calculation.

    Raises:
        ValueError: If no polygons were selected or a polygon cannot be projected.
        SelectionUnavailableError: If the original vector cannot be read.
    """
    with polygon_features(selection, limits=None) as features:
        polygons = tuple(
            projected
            for geometry in features
            for projected in project_polygons_to_crs(
                "EPSG:4326", crs, (geometry,), None
            )
        )
    if not polygons:
        raise ValueError("The vector selection contains no polygons.")
    return polygons


def read_habitat_area(
    area: AggregateArea,
    sources: HabitatSources,
    crs: CRS,
) -> BaseGeometry:
    """Read the complete selected AOI in the requested calculation CRS.

    Args:
        area: Captured box, polygon input, filtered vector or whole-raster area.
        sources: Authorized vectors and first-predictor path for a whole-raster AOI.
        crs: Requested calculation coordinate system.

    Returns:
        Process-local AOI geometry for the upstream sampler and prediction mask.

    Raises:
        ValueError: If selected polygons are empty or cannot be projected.
        SelectionUnavailableError: If the original vector cannot be read.
        RasterioError: If the whole-raster source cannot be opened.
    """
    if area.kind == "wholeRaster":
        with rasterio.open(sources.rasters["predictor_0"]) as dataset:
            footprint = {
                "type": "Polygon",
                "coordinates": [
                    [
                        dataset.transform * pixel
                        for pixel in (
                            (0, 0),
                            (dataset.width, 0),
                            (dataset.width, dataset.height),
                            (0, dataset.height),
                            (0, 0),
                        )
                    ]
                ],
            }
            polygons = project_polygons_to_crs(dataset.crs, crs, (footprint,), None)
    elif area.kind == "catalogSelection":
        polygons = read_habitat_polygons(sources.vectors["area"], crs)
    else:
        geometries = (
            (mapping(box(*area.bounds)),) if area.kind == "bounds" else area.geometries
        )
        polygons = project_polygons_to_crs("EPSG:4326", crs, geometries, None)
    return unary_union([shape(geometry) for geometry in polygons])


def prepare_habitat_inputs(
    sources: HabitatSources, request: HabitatRequest, area: AggregateArea
) -> HabitatCalculationInputs:
    """Calculate the AOI grid and collect the inputs for a Habitat calculation.

    Args:
        sources: Authorized input paths and AOI vector reader.
        request: Captured layer, preparation and model-owned scientific settings.
        area: Prepared area descriptor; filtered geometry is not persisted.

    Returns:
        Selected inputs, area descriptor and output grid for Processing and Run YAML.

    Raises:
        ValueError: If selected polygons are empty or cannot be projected.
        SelectionUnavailableError: If the original vector cannot be read.
        RasterioError: If the first predictor cannot be opened.
    """
    crs = CRS.from_user_input(request.preparation.crs)
    aoi = read_habitat_area(area, sources, crs)
    target = calculate_raster_grid(
        aoi.bounds, crs, request.preparation.pixelSize, request.preparation.origin
    )
    width, height = target.width, target.height
    grid = ClipGrid(
        crs=crs.to_string(),
        transform=tuple(target.transform)[:6],
        window=(0, 0, width, height),
        width=width,
        height=height,
        # The runner writes Reference similarity as float32/-9999, with values 0–1.
        # Temporary aligned inputs instead use float64/NaN.
        dtype="float32",
        nodata="-9999",
        nativeBlocks=ceil(width / 512) * ceil(height / 512),
        estimatedRawBytes=width * height * 4,
    )
    return HabitatCalculationInputs(inputs=request, area=area, grid=grid)


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
    prepared: HabitatCalculationInputs,
    directory: Path,
    limits: RasterAggregateLimits,
) -> HabitatArtifact:
    """Align inputs, fit reference sites and prepare the runner's maps for publication.

    Args:
        sources: Authorized raster paths and independently filtered vector inputs.
        prepared: Captured stack, AOI, output grid, resampling and scientific settings.
        directory: Private attempt directory owned and cleaned by Processing.
        limits: Existing Processing settings used by temporary polygon rasterization.

    Returns:
        Primary Reference similarity metadata and a ZIP of diagnostic TIFFs.

    Raises:
        ValueError: If the upstream reader or numerical calculation rejects inputs.
        RasterioError: If a raster cannot be read or written.
        OSError: If result creation or cleanup fails.
    """
    request = prepared.inputs
    settings = request.settings
    with ExitStack() as resources:
        grid = RasterGrid(
            crs=CRS.from_user_input(prepared.grid.crs),
            transform=Affine(*prepared.grid.transform),
            width=prepared.grid.width,
            height=prepared.grid.height,
        )
        aoi = read_habitat_area(prepared.area, sources, grid.crs)
        rasters = resources.enter_context(
            prepare_raster_stack(
                {
                    name: (path, Resampling[request.preparation.resampling[name]])
                    for name, path in sources.rasters.items()
                },
                grid,
                (mapping(aoi),),
                directory,
                limits,
                all_touched=False,
            )
        )
        dataset = resources.enter_context(rasterio.open(rasters["predictor_0"]))
        if request.references.kind == "vector":
            polygons = read_habitat_polygons(
                sources.vectors["reference_sites"], grid.crs
            )
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
            reference_path = rasters["reference_mask"]
        configuration = IntegrityConfiguration(
            **{
                name: getattr(settings, name)
                for name in IntegrityConfiguration.__dataclass_fields__
            }
        )
        result = run_habitat_condition(
            [
                RasterBand(layer.name, rasters[f"predictor_{index}"])
                for index, layer in enumerate(request.stack.predictors)
            ],
            [
                RasterBand(layer.name, rasters[f"response_{index}"])
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
                RasterBand("habitat_mask", rasters["habitat_mask"])
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
        **prepared.model_dump(mode="json", by_alias=True),
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
    operation: Literal["prepare", "calculate"],
    arguments: tuple[Any, ...],
) -> None:
    """Prepare Habitat inputs or run the calculation under the worker supervisor.

    Args:
        queue: Worker-owned result writer.
        operation: Prepare calculation inputs or calculate the Habitat outputs.
        arguments: Validated, authorized arguments for that phase.
    """
    try:
        value = (
            prepare_habitat_inputs(*arguments)
            if operation == "prepare"
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
