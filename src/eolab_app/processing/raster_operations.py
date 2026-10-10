"""Adapters for existing raster operations used by Processing and YAML recipes.

Each operation owns its numerical policy, preparation and result interpretation.
The worker supplies source authorization, admission, cancellation and file publication.
"""

import asyncio
from pathlib import Path
from typing import Any, Callable, Literal

from pydantic import BaseModel, ConfigDict

from eolab_app.bounded_vector import summary_process, READ_SECONDS
from eolab_app.processing.aggregate_models import (
    AggregateArea,
    AggregateArtifact,
    AggregateJobRequest,
    AggregateSpec,
    UnpreparedCalculation,
    RasterAggregateLimits,
    GroundAreaPlan,
)
from eolab_app.processing.clip_models import (
    ClipArea,
    ClipInputs,
    ClipJobRequest,
    ClipSpec,
    UnpreparedClip,
    RasterClipLimits,
)
from eolab_app.processing.models import PreparedJobPlan, ProcessingError, Artifact
from eolab_app.processing.shared_calculations import identify_shared_calculation
from eolab_app.processing.raster_aggregate import (
    aggregate_process_target,
    write_statistics_result,
)
from eolab_app.processing.raster_clip import clip_process_target
from eolab_app.processing.job_preparation import prepare_aggregate_job, prepare_clip_job
from eolab_app.processing.raster_mask import estimate_calculation_disk_bytes
from eolab_app.processing.calculation_cache import (
    calculation_result_cache_keys,
    restore_cached_calculation_plan,
    restore_cached_calculation_rows,
    prepare_calculation_values_for_cache,
)
from eolab_app.processing.polygon_areas import PolygonAreaReference
from eolab_app.raster.models import AuthorizedRaster, CatalogRasterRequest
from eolab_app.raster.source_models import RasterSourceReference
from eolab_app.processing.operation_context import OperationContext


async def prepare_raster_execution(
    context: OperationContext,
    spec: AggregateSpec | ClipSpec,
    authorized: AuthorizedRaster,
) -> tuple[Path, AggregateSpec | ClipSpec]:
    """Resolve the exact analysis area before running a summary or clip.

    Args:
        context: Worker source, selection and lifecycle capabilities.
        spec: Stored summary or clip plan.
        authorized: Raster authorized for this attempt.

    Returns:
        Native source path and plan with an ephemeral resolved vector selection.

    Raises:
        ProcessingError: If the source checksum or selection is unavailable.
    """
    if spec.sourceChecksum != context.source_checksum:
        raise ProcessingError(
            "source_changed",
            "The prepared input does not match the accepted raster file.",
            409,
        )
    if spec.area.kind == "catalogSelection":
        if context.areas is None:
            raise ProcessingError(
                "selection_unavailable", "Catalog selection reader is unavailable.", 409
            )
        resolved = await context.areas.resolve_for_sampling(spec.area.catalogSelection)
        spec = spec.model_copy(
            update={"area": spec.area.model_copy(update={"resolved": resolved})}
        )
    return authorized.source_path, spec


async def check_raster_execution(
    context: OperationContext, spec: AggregateSpec | ClipSpec
) -> None:
    """Recheck vector selection identity after a summary or clip finishes.

    Args:
        context: Worker capabilities used to resolve the selection.
        spec: Executed plan with its ephemeral resolved selection.

    Raises:
        SelectionUnavailableError: If the selected source changed or lost access.
    """
    if spec.area.kind == "catalogSelection":
        await context.areas.resolve_for_sampling(spec.area.catalogSelection)


class SummaryNumericalPolicy(BaseModel):
    """Numerical rules actually used by the native raster-summary operation.

    ``sourceValidity`` versions the combined mask, NoData and finite-value rule.
    None preserves historical run documents written before that declaration.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    version: Literal["raster.aggregate.v1"]
    grid: Literal["native"]
    resampling: Literal["none"]
    numericInclusion: Literal["cell_center"]
    nodata: Literal["exclude_source_nodata_and_nonfinite"] = (
        "exclude_source_nodata_and_nonfinite"
    )
    valueDomain: Literal["stored_native_values"]
    groundArea: GroundAreaPlan | None = None
    sourceValidity: Literal["finite-unmasked-non-nodata-v1"] | None = None


class ClipNumericalPolicy(BaseModel):
    """Numerical rules actually used by the native raster-clip operation.

    ``sourceValidity`` versions the combined mask, NoData and finite-value rule.
    None preserves historical run documents written before that declaration.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    version: Literal["raster.clip.v1"]
    grid: Literal["native"]
    resampling: Literal["none"]
    numericInclusion: Literal["all_touched"]
    nodata: Literal["preserve_source_nodata_and_mask_invalid"] = (
        "preserve_source_nodata_and_mask_invalid"
    )
    valueDomain: Literal["stored_native_values"]
    overviewResampling: Literal["nearest"]
    sourceValidity: Literal["finite-unmasked-non-nodata-v1"] | None = None


