"""Admit downstream inputs and call the original WWF beneficiaries calculation.

All work runs sequentially in the existing supervised native process. Source
paths and geometries exist only in that process and its private attempt directory.
"""

from contextlib import chdir
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import rasterio
from rasterio.features import shapes
from rasterio.windows import Window
from shapely.geometry import shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from eolab_app.bounded_vector import polygon_records
from eolab_app.catalog_selection import (
    ResolvedCatalogSelection,
    SelectionUnavailableError,
)
from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing.aggregate_models import AggregateArtifact
from eolab_app.processing.clip_models import ClipGrid
from eolab_app.processing.downstream_models import (
    DownstreamLimits,
    DownstreamRequest,
    DownstreamPlan,
)
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.raster_input import (
    count_native_raster_blocks,
    validate_supported_raster,
)
from eolab_app.raster.source_contract import read_native_raster_window


@dataclass(frozen=True)
class DownstreamSources:
    """Authorized native inputs, retained only for the current worker phase.

    Attributes:
        rasters: Confined DEM, values and optional starting-mask paths.
        network: Current configured full watershed layer.
        starting: Filtered vector starting selection, if that input is a vector.
    """

    rasters: dict[str, Path]
    network: ResolvedCatalogSelection
    starting: ResolvedCatalogSelection | None


def read_starting_area_geometry(
    sources: DownstreamSources, limits: DownstreamLimits
) -> BaseGeometry:
    """Read the selected vector polygons or positive raster mask cells as a starting area.

    Args:
        sources: Authorized native inputs.
        limits: Shared job lifecycle settings.

    Returns:
        Process-local geometry used to find intersecting watershed partitions.

    Raises:
        ProcessingError: If the mask is empty or its source structure is unsupported.
    """
    if sources.starting is None:
        with rasterio.open(sources.rasters["starting_mask"]) as dataset:
            validate_supported_raster(dataset, sources.rasters["starting_mask"])
            window = Window(0, 0, dataset.width, dataset.height)
            values = read_native_raster_window(dataset, window)
            positive = (~np.ma.getmaskarray(values)) & (values.data > 0)
            if not positive.any():
                raise ProcessingError(
                    "empty_starting_mask",
                    "The starting raster has no positive valid cells.",
                    422,
                )
            from rasterio.warp import transform_geom

            polygons = []

            for geometry, _ in shapes(
                positive.astype(np.uint8), mask=positive, transform=dataset.transform
            ):
                polygon = shape(transform_geom(dataset.crs, "EPSG:4326", geometry))

                polygons.append(polygon)
            return unary_union(polygons)
    polygons = []

    with polygon_records(
        sources.starting,
        (),
        timeout_seconds=None,
        max_features=None,
        max_feature_coordinates=None,
    ) as records:
        for geometry, _ in records:
            polygon = shape(geometry)

            polygons.append(polygon)
    if not polygons:
        raise ProcessingError(
            "empty_starting_mask",
            "The starting filter matches no polygon features.",
            422,
        )
    return unary_union(polygons)


def describe_values_grid(dataset: rasterio.io.DatasetReader) -> ClipGrid:
    """Record the original values raster grid without scanning pixels or watersheds.

    Args:
        dataset: Open original values raster with validated source metadata.

    Returns:
        Full source grid for run provenance; the model chooses its own output grid.
    """
    window = Window(0, 0, dataset.width, dataset.height)
    return ClipGrid(
        crs=dataset.crs.to_wkt(),
        transform=tuple(dataset.transform)[:6],
        window=(0, 0, dataset.width, dataset.height),
        width=dataset.width,
        height=dataset.height,
        dtype=dataset.dtypes[0],
        nodata=None if dataset.nodata is None else str(dataset.nodata),
        nativeBlocks=count_native_raster_blocks(dataset, window),
        decodedBytes=0,
        estimatedRawBytes=0,
        reservedBytes=0,
    )


def plan_downstream(
    sources: DownstreamSources, request: DownstreamRequest, limits: DownstreamLimits
) -> DownstreamPlan:
    """Capture readable source metadata and leave hydrology decisions to the model.

    No watershed traversal, geometry coverage scan or elevation-cell preflight
    runs here. The configured sources are passed unchanged to the original model.

    Args:
        sources: Authorized native source paths and vector descriptors.
        request: Model-configured sources and user inputs for this calculation.
        limits: Job lifecycle settings and pit-search cutoff saved for this run.

    Returns:
        Source grid, current watershed identity and effective pit-filling setting.

    Raises:
        ProcessingError: If a raster is missing, unreadable or violates the source
            reader's supported file contract.
        SelectionUnavailableError: If the watershed changed during preparation.
    """
    grid = None
    for name in ("dem", "values"):
        try:
            with rasterio.open(sources.rasters[name]) as dataset:
                validate_supported_raster(dataset, sources.rasters[name])
                if name == "values":
                    grid = describe_values_grid(dataset)
        except (OSError, rasterio.errors.RasterioIOError) as error:
            label = "configured DEM" if name == "dem" else "values raster"
            raise ProcessingError(
                "source_unavailable",
                f"The model's {label} is missing or unreadable. Check the source and try again.",
                422,
            ) from error
    sources.network.require_current()
    return DownstreamPlan(
        inputs=request,
        grid=grid,
        watershedSelection=sources.network.selection,
        reservedBytes=0,
        pit_fill_search_limit=limits.pit_fill_search_limit,
    )


def calculate_downstream(
    sources: DownstreamSources,
    spec: DownstreamPlan,
    directory: Path,
    limits: DownstreamLimits,
) -> AggregateArtifact:
    """Invoke the unchanged WWF calculation with the captured source files.

    Execution is sequential in the native worker. Its current directory is
    temporarily the private attempt so upstream helpers using relative scratch
    paths work with a read-only application mount and remain run-owned.

    Args:
        sources: Reauthorized original files and selections.
        spec: Captured source metadata, inputs and numerical settings.
        directory: Private workspace owned by this attempt.
        limits: Shared job lifecycle settings.

    Returns:
        The upstream model's rasters and total, plus requested formula metadata.

    Raises:
        ProcessingError: If the original calculation fails on its supplied inputs.
    """
    from eolab_app.processing.downstream_runner import run_original_downstream

    workspace = directory.resolve()
    with chdir(workspace):
        return run_original_downstream(
            sources,
            spec,
            workspace,
            limits,
            read_starting_area_geometry(sources, limits),
        )


def downstream_process_target(
    writer: ProcessResultWriter, action: str, arguments: tuple[Any, ...]
) -> None:
    """Run an allowlisted downstream kernel and return sanitized results to its supervisor.

    Args:
        writer: Existing single-result native IPC writer.
        action: Preparation or calculation selected by the trusted adapter.
        arguments: Authorized paths and validated operation inputs.
    """
    try:
        with rasterio.Env(GDAL_CACHEMAX=32 * 1024**2, GDAL_NUM_THREADS="1"):
            if action == "plan":
                result = plan_downstream(*arguments)
            elif action == "calculate":
                result = calculate_downstream(*arguments)
            else:
                raise ValueError("Unknown downstream operation")
        writer.put(("ok", result))
    except ProcessingError as error:
        writer.put(("error", (error.code, error.detail, error.status)))
    except SelectionUnavailableError:
        writer.put(
            (
                "error",
                (
                    "source_changed",
                    "A selected vector changed. Select it again before running the model.",
                    409,
                ),
            )
        )
    except Exception:
        writer.put(
            (
                "error",
                (
                    "processing_failed",
                    "The downstream calculation could not process these inputs safely.",
                    500,
                ),
            )
        )
