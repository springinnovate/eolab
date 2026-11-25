"""Calculate a raster formula inside a selected area on one output grid."""

from collections.abc import Iterator, Mapping
from contextlib import ExitStack
from dataclasses import dataclass, field
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import time
from typing import Any, Literal, cast

from affine import Affine
import numpy as np
from numpy.typing import NDArray
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.features import bounds
from rasterio.windows import Window
from shapely.geometry import box, mapping

from eolab_app.catalog_selection import (
    ResolvedCatalogSelection,
    SelectionUnavailableError,
    VectorSelection,
)
from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.polygon_areas import PolygonAreaReference
from eolab_app.processing.aggregate_models import AggregateArea, RasterAggregateLimits
from eolab_app.processing.artifacts import write_progress
from eolab_app.processing.model_result_contracts import RasterResultGrid
from eolab_app.processing.models import Artifact, PreparedJobPlan, ProcessingError
from eolab_app.processing.operation_context import OperationContext
from eolab_app.processing.raster_calculator_models import (
    CustomRasterGrid,
    MatchRasterGrid,
    QueuedRasterCalculator,
    RasterCalculatorRequest,
    RasterCalculatorPolicy,
    RasterCalculatorSpec,
    RasterFormulaInput,
)
from eolab_app.processing.raster_expression import evaluate_pixel_expression, walk
from eolab_app.processing.raster_input import validate_supported_raster
from eolab_app.processing.raster_mask import temporary_polygon_mask
from eolab_app.processing.raster_operations import bind_area_arguments
from eolab_app.processing.raster_output import write_float64_cog
from eolab_app.processing.raster_preparation import (
    RasterGrid,
    calculate_raster_grid,
    open_warped_raster,
    project_preparation_box,
    read_preparation_polygons,
    read_warped_tile,
)
from eolab_app.projected_boundary import BoundaryConvergenceError
from eolab_app.raster.bounded_window import project_polygons_to_output_grid
from eolab_app.raster.geotiff_crs import GeoTiffReader
from eolab_app.raster.models import Wgs84Bounds
from eolab_app.raster.source_models import RasterSourceReference


@dataclass(frozen=True)
class RasterCalculatorSources:
    """Hold worker-only paths for raster bindings and a resolved polygon selection."""

    rasters: Mapping[str, Path]
    vector: ResolvedCatalogSelection | None


@dataclass(frozen=True)
class RasterCalculatorArtifact(Artifact):
    """Describe the verified GeoTIFF and its valid output-cell count."""

    valid_pixels: int
    media_type: str = field(default="image/tiff", kw_only=True)


def bind_raster_calculator(
    inputs: dict[str, Any],
    parameters: dict[str, Any],
    request_id: str,
    label: str,
) -> RasterCalculatorRequest:
    """Bind the calculator recipe's formula and analysis area to a run.

    Args:
        inputs: Captured recipe input values.
        parameters: Unused recipe settings. The calculator configures its inputs directly.
        request_id: Retry identity owned by model admission.
        label: Display name owned by the model run.
    Returns:
        Calculator request with one selected area and validated raster bindings.
    Raises:
        ValueError: If the formula settings or analysis area are invalid.
    """
    return RasterCalculatorRequest(
        calculation=RasterFormulaInput.model_validate(inputs["calculation"]),
        **bind_area_arguments(inputs["area"]),
    )


def calculator_raster_sources(
    value: RasterCalculatorRequest | QueuedRasterCalculator | RasterCalculatorSpec,
) -> dict[str, RasterSourceReference]:
    """Declare the raster identities that model admission and execution must authorize.

    Args:
        value: Submitted, queued or prepared calculator inputs.
    Returns:
        All path-free raster identities keyed by their stable variables.
    """
    request = value.request if isinstance(value, QueuedRasterCalculator) else value
    if isinstance(request, RasterCalculatorSpec):
        request = request.inputs
    return {layer.alias: layer.source for layer in request.calculation.layers}


def calculator_polygon_inputs(
    request: RasterCalculatorRequest,
) -> dict[str, PolygonAreaReference]:
    """Declare an owned drawing for retention at model admission.

    Args:
        request: Validated calculator request.
    Returns:
        The drawing reference under the area role, or an empty mapping.
    """
    return {"area": request.polygonArea} if request.polygonArea is not None else {}


def calculator_vector_selections(
    request: RasterCalculatorRequest,
) -> dict[str, VectorSelection]:
    """Declare the original vector to authorize and retain for the run.

    Args:
        request: Validated calculator request.
    Returns:
        The vector selection under the area role, or an empty mapping.
    """
    return (
        {"area": request.catalogSelection}
        if request.catalogSelection is not None
        else {}
    )