async def prepare_summary(
    context: OperationContext,
    queued: UnpreparedCalculation,
    authorized: AuthorizedRaster,
) -> PreparedJobPlan:
    """Measure summary work using its existing cache, polygon and native-grid rules.

    Args:
        context: Worker capabilities and resource limits for this attempt.
        queued: Validated summary inputs, including any owned polygon copy.
        authorized: Source already authorized and signature-checked by the worker.

    Returns:
        Prepared summary plan and its disk reservation.

    Raises:
        ProcessingError: If the selection, native planning or resource limits fail.
    """
    request = queued.request
    alias = next(iter(request.sources))
    signature = tuple(authorized.source_signature.to_catalog())
    resolved = None
    if request.catalogSelection:
        if context.areas is None:
            raise ProcessingError(
                "selection_unavailable",
                "Vector selection reader is unavailable.",
                409,
            )
        resolved = await context.areas.resolve_for_sampling(request.catalogSelection)
    spec = None
    if context.reuse_results:
        cached_results = await asyncio.to_thread(
            context.jobs.get_cached_calculation_results,
            calculation_result_cache_keys(request, signature, context.source_checksum),
        )
        spec = restore_cached_calculation_plan(
            request,
            signature,
            cached_results,
            queued.polygonArea,
            context.source_checksum,
        )
    # Cache reuse is selected by the caller; fresh runs measure their own grid.
    if spec is None:
        if queued.polygonArea:
            area = queued.polygonArea
        elif request.wholeRaster:
            area = AggregateArea(kind="wholeRaster")
        elif request.selectedBounds:
            bounds = request.selectedBounds
            area = AggregateArea(
                kind="bounds",
                bounds=(bounds.west, bounds.south, bounds.east, bounds.north),
            )
        else:
            success, summary = await context.run_native(
                summary_process, (resolved,), READ_SECONDS, context.native
            )
            if not success:
                raise ProcessingError("selection_unavailable", summary, 409)
            area = AggregateArea(
                kind="catalogSelection",
                bounds=summary["bbox"],
                catalogSelection=request.catalogSelection,
                resolved=resolved,
            )
        status, grid = await context.run_native(
            aggregate_process_target,
            (
                "plan",
                (
                    authorized.source_path,
                    area,
                    request.calculations,
                    alias,
                    context.aggregate_limits,
                    request.targetChunkPixels,
                    request.pixelPoint,
                ),
            ),
            context.limits.plan_timeout_seconds,
            context.native,
        )
        if status != "ok":
            raise ProcessingError(*grid)
        if resolved is not None:
            await context.areas.resolve_for_sampling(request.catalogSelection)
        spec = AggregateSpec(
            sources=request.sources,
            sourceSignature=signature,
            sourceChecksum=context.source_checksum,
            calculations=request.calculations,
            pixelPoint=request.pixelPoint,
            area=area,
            grid=grid,
        )
    prepared = prepare_aggregate_job(spec, context.aggregate_limits)
    return prepared


async def prepare_clip(
    context: OperationContext,
    queued: UnpreparedClip,
    authorized: AuthorizedRaster,
) -> PreparedJobPlan:
    """Measure clip work using its existing native-grid and selected-polygon rules.

    Args:
        context: Worker capabilities and resource limits for this attempt.
        queued: Validated explicit clip inputs.
        authorized: Source already authorized and signature-checked by the worker.

    Returns:
        Prepared clip plan and its disk reservation.

    Raises:
        ProcessingError: If the selection, native planning or resource limits fail.
    """
    request = queued.request
    source = get_clip_source(queued)
    signature = tuple(authorized.source_signature.to_catalog())
    if request.selectedBounds:
        area = ClipArea(kind="bounds", bounds=request.selectedBounds.canonical_tuple())
    else:
        if context.areas is None:
            raise ProcessingError(
                "selection_unavailable",
                "Vector selection reader is unavailable.",
                409,
            )
        resolved = await context.areas.resolve_for_sampling(request.catalogSelection)
        success, summary = await context.run_native(
            summary_process, (resolved,), READ_SECONDS, context.native
        )
        if not success:
            raise ProcessingError("selection_unavailable", summary, 409)
        area = ClipArea(
            kind="catalogSelection",
            bounds=summary["bbox"],
            catalogSelection=request.catalogSelection,
            resolved=resolved,
        )
    status, grid = await context.run_native(
        clip_process_target,
        ("plan", (authorized.source_path, area, context.limits)),
        context.limits.plan_timeout_seconds,
        context.native,
    )
    if status != "ok":
        raise ProcessingError(*grid)
    if request.catalogSelection:
        await context.areas.resolve_for_sampling(request.catalogSelection)
    spec = ClipSpec(
        source=source,
        sourceSignature=signature,
        sourceChecksum=context.source_checksum,
        area=area,
        grid=grid,
    )
    return prepare_clip_job(spec)


