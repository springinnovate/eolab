"""Bind the polygon flow calculation to the existing Processing model lifecycle."""

from pathlib import Path
from typing import Any, Callable

from eolab_app.catalog_selection import ResolvedCatalogSelection
from eolab_app.processing.aggregate_models import RasterAggregateLimits
from eolab_app.processing.flow_area import (
    OPERATION,
    FlowAreaInputs,
    FlowAreaPlan,
    FlowAreaPolicy,
    QueuedFlowArea,
    flow_area_process_target,
)
from eolab_app.processing.models import PreparedJobPlan, ProcessingError
from eolab_app.processing.operation_context import OperationContext
from eolab_app.raster.models import AuthorizedRaster
from eolab_app.raster.source_models import RasterSourceReference

PROGRESS_DESCRIPTIONS: tuple[tuple[str, str], ...] = (
    ("flow_inputs", "Reading elevation and selected polygons"),
    ("flow_conditioning", "Filling depressions in the DEM"),
    ("flow_directions", "Calculating flow directions"),
    ("flow_upstream", "Tracing upstream area"),
    ("flow_downstream", "Tracing downstream paths"),
    ("flow_writing", "Writing the GeoTIFF mask"),
)


def bind_flow_area(
    inputs: dict[str, Any], parameters: dict[str, Any], request_id: str, label: str
) -> FlowAreaInputs:
    """Bind the model's DEM, selected features and two direction checkboxes.

    Args:
        inputs: Recipe-validated raster reference and vector selection.
        parameters: Validated upstream and downstream booleans.
        request_id: Retry identifier retained by the surrounding model service.
        label: User-facing run name retained by the surrounding model service.

    Returns:
        Path-free inputs for the flow-area calculation.

    Raises:
        ProcessingError: If neither checkbox is selected.
    """
    return FlowAreaInputs(
        dem=inputs["dem"],
        polygon=inputs["polygon"]["selection"],
        upstream=parameters["upstream"],
        downstream=parameters["downstream"],
    )


def get_dem_reference(
    value: FlowAreaInputs | QueuedFlowArea | FlowAreaPlan,
) -> RasterSourceReference:
    """Return the primary elevation raster reference for ordinary source authorization.

    Args:
        value: Accepted inputs, queued request or prepared execution plan.

    Returns:
        The captured DEM reference, which identifies a Catalog, upload or run file.
    """
    if isinstance(value, QueuedFlowArea):
        return value.request.dem
    if isinstance(value, FlowAreaPlan):
        return value.inputs.dem
    return value.dem


def queue_flow_area(request: FlowAreaInputs) -> PreparedJobPlan:
    """Prepare a durable, path-free submission for the existing model queue.

    Args:
        request: Validated DEM, polygon selection and flow directions.

    Returns:
        Initial job plan with the inputs needed to prepare the raster grid.
    """
    return PreparedJobPlan(
        operation=OPERATION,
        specification=QueuedFlowArea(request=request).model_dump(
            mode="json", by_alias=True
        ),
        summary={},
    )


async def prepare_flow_area(
    context: OperationContext, queued: QueuedFlowArea, dem: AuthorizedRaster
) -> PreparedJobPlan:
    """Read the authorized elevation raster's grid in the native worker.

    Args:
        context: Existing worker native execution and cancellation capabilities.
        queued: Path-free submission retained for this run.
        dem: Authorized original DEM resolved by the worker.

    Returns:
        A prepared job plan with the expected output raster grid.

    Raises:
        ProcessingError: If the DEM cannot supply a valid flow grid.
    """
    status, grid = await context.run_native(
        flow_area_process_target, ("plan", (dem.source_path,)), None, context.native
    )
    if status != "ok":
        raise ProcessingError(*grid)
    return PreparedJobPlan(
        operation=OPERATION,
        specification=FlowAreaPlan(inputs=queued.request, grid=grid).model_dump(
            mode="json", by_alias=True
        ),
        summary={},
    )


async def resolve_flow_sources(
    context: OperationContext, spec: FlowAreaPlan, dem: AuthorizedRaster
) -> tuple[tuple[Path, ResolvedCatalogSelection], FlowAreaPlan]:
    """Open the captured vector selection for the same authorized execution attempt.

    Args:
        context: Worker vector source reader with existing ownership and retention.
        spec: Captured vector predicate and native mask grid.
        dem: Original DEM already resolved and retained by the worker.

    Returns:
        Ephemeral native raster and vector source descriptions and the accepted plan.

    Raises:
        ProcessingError: If the vector selection reader is unavailable.
        SelectionUnavailableError: If the captured original source cannot be used.
    """
    if context.areas is None:
        raise ProcessingError(
            "selection_unavailable", "Vector source reading is unavailable.", 409
        )
    polygon = await context.areas.resolve_for_sampling(spec.inputs.polygon)
    return (dem.source_path, polygon), spec


def select_flow_execution(
    spec: FlowAreaPlan, context: OperationContext
) -> tuple[Callable[..., None], str, RasterAggregateLimits]:
    """Select the supervised flow-area calculation for a prepared job.

    Args:
        spec: Accepted flow directions and expected raster grid.
        context: Existing Processing worker settings.

    Returns:
        Native target, calculation action and polygon-mask settings.
    """
    return flow_area_process_target, "calculate", context.aggregate_limits


def describe_flow_policy(spec: FlowAreaPlan) -> FlowAreaPolicy:
    """Return the fixed routing and mask policy recorded with the run.

    Args:
        spec: Prepared job whose directions are retained with its input selection.

    Returns:
        The numerical policy used for either or both directions.
    """
    return FlowAreaPolicy()


def describe_flow_result(
    summary: dict[str, Any], artifact: dict[str, Any], policy: dict[str, Any] | None
) -> dict[str, Any]:
    """Describe the flow mask using the ordinary raster result fields.

    Args:
        summary: Persisted run summary, including the native result grid.
        artifact: Published GeoTIFF metadata and its valid-pixel count.
        policy: Recorded numerical settings, when retained.

    Returns:
        Raster grid and valid-pixel count for the run results view.
    """
    return {"grid": summary["grid"], "validPixels": artifact["valid_pixels"]}


def describe_flow_outcome(artifact: dict[str, Any]) -> dict[str, Any]:
    """Record the published GeoTIFF metadata in Run YAML.

    Args:
        artifact: Published GeoTIFF metadata and its valid-pixel count.

    Returns:
        Raster file name, size, checksum and count of valid pixels.
    """
    return {
        "statistics": None,
        "raster": {
            "filename": artifact["filename"],
            "bytes": artifact["size"],
            "sha256": artifact["sha256"],
            "validPixels": artifact["valid_pixels"],
        },
    }