def queue_raster_calculator(
    request: RasterCalculatorRequest, polygons: dict[str, AggregateArea]
) -> PreparedJobPlan:
    """Queue a path-free formula and its retained drawing for an independent run.

    Args:
        request: Validated calculator settings and selected area.
        polygons: Authorized drawing geometry copied by model admission by input role.
    Returns:
        Durable worker input with the formula, bindings, and retained area.
    """
    queued = QueuedRasterCalculator(request=request, polygonArea=polygons.get("area"))
    return PreparedJobPlan(
        operation=queued.operation,
        specification=queued.model_dump(mode="json", by_alias=True),
        summary={},
    )


async def resolve_calculator_sources(
    context: OperationContext, request: RasterCalculatorRequest
) -> RasterCalculatorSources:
    """Collect the authorized files and resolve the original vector predicate.

    Args:
        context: Worker-supplied authorization and original vector reader.
        request: Accepted calculator inputs.
    Returns:
        Ephemeral native worker arguments containing the authorized paths.
    Raises:
        ProcessingError: If an accepted vector selection cannot be read.
    """
    vector = None
    if request.catalogSelection is not None:
        if context.areas is None:
            raise ProcessingError(
                "selection_unavailable", "The selected polygons are unavailable.", 409
            )
        try:
            vector = await context.areas.resolve_for_sampling(request.catalogSelection)
        except SelectionUnavailableError as error:
            raise ProcessingError("selection_unavailable", error.detail, 409) from error
    return RasterCalculatorSources(
        {alias: raster.source_path for alias, raster in context.rasters.items()}, vector
    )


async def prepare_raster_calculator(
    context: OperationContext, queued: QueuedRasterCalculator, primary: None
) -> PreparedJobPlan:
    """Plan and record the grid while the existing worker supervises native work.

    Args:
        context: Authorized sources and native process for the active attempt.
        queued: Accepted calculator request and optional retained drawing.
        primary: No primary source. The calculator declares all named inputs.
    Returns:
        Recoverable calculator inputs and the exact planned output grid.
    Raises:
        ProcessingError: If the area, grid, or inputs cannot be prepared.
    """
    sources = await resolve_calculator_sources(context, queued.request)
    status, value = await context.run_native(
        raster_calculator_process, ("plan", (sources, queued)), None, context.native
    )
    if status != "ok":
        raise ProcessingError(*value)
    prepared = cast(RasterCalculatorSpec, value)
    return PreparedJobPlan(
        operation=prepared.operation,
        specification=prepared.model_dump(mode="json", by_alias=True),
        summary={},
    )


async def prepare_raster_calculator_execution(
    context: OperationContext, spec: RasterCalculatorSpec, primary: None
) -> tuple[RasterCalculatorSources, RasterCalculatorSpec]:
    """Resolve authorized original sources for a prepared or recovered run.

    Args:
        context: Worker authorization for this attempt.
        spec: Accepted formula and exact grid.
        primary: No primary source. All raster bindings are already authorized.
    Returns:
        Picklable worker inputs containing the private paths and saved specification.
    Raises:
        ProcessingError: If the selected vector is unavailable.
    """
    return await resolve_calculator_sources(context, spec.inputs), spec


def referenced_rasters(calculation: RasterFormulaInput) -> set[str]:
    """Return the variable names whose values contribute to the output formula.

    Args:
        calculation: Validated bindings and parsed formula.
    Returns:
        The distinct aliases to prepare and evaluate.
    """
    return {
        cast(str, node.value)
        for node in walk(calculation.formula)
        if node.op in {"source", "area_max"}
    }