def bind_summary(
    inputs: dict[str, Any], parameters: dict[str, Any], request_id: str, label: str
) -> AggregateJobRequest:
    """Bind validated recipe arguments to the summary operation's public request.

    Args:
        inputs: Raster and area keyed by operation argument name.
        parameters: Effective expression keyed by operation parameter name.
        request_id: Stable submission retry identifier.
        label: User's calculation label.

    Returns:
        Validated existing summary request.

    Raises:
        ValueError: If arguments violate the summary request contract.
    """
    return AggregateJobRequest(
        requestId=request_id,
        sources={"a": inputs["raster"]},
        calculations=[{"label": label, "expression": parameters["expression"]}],
        **bind_area_arguments(inputs["area"]),
    )


def bind_clip(
    inputs: dict[str, Any], parameters: dict[str, Any], request_id: str, label: str
) -> ClipJobRequest:
    """Bind validated recipe arguments to the clip operation's public request.

    Args:
        inputs: Raster and explicit area keyed by operation argument name.
        parameters: Empty mapping required by the clip contract.
        request_id: Stable submission retry identifier.
        label: Run label; clip filenames remain source-derived.

    Returns:
        Validated existing clip request.

    Raises:
        ValueError: If arguments violate the clip request contract.
    """
    return ClipJobRequest(
        requestId=request_id,
        source=inputs["raster"],
        **bind_area_arguments(inputs["area"]),
    )


def bind_area_arguments(area: dict[str, Any]) -> dict[str, Any]:
    """Translate a validated model area into existing raster-operation arguments.

    Args:
        area: Area already checked against the recipe's declared input type.

    Returns:
        The existing operation's explicit area keyword arguments.

    Raises:
        KeyError: If an internal caller supplies an unvalidated area kind.
    """
    fields = {
        "selectedArea": ("selectedBounds", "selectedBounds"),
        "catalogSelection": ("catalogSelection", "selection"),
        "polygonArea": ("polygonArea", "reference"),
    }
    if area["kind"] == "wholeRaster":
        return {"wholeRaster": True}
    argument, field = fields[area["kind"]]
    return {argument: area[field]}


def get_summary_source(
    value: AggregateJobRequest | UnpreparedCalculation | AggregateSpec,
) -> RasterSourceReference:
    """Return the source from a validated summary request or execution plan.

    Args:
        value: Summary request, queued inputs or prepared specification.

    Returns:
        The operation's catalog or owned published-raster reference.
    """
    return next(
        iter(
            (
                value.request if isinstance(value, UnpreparedCalculation) else value
            ).sources.values()
        )
    )


def get_clip_source(
    value: ClipJobRequest | UnpreparedClip | ClipSpec,
) -> RasterSourceReference:
    """Return the source from a validated clip request or execution plan.

    Args:
        value: Clip request, queued inputs or prepared specification.

    Returns:
        The operation's catalog or owned published-raster reference.
    """
    if isinstance(value, ClipSpec):
        return value.source
    request = value.request if isinstance(value, UnpreparedClip) else value
    return request.source or CatalogRasterRequest(
        collectionId=request.collection_id, itemId=request.item_id
    )


def get_summary_polygon(request: AggregateJobRequest) -> PolygonAreaReference | None:
    """Return the owned polygon reference requiring capture before summary admission.

    Args:
        request: Validated summary request.

    Returns:
        Uploaded-polygon reference, or None for other area kinds.
    """
    return request.polygonArea


