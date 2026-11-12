"""Check saved Habitat areas in a durable job and queue their missing inputs."""

import asyncio
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
from typing import Any, Literal, cast

from eolab_app.catalog_selection import (
    CatalogSelectionReader,
    SelectionUnavailableError,
)
from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing.habitat_cache import get_habitat_cache_coverage
from eolab_app.processing.habitat_calculation import describe_habitat_file
from eolab_app.processing.habitat_earth_engine import HabitatEarthEngineRuntime
from eolab_app.processing.habitat_preparation import (
    build_habitat_input_preparation_submission,
    get_retained_habitat_preparation_inputs,
)
from eolab_app.processing.habitat_preparation_models import (
    BULK_OPERATION,
    HABITAT_PREPARATION_OWNER,
    OPERATION,
    HabitatBulkPreparationArtifact,
    HabitatBulkPreparationInputs,
    HabitatBulkPreparationOutcome,
    HabitatBulkPreparationReport,
    HabitatBulkPreparationSpec,
    HabitatBulkPreparationSummary,
    HabitatInputPreparationRequest,
    QueuedHabitatBulkPreparation,
)
from eolab_app.processing.model_yaml import encode_canonical_json
from eolab_app.processing.models import PreparedJobPlan, ProcessingError
from eolab_app.processing.operation_context import OperationContext


def bind_habitat_bulk_preparation(
    inputs: dict[str, Any], parameters: dict[str, Any], request_id: str, name: str
) -> HabitatBulkPreparationInputs:
    """Reject recipe binding because only administration may capture retry history.

    Args:
        inputs: Unused recipe inputs.
        parameters: Unused recipe settings.
        request_id: Unused recipe request identifier.
        name: Unused recipe label.

    Raises:
        ProcessingError: Always; bulk preparation is an administrator command.
    """
    raise ProcessingError(
        "administration_required",
        "Start bulk input preparation from Habitat administration.",
        403,
    )


def build_habitat_bulk_preparation_submission(
    inputs: HabitatBulkPreparationInputs,
) -> PreparedJobPlan:
    """Queue the captured saved-area scope without reading geometry or cache files.

    Args:
        inputs: Administrator-admitted saved areas and stable child request IDs.

    Returns:
        Ordinary durable job plan with a small public count and no captured geometry.
    """
    queued = QueuedHabitatBulkPreparation(request=inputs)
    summary = HabitatBulkPreparationSummary(areaCount=len(inputs.areas)).model_dump()
    return PreparedJobPlan(
        operation=BULK_OPERATION,
        specification=queued.model_dump(mode="json", by_alias=True),
        summary=summary,
        retained_metadata={"inputs": summary},
        reserved_bytes=0,
    )


async def _active_preparation_areas(context: OperationContext) -> set[bytes]:
    """Read all current ordinary preparations and identify active area/year pairs.

    Args:
        context: Worker access to the existing administrator job scope.

    Returns:
        Canonical selection/year keys for queued, running or cancelling work.

    Raises:
        ProcessingError: If retained history cannot be read.
        ValueError: If persisted preparation metadata is invalid.
    """
    active = set()
    before = None
    while True:
        rows = await asyncio.to_thread(
            context.jobs.list_session_jobs_page,
            HABITAT_PREPARATION_OWNER,
            (OPERATION,),
            100,
            before,
        )
        for row in rows:
            if row["status"] not in {"queued", "running", "cancelling"}:
                continue
            inputs = get_retained_habitat_preparation_inputs(row)
            if inputs is not None:
                active.add(
                    encode_canonical_json(
                        [inputs.selection.model_dump(mode="json"), inputs.year]
                    )
                )
        if len(rows) < 100:
            return active
        before = rows[-1]["created_at"], rows[-1]["id"]


