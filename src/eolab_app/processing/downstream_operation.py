"""Bind downstream recipes to the existing Processing admission and worker lifecycle."""

from pathlib import Path
from typing import Any, Callable

from eolab_app.processing.aggregate_models import AggregateArea
from eolab_app.processing.downstream_models import (
    DownstreamRequest,
    QueuedDownstream,
    DownstreamPlan,
    DownstreamNumericalPolicy,
    RasterStartingMask,
    VectorStartingMask,
)
from eolab_app.processing.downstream_calculation import (
    DownstreamSources,
    downstream_process_target,
)
from eolab_app.processing.model_yaml import compute_document_checksum
from eolab_app.processing.models import Artifact, PreparedJobPlan, ProcessingError
from eolab_app.processing.operation_context import OperationContext
from eolab_app.processing.clip_models import RasterClipLimits
from eolab_app.raster.models import AuthorizedRaster, CatalogRasterRequest
from eolab_app.raster.source_models import RasterSourceReference


def bind_downstream(
    inputs: dict[str, Any], parameters: dict[str, Any], request_id: str, label: str
) -> DownstreamRequest:
    """Bind a recipe's selected inputs and parameters to a downstream request.

    Args:
        inputs: Mask, server-resolved hydrology snapshot and values raster.
        parameters: Buffer, optional cutoff and summary formula.
        request_id: Stable model submission identifier.
        label: User's result label.

    Returns:
        Validated downstream inputs with no paths or copied geometry.

    Raises:
        ValidationError: If any input or parameter violates the operation contract.
    """
    return DownstreamRequest(requestId=request_id, label=label, **inputs, **parameters)


def downstream_inputs(
    value: DownstreamRequest | QueuedDownstream | DownstreamPlan,
) -> DownstreamRequest:
    """Read the captured inputs from a request or stored downstream specification.

    Args:
        value: Validated request, queued job or prepared plan.

    Returns:
        The same captured downstream inputs at every lifecycle stage.
    """
    if isinstance(value, QueuedDownstream):
        return value.request
    return value.inputs if isinstance(value, DownstreamPlan) else value


def get_values_source(
    value: DownstreamRequest | QueuedDownstream | DownstreamPlan,
) -> RasterSourceReference:
    """Return the native values raster that supplies the downstream summary.

    Args:
        value: Request or stored downstream specification.

    Returns:
        Catalog raster identity or owned result-file reference.
    """
    return downstream_inputs(value).values


def get_additional_sources(
    value: DownstreamRequest | QueuedDownstream | DownstreamPlan,
) -> dict[str, CatalogRasterRequest]:
    """Declare DEM and optional raster-mask inputs for admission and staleness checks.

    Args:
        value: Request or stored downstream specification.

    Returns:
        Additional catalog rasters keyed by stable operation argument names.
    """
    request = downstream_inputs(value)
    result = {"dem": request.hydrology.definition.dem}
    if isinstance(request.starting_mask, RasterStartingMask):
        result["starting_mask"] = request.starting_mask.source
    return result


def get_uploaded_polygon(request: DownstreamRequest) -> None:
    """Report that downstream masks use catalog selections rather than polygon uploads.

    Args:
        request: Validated operation request.

    Returns:
        None; there is no upload to copy during admission.
    """
    return None


def queue_downstream(
    request: DownstreamRequest, polygons: AggregateArea | None
) -> PreparedJobPlan:
    """Queue downstream inputs without sharing work with another model run.

    Args:
        request: Captured operation inputs.
        polygons: Always absent for the downstream input contract.

    Returns:
        Path-free queued specification awaiting measured worker admission.
    """
    queued = QueuedDownstream(request=request)
    return PreparedJobPlan(
        operation=queued.operation,
        specification=queued.model_dump(mode="json", by_alias=True),
        summary={},
        reserved_bytes=0,
    )


async def resolve_downstream_sources(
    context: OperationContext, request: DownstreamRequest, values: AuthorizedRaster
) -> DownstreamSources:
    """Resolve original vector selections and verify the prepared DEM identity.

    Args:
        context: Worker capabilities with captured additional raster identities.
        request: Captured starting mask and prepared hydrology definition.
        values: Already authorized primary values raster.

    Returns:
        Ephemeral native paths and exact selection readers.

    Raises:
        ProcessingError: If selections are unavailable or prepared terrain changed.
        SelectionUnavailableError: If a vector source changed or is unavailable.
    """
    if context.areas is None:
        raise ProcessingError(
            "selection_unavailable", "Catalog vector reading is unavailable.", 409
        )
    if (
        compute_document_checksum(context.rasters["dem"].source_signature.to_catalog())
        != request.hydrology.demSignature
    ):
        raise ProcessingError(
            "hydrology_changed",
            "The prepared DEM changed. Validate its hydrology configuration again.",
            409,
        )
    network = await context.areas.resolve_for_sampling(
        request.hydrology.watershedSelection
    )
    starting = (
        await context.areas.resolve_for_sampling(request.starting_mask.selection)
        if isinstance(request.starting_mask, VectorStartingMask)
        else None
    )
    return DownstreamSources(
        {
            "values": values.source_path,
            **{name: source.source_path for name, source in context.rasters.items()},
        },
        network,
        starting,
    )