def get_clip_polygon(request: ClipJobRequest) -> None:
    """Report that clipping accepts no uploaded polygon references.

    Args:
        request: Validated clip request.

    Returns:
        None; clip areas are explicit bounds or catalog predicates.
    """
    return None


def queue_summary(
    request: AggregateJobRequest, polygons: AggregateArea | None
) -> PreparedJobPlan:
    """Capture summary inputs for preparation by the existing worker.

    Args:
        request: Validated summary request.
        polygons: Owned uploaded polygons copied at admission, when requested.

    Returns:
        Queued plan with the ordinary sharing identity. Model admission removes
        that identity before storage so each model run remains independent.

    Raises:
        ValueError: If copied polygons do not match the request.
    """
    queued = UnpreparedCalculation(request=request, polygonArea=polygons)
    bounds = request.selectedBounds
    if bounds:
        area = {"kind": "bounds", "bounds": bounds.canonical_tuple()}
    elif polygons:
        area = {"kind": "polygons", "bounds": polygons.bounds}
    elif request.catalogSelection:
        area = {"kind": "catalogSelection", "bounds": None}
    else:
        area = {"kind": "wholeRaster", "bounds": None}
    summary = {
        "sources": {
            alias: source.model_dump(by_alias=True)
            for alias, source in request.sources.items()
        },
        "calculations": [item.model_dump() for item in request.calculations],
        "grid": None,
        "area": area,
    }
    return PreparedJobPlan(
        specification=queued.model_dump(mode="json", by_alias=True),
        summary=summary,
        reserved_bytes=0,
        operation=queued.operation,
        work_key=identify_shared_calculation(queued),
        presentation={"calculations": summary["calculations"]},
    )


def queue_clip(request: ClipJobRequest, polygons: None) -> PreparedJobPlan:
    """Capture explicit clip inputs for preparation by the existing worker.

    Args:
        request: Validated clip request.
        polygons: Always None under the clip input contract.

    Returns:
        Queued clip plan with its ordinary sharing identity and no native reads.
        Model admission removes the sharing identity before storage.
    """
    inputs = ClipInputs.model_validate(
        request.model_dump(exclude={"requestId"}, by_alias=True)
    )
    queued = UnpreparedClip(request=inputs)
    bounds = inputs.selectedBounds
    return PreparedJobPlan(
        specification=queued.model_dump(mode="json", by_alias=True),
        summary={
            "source": get_clip_source(request).model_dump(by_alias=True),
            "grid": None,
            "area": {
                "kind": "bounds" if bounds else "catalogSelection",
                "bounds": bounds.canonical_tuple() if bounds else None,
            },
        },
        reserved_bytes=0,
        operation=queued.operation,
        work_key=identify_shared_calculation(queued),
    )


def describe_summary_policy(spec: AggregateSpec) -> SummaryNumericalPolicy:
    """Describe the numerical rules resolved during summary preparation.

    Args:
        spec: Prepared summary grid and calculations.

    Returns:
        Actual summary policy, including fractional ground-area settings when used.
    """
    return SummaryNumericalPolicy(
        version="raster.aggregate.v1",
        grid="native",
        resampling="none",
        numericInclusion="cell_center",
        nodata="exclude_source_nodata_and_nonfinite",
        sourceValidity="finite-unmasked-non-nodata-v1",
        valueDomain="stored_native_values",
        groundArea=spec.grid.groundArea,
    )


def describe_clip_policy(spec: ClipSpec) -> ClipNumericalPolicy:
    """Describe the fixed native-grid rules used by the clip implementation.

    Args:
        spec: Prepared clip specification.

    Returns:
        Actual clip policy; recipe YAML cannot override these implementation facts.
    """
    return ClipNumericalPolicy(
        version="raster.clip.v1",
        grid="native",
        resampling="none",
        numericInclusion="all_touched",
        nodata="preserve_source_nodata_and_mask_invalid",
        sourceValidity="finite-unmasked-non-nodata-v1",
        valueDomain="stored_native_values",
        overviewResampling="nearest",
    )


def select_summary_execution(
    spec: AggregateSpec, context: OperationContext, reserved_bytes: int
) -> tuple[Callable[..., None], str, RasterAggregateLimits]:
    """Select native summary execution after checking its disk reservation.

    Args:
        spec: Prepared summary specification.
        context: Worker limits and execution capabilities.
        reserved_bytes: Capacity granted to this attempt by job storage.

    Returns:
        Native target, action and calculation limits.

    Raises:
        ProcessingError: If the reservation no longer covers the calculation.
    """
    if reserved_bytes < estimate_calculation_disk_bytes(spec, context.aggregate_limits):
        raise ProcessingError(
            "insufficient_disk_reservation",
            "This job reserved less disk space than its calculation now requires. Run the calculation again to reserve enough space.",
            409,
        )
    return aggregate_process_target, "calculate", context.aggregate_limits