def project_calculator_area(
    request: RasterCalculatorRequest,
    polygon_area: AggregateArea | None,
    vector: ResolvedCatalogSelection | None,
    crs: CRS,
    pixel_size: tuple[float, float],
) -> tuple[dict[str, object], ...]:
    """Read the exact selected polygons in the calculation CRS.

    Args:
        request: Accepted area selection.
        polygon_area: Retained committed geometry for an owned drawing.
        vector: Authorized original selection for a catalog or private vector.
        crs: Output CRS independent of the raster sources' coverage.
        pixel_size: X/Y cell sizes for refining projected edges.
    Returns:
        Projected polygons with interior rings for calculating bounds and masking.
    Raises:
        ProcessingError: If the polygon selection is empty or cannot be projected.
    """
    try:
        if vector is not None:
            return read_preparation_polygons(vector, crs, pixel_size=pixel_size)
        if request.samplingBox is not None:
            return (
                project_preparation_box(
                    request.samplingBox, crs, pixel_size, seam_aware=True
                ),
            )
        if polygon_area is not None:
            geometries = polygon_area.geometries
        else:
            decimals = cast(Wgs84Bounds, request.selectedBounds).canonical_tuple()
            geometries = (mapping(box(*decimals)),)
        return project_polygons_to_output_grid("EPSG:4326", crs, geometries, pixel_size)
    except SelectionUnavailableError as error:
        raise ProcessingError("selection_unavailable", error.detail, 409) from error
    except BoundaryConvergenceError as error:
        raise ProcessingError(
            "invalid_calculator_area",
            "The selected area crosses a cut in the output projection or cannot "
            "be projected accurately at this cell size. "
            "Choose another projection or run each side separately.",
        ) from error
    except (ValueError, rasterio.errors.RasterioError) as error:
        raise ProcessingError(
            "invalid_calculator_area",
            "Could not project the selected area. Check the selection and output projection.",
        ) from error


def plan_calculator_grid(
    sources: RasterCalculatorSources, queued: QueuedRasterCalculator
) -> RasterCalculatorSpec:
    """Place the selected area's bounds on the reference or custom grid.

    Args:
        sources: Authorized source files for this attempt.
        queued: Accepted settings, including a retained drawing when selected.
    Returns:
        Path-free specification for the worker with its exact output grid.
    Raises:
        ProcessingError: If a referenced raster, grid choice or area is invalid.
    """
    request = queued.request
    choice = request.calculation.grid
    origin = (0.0, 0.0)
    required = referenced_rasters(request.calculation)
    if isinstance(choice, MatchRasterGrid):
        required.add(choice.alias)
        with (
            rasterio.Env(OSR_WKT_FORMAT="WKT2_2019"),
            GeoTiffReader(sources.rasters[choice.alias]) as reference,
        ):
            axes = reference.transform
            if axes.b != 0 or axes.d != 0 or axes.a <= 0 or axes.e >= 0:
                raise ProcessingError(
                    "invalid_reference_grid",
                    "Choose a custom grid to use a reference raster whose cells are not north-up.",
                )
            crs = reference.crs
            pixel_size = (axes.a, -axes.e)
            origin = (axes.c, axes.f)
    else:
        custom = cast(CustomRasterGrid, choice)
        try:
            crs = CRS.from_string(custom.crs)
        except rasterio.errors.CRSError as error:
            raise ProcessingError(
                "invalid_output_projection", "Enter a valid EPSG projection."
            ) from error
        pixel_size = custom.pixelSize
    for layer in request.calculation.layers:
        if layer.alias in required:
            path = sources.rasters[layer.alias]
            with rasterio.open(path) as dataset:
                try:
                    validate_supported_raster(dataset, path)
                except ProcessingError as error:
                    raise ProcessingError(
                        error.code,
                        f"Raster {layer.alias} cannot be used. {error.detail}",
                        error.status,
                    ) from error
    if crs is None or not (crs.is_projected or crs.is_geographic):
        raise ProcessingError(
            "invalid_output_projection", "Choose a projected or geographic CRS."
        )
    polygons = project_calculator_area(
        request, queued.polygonArea, sources.vector, crs, pixel_size
    )
    extent = bounds({"type": "GeometryCollection", "geometries": polygons})
    grid = calculate_raster_grid(extent, crs, pixel_size, origin)
    if grid.width <= 0 or grid.height <= 0:
        raise ProcessingError(
            "invalid_calculator_area", "Choose a larger area or a smaller cell size."
        )
    return RasterCalculatorSpec(
        inputs=request,
        polygonArea=queued.polygonArea,
        grid=RasterResultGrid(
            crs=crs.to_wkt(version="WKT2_2019"),
            transform=tuple(grid.transform)[:6],
            width=grid.width,
            height=grid.height,
            dtype="float64",
        ),
    )