async def _check_and_queue_area(
    context: OperationContext,
    runtime: HabitatEarthEngineRuntime,
    request: HabitatInputPreparationRequest,
    active: set[bytes],
) -> HabitatBulkPreparationOutcome:
    """Recover or queue one missing area while preserving ordinary admission identity.

    Args:
        context: Worker-owned source authorization and durable job storage.
        runtime: Server-only Habitat cache configuration for this bulk operation.
        request: One captured area/year with a stable ordinary submission ID.
        active: Current active area/year keys; updated after a new acceptance.

    Returns:
        Accepted child identifier, cached outcome, or active-work skip.

    Raises:
        ProcessingError: If recovery conflicts, coverage fails or admission fails.
        SelectionUnavailableError: If Catalog source authorization rejects the area.
        ValueError: If the installed scientific configuration rejects the year.
        OSError: If the installed scientific configuration cannot be read.
    """
    request_hash = hashlib.sha256(
        encode_canonical_json(request.model_dump(mode="json", exclude={"requestId"}))
    ).hexdigest()
    previous = await asyncio.to_thread(
        context.jobs.find_request, HABITAT_PREPARATION_OWNER, request.requestId
    )
    if previous is not None:
        if (
            previous["operation"] != OPERATION
            or previous["request_hash"] != request_hash
        ):
            raise ProcessingError(
                "request_conflict",
                "This saved preparation request has conflicting inputs.",
                409,
            )
        return HabitatBulkPreparationOutcome(
            name=request.name, year=request.year, status="queued", jobId=previous["id"]
        )
    key = encode_canonical_json(
        [request.selection.model_dump(mode="json"), request.year]
    )
    if key in active:
        return HabitatBulkPreparationOutcome(
            name=request.name, year=request.year, status="active"
        )
    coverage = await get_habitat_cache_coverage(
        request.selection,
        request.year,
        cast(CatalogSelectionReader, context.areas),
        runtime.cache_directory,
    )
    if coverage.missing_tiles == 0:
        return HabitatBulkPreparationOutcome(
            name=request.name, year=request.year, status="cached"
        )
    prepared = build_habitat_input_preparation_submission(request)
    admission = asyncio.create_task(
        asyncio.to_thread(
            context.jobs.submit,
            HABITAT_PREPARATION_OWNER,
            request.requestId,
            prepared,
            request_hash,
        )
    )
    try:
        row = await asyncio.shield(admission)
    except asyncio.CancelledError:
        # An admission already dispatched to PostgreSQL must settle before this
        # worker slot is released; accepted children remain independent work.
        while not admission.done():
            try:
                await asyncio.shield(admission)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if not admission.cancelled():
            admission.exception()
        raise
    active.add(key)
    return HabitatBulkPreparationOutcome(
        name=request.name, year=request.year, status="queued", jobId=row["id"]
    )


async def prepare_habitat_bulk_preparation(
    context: OperationContext, queued: QueuedHabitatBulkPreparation, primary: None
) -> PreparedJobPlan:
    """Check the captured areas and queue missing inputs without waiting for downloads.

    Cancellation stops further checks and native reads; children already accepted
    remain ordinary independent jobs. Each area failure is recorded while later
    areas continue. Completion means checking and queueing finished, not that the
    accepted tile downloads finished.

    Args:
        context: Existing worker lifecycle, source access and job-store capabilities.
        queued: Immutable saved-area scope accepted by the administrator endpoint.
        primary: None; no primary raster is required.

    Returns:
        Prepared report plan for normal artifact publication and retention.

    Raises:
        ProcessingError: If source/runtime configuration or job history is unavailable.
        ValueError: If persisted active preparation metadata is invalid.
        asyncio.CancelledError: After an in-progress native coverage read has stopped.
    """
    outcomes = []
    if queued.request.areas:
        if context.areas is None:
            raise ProcessingError(
                "selection_unavailable", "Catalog selection reader is unavailable.", 409
            )
        runtime = cast(
            HabitatEarthEngineRuntime | None,
            context.operation_settings.get(BULK_OPERATION),
        )
        if runtime is None:
            raise ProcessingError(
                "habitat_earth_engine_unavailable",
                "Ecosystem Condition input preparation is not configured. Ask the administrator to check its settings.",
                503,
            )
        active = await _active_preparation_areas(context)
        for request in queued.request.areas:
            try:
                outcome = await _check_and_queue_area(context, runtime, request, active)
            except (ProcessingError, SelectionUnavailableError) as error:
                outcome = HabitatBulkPreparationOutcome(
                    name=request.name,
                    year=request.year,
                    status="failed",
                    detail=error.detail,
                )
            except (OSError, ValueError):
                outcome = HabitatBulkPreparationOutcome(
                    name=request.name,
                    year=request.year,
                    status="failed",
                    detail="The Ecosystem Condition inputs for this area and year could not be prepared. Ask the administrator to check its source and scientific configuration.",
                )
            outcomes.append(outcome)
    report = HabitatBulkPreparationReport(
        areaCount=len(outcomes),
        queuedCount=sum(row.status == "queued" for row in outcomes),
        cachedCount=sum(row.status == "cached" for row in outcomes),
        activeCount=sum(row.status == "active" for row in outcomes),
        failedCount=sum(row.status == "failed" for row in outcomes),
        outcomes=tuple(outcomes),
    )
    spec = HabitatBulkPreparationSpec(report=report)
    summary = HabitatBulkPreparationSummary(areaCount=report.areaCount).model_dump()
    return PreparedJobPlan(
        operation=BULK_OPERATION,
        specification=spec.model_dump(mode="json"),
        summary=summary,
        retained_metadata={"inputs": summary},
        reserved_bytes=0,
    )