def select_clip_execution(
    spec: ClipSpec, context: OperationContext, reserved_bytes: int
) -> tuple[Callable[..., None], str, RasterClipLimits]:
    """Select the existing native clip target and deployment limits.

    Args:
        spec: Prepared clip specification, including its conservative output reservation.
        context: Worker limits and execution capabilities.
        reserved_bytes: Capacity granted by job storage and enforced during publication.

    Returns:
        Native target, action and clipping limits.
    """
    return clip_process_target, "clip", context.limits


def describe_summary_result(
    summary: dict[str, Any], artifact: dict[str, Any]
) -> dict[str, Any]:
    """Describe scalar results produced by a completed summary operation.

    Args:
        summary: Persisted public operation metadata.
        artifact: Completed summary file and calculated values.

    Returns:
        Result-type fields, without file links or lifecycle decisions.
    """
    return {"rows": artifact["rows"], "cacheHit": False}


def describe_clip_result(
    summary: dict[str, Any], artifact: dict[str, Any]
) -> dict[str, Any]:
    """Describe the raster produced by a completed clip operation.

    Args:
        summary: Persisted public output grid, independent of YAML retention.
        artifact: Completed clip file and validity count.

    Returns:
        Raster-type fields, without file links or lifecycle decisions.
    """
    return {"grid": summary["grid"], "validPixels": artifact["valid_pixels"]}


def describe_summary_outcome(artifact: dict[str, Any]) -> dict[str, Any]:
    """Retain completed summary values in the existing Run YAML contract.

    Args:
        artifact: Completed summary file metadata and values.

    Returns:
        Operation-owned scientific outcome metadata.
    """
    return {"statistics": artifact["rows"]}


def describe_clip_outcome(artifact: dict[str, Any]) -> dict[str, Any]:
    """Retain completed clip file metadata in the Run YAML contract.

    Args:
        artifact: Completed clip file metadata and validity count.

    Returns:
        Operation-owned scientific outcome metadata without a download URL.
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


async def restore_summary_result(
    context: OperationContext, spec: AggregateSpec, directory: Path
) -> Artifact | None:
    """Write a summary result from complete cached values when available.

    Args:
        context: Existing cache access and worker limits.
        spec: Authorized, prepared calculation.
        directory: Private attempt directory already admitted for this job.

    Returns:
        Completed CSV artifact, or None when native execution is required.
    """
    if spec.cachedRows is not None:
        rows = [row.model_dump(mode="json") for row in spec.cachedRows]
    else:
        cached = await asyncio.to_thread(
            context.jobs.get_cached_calculation_results,
            calculation_result_cache_keys(spec),
        )
        rows = restore_cached_calculation_rows(spec, cached)
    # Keep these small writes synchronous so cancellation cannot race cleanup.
    return (
        write_statistics_result(spec, rows, directory, cache_hit=True)
        if rows is not None
        else None
    )


async def skip_clip_cache(
    context: OperationContext, spec: ClipSpec, directory: Path
) -> None:
    """Require native clip execution; scalar cached values cannot supply raster pixels.

    Args:
        context: Current worker capabilities.
        spec: Prepared clip specification.
        directory: Admitted private attempt directory.

    Returns:
        None, indicating that native execution is required.
    """
    return None


def collect_summary_cache_values(
    spec: AggregateSpec, artifact: AggregateArtifact
) -> dict[str, dict[str, object]] | None:
    """Return reusable scalar values from a newly calculated summary.

    Args:
        spec: Completed summary's prepared specification.
        artifact: Summary artifact containing rows and its cache-hit flag.

    Returns:
        Cache entries, or None if the result itself came from the cache.
    """
    return (
        None
        if artifact.cache_hit
        else prepare_calculation_values_for_cache(spec, artifact.rows)
    )


def skip_clip_cache_values(spec: ClipSpec, artifact: Artifact) -> None:
    """Keep completed raster files outside the scalar-summary cache.

    Args:
        spec: Completed clip's prepared specification.
        artifact: Completed clip artifact owned by this job.

    Returns:
        None; this operation creates no scalar cache entries.
    """
    return None