def iter_calculator_tiles(
    destination: rasterio.io.DatasetWriter,
    rasters: Mapping[str, rasterio.io.DatasetReader],
    polygon_mask: rasterio.io.DatasetReader | None,
) -> Iterator[tuple[Window, dict[str, NDArray[np.float64]]]]:
    """Read the selected rasters on each output tile inside the analysis area.

    Args:
        destination: Staging raster whose blocks partition the output grid.
        rasters: Aligned readers needed for this pass, keyed by formula variable.
        polygon_mask: Inclusion mask on the same grid, or None for the entire grid.
    Yields:
        Output window and masked samples, or an empty mapping for an excluded tile.
    """
    for _, window in destination.block_windows(1):
        inside = (
            None if polygon_mask is None else polygon_mask.read(1, window=window) != 0
        )
        samples = {}
        if inside is None or inside.any():
            samples = {
                alias: read_warped_tile(raster, window, inside)
                for alias, raster in rasters.items()
            }
        yield window, samples


def write_calculator_tiles(
    rasters: Mapping[str, rasterio.io.DatasetReader],
    polygon_mask: rasterio.io.DatasetReader | None,
    spec: RasterCalculatorSpec,
    directory: Path,
) -> tuple[Path, int]:
    """Evaluate aligned GDAL windows and stage the raster before publication.

    Args:
        rasters: Open, lazy GDAL warps keyed by the referenced variables.
        polygon_mask: Byte mask on the output grid, or None for the entire grid.
        spec: Prepared formula and grid.
        directory: Private attempt directory.
    Returns:
        Staging file and valid-cell count.
    Raises:
        ProcessingError: If no cell has all inputs or valid arithmetic.
        RasterioError: If the input tiles or output raster cannot be read or written.
        OSError: If a native tile or output cannot be read or written.
    """
    grid = spec.grid
    stage = directory / "calculated.tif"
    valid_pixels = 0
    has_shared_cells = False
    tile_side = 512
    tile_count = ((grid.width + tile_side - 1) // tile_side) * (
        (grid.height + tile_side - 1) // tile_side
    )
    formula = spec.inputs.calculation.formula
    maximum_aliases = {
        cast(str, node.value) for node in walk(formula) if node.op == "area_max"
    }
    maximum_rasters = {alias: rasters[alias] for alias in maximum_aliases}
    total = tile_count * (2 if maximum_rasters else 1)
    write_progress(directory, "calculating_raster", 0, total, unit="tiles")
    last_progress = time.monotonic()
    with rasterio.open(
        stage,
        "w",
        driver="GTiff",
        count=1,
        dtype="float64",
        crs=CRS.from_wkt(grid.crs),
        transform=Affine(*grid.transform),
        width=grid.width,
        height=grid.height,
        nodata=np.nan,
        tiled=True,
        blockxsize=tile_side,
        blockysize=tile_side,
        compress="DEFLATE",
        BIGTIFF="IF_SAFER",
    ) as destination:
        area_maxima = dict.fromkeys(maximum_rasters, float("nan"))
        if maximum_rasters:
            for index, (_, samples) in enumerate(
                iter_calculator_tiles(destination, maximum_rasters, polygon_mask), 1
            ):
                for alias, values in samples.items():
                    area_maxima[alias] = float(
                        np.fmax.reduce(values, axis=None, initial=area_maxima[alias])
                    )
                if time.monotonic() - last_progress > 0.5:
                    write_progress(
                        directory, "calculating_raster", index, total, unit="tiles"
                    )
                    last_progress = time.monotonic()
        for index, (window, samples) in enumerate(
            iter_calculator_tiles(destination, rasters, polygon_mask),
            total - tile_count + 1,
        ):
            shape = (int(window.height), int(window.width))
            if not samples:
                result = np.full(shape, np.nan)
            else:
                if not has_shared_cells:
                    shared = np.ones(shape, dtype=bool)
                    for values in samples.values():
                        shared &= np.isfinite(values)
                    has_shared_cells = bool(shared.any())
                result = evaluate_pixel_expression(formula, samples, area_maxima)
                valid_pixels += int(np.count_nonzero(np.isfinite(result)))
            destination.write(result, 1, window=window)
            if time.monotonic() - last_progress > 0.5:
                write_progress(
                    directory, "calculating_raster", index, total, unit="tiles"
                )
                last_progress = time.monotonic()
    if not has_shared_cells:
        raise ProcessingError(
            "no_shared_raster_coverage",
            "No cell in the selected area has values in every raster used in the formula.",
        )
    if not valid_pixels:
        raise ProcessingError(
            "no_valid_calculator_values",
            "The formula produced no valid cells. Check operations such as division and powers.",
        )
    write_progress(directory, "calculating_raster", total, total, unit="tiles")
    return stage, valid_pixels