async def prepare_downstream(
    context: OperationContext, queued: QueuedDownstream, authorized: AuthorizedRaster
) -> PreparedJobPlan:
    """Measure downstream watershed expansion and source work in the supervised process.

    Args:
        context: Existing worker source, native and resource capabilities.
        queued: Captured downstream request.
        authorized: Primary values raster authorized by the worker.

    Returns:
        Prepared native windows and the required disk reservation.

    Raises:
        ProcessingError: If preparation or source verification fails.
        ProcessDeadlineError: If preparation exceeds its admitted time.
    """
    sources = await resolve_downstream_sources(context, queued.request, authorized)
    status, result = await context.run_native(
        downstream_process_target,
        ("plan", (sources, queued.request, context.limits)),
        context.limits.plan_timeout_seconds,
        context.native,
    )
    if status != "ok":
        raise ProcessingError(*result)
    spec = result.model_copy(update={"sourceChecksum": context.source_checksum})
    await check_downstream_execution(context, spec)
    return PreparedJobPlan(
        operation=spec.operation,
        specification=spec.model_dump(mode="json", by_alias=True),
        summary={},
        reserved_bytes=spec.reservedBytes,
    )


async def prepare_downstream_execution(
    context: OperationContext, spec: DownstreamPlan, authorized: AuthorizedRaster
) -> tuple[DownstreamSources, DownstreamPlan]:
    """Resolve current native sources before executing the admitted downstream plan.

    Args:
        context: Worker capabilities and additional authorized rasters.
        spec: Stored path-free plan.
        authorized: Primary values raster with its accepted identity.

    Returns:
        Ephemeral native sources and the unchanged numerical plan.

    Raises:
        ProcessingError: If a private values checksum changed or source access fails.
    """
    if spec.sourceChecksum != context.source_checksum:
        raise ProcessingError(
            "source_changed", "The values raster changed after preparation.", 409
        )
    return await resolve_downstream_sources(context, spec.inputs, authorized), spec


async def check_downstream_execution(
    context: OperationContext, spec: DownstreamPlan
) -> None:
    """Recheck watershed and starting-vector identities before result publication.

    Args:
        context: Existing catalog selection reader.
        spec: Executed inputs and their immutable source predicates.

    Raises:
        SelectionUnavailableError: If a vector changed or lost access.
    """
    await context.areas.resolve_for_sampling(spec.inputs.hydrology.watershedSelection)
    if isinstance(spec.inputs.starting_mask, VectorStartingMask):
        await context.areas.resolve_for_sampling(spec.inputs.starting_mask.selection)


def select_downstream_execution(
    spec: DownstreamPlan, context: OperationContext, reserved_bytes: int
) -> tuple[Callable[..., None], str, RasterClipLimits]:
    """Select sequential downstream execution after verifying the disk reservation.

    Args:
        spec: Prepared operation plan.
        context: Worker deployment limits.
        reserved_bytes: Disk capacity granted by the existing job store.

    Returns:
        The supervised native target, action and worker limits.

    Raises:
        ProcessingError: If the reservation is insufficient.
    """
    if reserved_bytes < spec.reservedBytes:
        raise ProcessingError(
            "insufficient_disk_reservation",
            "The downstream run needs a new disk reservation. Submit it again.",
            409,
        )
    return downstream_process_target, "calculate", context.limits


def describe_downstream_policy(spec: DownstreamPlan) -> DownstreamNumericalPolicy:
    """Describe the actual routing, distance and value policies of a prepared run.

    Args:
        spec: Prepared plan with effective model parameters.

    Returns:
        Versioned numerical rules for Run YAML and provenance.
    """
    return DownstreamNumericalPolicy(
        bufferMetres=spec.inputs.buffer_m, cutoffMetres=spec.inputs.cutoff_m
    )


def describe_downstream_result(
    summary: dict[str, Any], artifact: dict[str, Any]
) -> dict[str, Any]:
    """Expose completed downstream summary rows through the shared statistics contract.

    Args:
        summary: Captured operation metadata.
        artifact: Published primary statistics file and numerical rows.

    Returns:
        Scalar rows; every run performs its own calculation.
    """
    return {"rows": artifact["rows"], "cacheHit": False}


def describe_downstream_outcome(artifact: dict[str, Any]) -> dict[str, Any]:
    """Retain the downstream summary in Run YAML after its files expire.

    Args:
        artifact: Completed statistics artifact.

    Returns:
        Scientific outcome fields; the common manifest records each raster.
    """
    return {"statistics": artifact["rows"]}


async def skip_downstream_cache(
    context: OperationContext, spec: DownstreamPlan, directory: Path
) -> None:
    """Require fresh routing and outputs for each downstream model run.

    Args:
        context: Current worker capabilities.
        spec: Captured prepared plan.
        directory: Private attempt directory.

    Returns:
        None; there is no cross-run result reuse.
    """
    return None


def skip_downstream_cache_values(spec: DownstreamPlan, artifact: Artifact) -> None:
    """Keep downstream values out of the single-raster summary cache.

    Args:
        spec: Completed downstream plan.
        artifact: Completed owned outputs.

    Returns:
        None; downstream identities are not shared cache keys.
    """
    return None