async def prepare_habitat_bulk_preparation_execution(
    context: OperationContext, spec: HabitatBulkPreparationSpec, primary: None
) -> tuple[None, HabitatBulkPreparationSpec]:
    """Supply the completed bulk receipt to its report writer without source reads.

    Args:
        context: Unused ordinary worker capabilities.
        spec: Completed bulk check/admission report.
        primary: None; report publication requires no primary source.

    Returns:
        No native sources and the unchanged report specification.
    """
    return None, spec


def habitat_bulk_preparation_process_target(
    writer: ProcessResultWriter,
    action: Literal["report"],
    arguments: tuple[None, HabitatBulkPreparationSpec, Path, None],
) -> None:
    """Write the bulk receipt for ordinary atomic artifact publication.

    Args:
        writer: Worker-owned result channel receiving an artifact or safe failure.
        action: Registered report-writing action.
        arguments: No source, completed report, attempt directory and no settings.
    """
    _, spec, directory, _ = arguments
    try:
        path = directory / "result.json"
        path.write_text(spec.report.model_dump_json(), encoding="utf-8")
        produced = describe_habitat_file(path, "report", "application/json")
        report = spec.report
        artifact = HabitatBulkPreparationArtifact(
            size=produced.size,
            sha256=produced.sha256,
            filename="habitat-bulk-preparation-report.json",
            area_count=report.areaCount,
            queued_count=report.queuedCount,
            cached_count=report.cachedCount,
            active_count=report.activeCount,
            failed_count=report.failedCount,
        )
        (directory / "provenance.json").write_text(
            json.dumps(
                {
                    "operation": BULK_OPERATION,
                    "report": report.model_dump(),
                    **asdict(artifact),
                },
                allow_nan=False,
            ),
            encoding="utf-8",
        )
        writer.put(("ok", artifact))
    except OSError:
        writer.put(
            (
                "error",
                (
                    "habitat_bulk_report_failed",
                    "The bulk preparation report could not be saved. Accepted preparation jobs continue independently.",
                    500,
                ),
            )
        )


def describe_habitat_bulk_preparation_outcome(
    artifact: dict[str, Any],
) -> dict[str, int]:
    """Return check/admission counts from a retained bulk report artifact.

    Args:
        artifact: Metadata from a published bulk preparation report.

    Returns:
        Public counts describing completed checks, not completed tile downloads.
    """
    return {
        "areaCount": artifact["area_count"],
        "queuedCount": artifact["queued_count"],
        "cachedCount": artifact["cached_count"],
        "activeCount": artifact["active_count"],
        "failedCount": artifact["failed_count"],
    }