def calculate_raster(
    sources: RasterCalculatorSources,
    spec: RasterCalculatorSpec,
    directory: Path,
    limits: RasterAggregateLimits,
) -> RasterCalculatorArtifact:
    """Warp, mask and calculate one Cloud Optimized GeoTIFF in a worker attempt.

    Args:
        sources: Authorized original files and polygon selection.
        spec: Prepared grid and accepted formula settings.
        directory: Private attempt directory for scratch and completed files.
        limits: Existing Processing lifecycle and geometry settings.
    Returns:
        Completed, verified primary result and its valid-cell count.
    Raises:
        ProcessingError: If the area, arithmetic, or completed result is invalid.
        OSError: If a raster or attempt file cannot be read or written.
    """
    grid = RasterGrid(
        CRS.from_wkt(spec.grid.crs),
        Affine(*spec.grid.transform),
        spec.grid.width,
        spec.grid.height,
    )
    polygons = project_calculator_area(
        spec.inputs,
        spec.polygonArea,
        sources.vector,
        grid.crs,
        (grid.transform.a, -grid.transform.e),
    )
    calculation = spec.inputs.calculation
    names = referenced_rasters(calculation)
    inputs = {
        layer.alias: (
            sources.rasters[layer.alias],
            Resampling["average" if layer.resampling == "mean" else layer.resampling],
        )
        for layer in calculation.layers
        if layer.alias in names
    }
    write_progress(directory, "preparing_rasters", 0, len(inputs), unit="rasters")
    encodings: dict[str, dict[str, str | None]] = {}
    rasters: dict[str, rasterio.io.DatasetReader] = {}
    with (
        TemporaryDirectory(prefix="warp-", dir=directory) as temporary,
        ExitStack() as readers,
    ):
        scratch = Path(temporary)
        for index, (alias, (path, method)) in enumerate(inputs.items()):
            source, rasters[alias] = readers.enter_context(
                open_warped_raster(path, method, grid, scratch / f"input-{index}.vrt")
            )
            encodings[alias] = {
                "scale": str(source.scales[0]),
                "offset": str(source.offsets[0]),
                "unit": source.units[0],
            }
        polygon_mask = readers.enter_context(
            temporary_polygon_mask(
                next(iter(rasters.values())),
                Window(0, 0, grid.width, grid.height),
                polygons,
                scratch,
                limits,
            )
        )
        write_progress(
            directory, "preparing_rasters", len(inputs), len(inputs), unit="rasters"
        )
        stage, valid_pixels = write_calculator_tiles(
            rasters, polygon_mask, spec, directory
        )
    write_progress(directory, "creating_cog", 0, 1, unit="files")
    file = write_float64_cog(
        stage,
        directory / "result.tif",
        spec.grid,
        valid_pixels,
        None,
        reference=(
            sources.rasters[spec.inputs.calculation.grid.alias]
            if isinstance(spec.inputs.calculation.grid, MatchRasterGrid)
            else None
        ),
        output_name="raster",
        description="The raster calculator result",
    )
    write_progress(directory, "creating_cog", 1, 1, unit="files")
    provenance = {
        "operation": spec.operation,
        "inputs": spec.inputs.model_dump(mode="json", by_alias=True, exclude_none=True),
        "grid": spec.grid.model_dump(mode="json"),
        "policy": RasterCalculatorPolicy().model_dump(mode="json"),
        "sourceBands": encodings,
        "validPixels": valid_pixels,
        "outputSha256": file.sha256,
    }
    (directory / "provenance.json").write_text(
        json.dumps(provenance, allow_nan=False), encoding="utf-8"
    )
    return RasterCalculatorArtifact(file.size, file.sha256, file.filename, valid_pixels)


def raster_calculator_process(
    queue: ProcessResultWriter,
    action: Literal["plan", "calculate"],
    arguments: tuple[Any, ...],
) -> None:
    """Send a native calculator result or path-free error to the worker supervisor.

    Args:
        queue: Supervisor-owned one-result writer.
        action: Grid planning or raster computation.
        arguments: Picklable input arguments for that action.
    """
    try:
        result = (
            plan_calculator_grid(*arguments)
            if action == "plan"
            else calculate_raster(*arguments)
        )
        queue.put(("ok", result))
    except ProcessingError as error:
        queue.put(("error", (error.code, error.detail, error.status)))
    except (OSError, OverflowError, ValueError, rasterio.errors.RasterioError):
        queue.put(
            (
                "error",
                (
                    "calculator_raster_io_failed",
                    "A raster or output grid could not be read or written. Check the layer, projection, and cell sizes.",
                    409,
                ),
            )
        )
