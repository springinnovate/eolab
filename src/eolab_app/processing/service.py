"""Owned processing lifecycle and explicit raster operation commands."""

import asyncio
import hashlib
import json
import math
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import PurePath
from typing import Any
from eolab_app.processing.artifact_manifest import read_artifact_manifest

from eolab_app.processing.shared_calculations import (
    present_calculation_rows,
)
from eolab_app.processing.statistics_csv import statistics_csv
from eolab_app.processing.models import (
    ArtifactDownload,
    JobSubmission,
    ProcessingError,
    PreparedJobPlan,
)
from eolab_app.raster.source_models import RasterSourceReference, RunArtifactReference
from eolab_app.processing.clip_models import ClipInputs, ClipJobRequest
from eolab_app.processing.aggregate_models import (
    AggregateArea,
    AggregateJobRequest,
)
from eolab_app.processing.polygon_areas import PolygonAreaReference, PolygonSummaryInput
from eolab_app.processing.ports import (
    JobArtifactStore,
    JobStore,
    JobChanges,
    JobSubscription,
)
from eolab_app.raster.ports import RasterSourceAuthorizer
from eolab_app.processing.model_definitions import ModelRegistry
from eolab_app.processing.model_operations import get_model_operation
from eolab_app.processing.model_run_contracts import MODEL_OPERATION, ModelRunRequest
from eolab_app.processing.model_runs import (
    build_model_job_submission,
    decode_model_run_cursor,
    encode_model_run_cursor,
    export_model_job_yaml,
    read_model_invocation,
    serialize_model_job,
    serialize_model_artifacts,
    build_model_calculation_request,
)
from eolab_app.processing.model_yaml import encode_canonical_json, export_yaml


def require_operation(row: dict[str, Any], operation: str) -> None:
    """Keep idempotent retries on their original operation.

    Args:
        row: Authorized job row.
        operation: Explicit operation supported by the submitting endpoint.

    Raises:
        ProcessingError: When the supplied job belongs to a different operation.
    """
    actual = (
        row.get("operation")
        or (row.get("spec") or {}).get("operation")
        or "raster.clip.v1"
    )
    if actual != operation:
        raise ProcessingError(
            "operation_mismatch",
            "This job belongs to a different processing operation.",
            409,
        )


def public_job(row: dict[str, Any]) -> dict[str, Any]:
    """Project a durable row onto the path-free, owner-safe HTTP result contract.

    Args:
        row: An already-authorized owned job record.

    Returns:
        Public lifecycle, grid, source, and result links without storage metadata.
    """
    if row.get("operation") == MODEL_OPERATION:
        return serialize_model_job(row)
    identifier = row["id"]
    spec = row.get("spec") or {}
    if "request" in spec:
        spec = row["summary"]
    presentation = row.get("presentation")
    if presentation and spec:
        spec = {**spec, **presentation}
        if row.get("artifact"):
            artifact = dict(row["artifact"])
            artifact["rows"] = present_calculation_rows(artifact["rows"], presentation)
            content = statistics_csv(artifact["rows"])
            artifact.update(
                size=len(content), sha256=hashlib.sha256(content).hexdigest()
            )
            row = {**row, "artifact": artifact}
    status = row["status"]
    if status == "ready" and row["expires_at"] <= datetime.now(timezone.utc):
        status = "expired"
    ready = status == "ready"
    operation = row.get("operation") or spec.get("operation") or "raster.clip.v1"
    calculation = operation == "raster.aggregate.v1"
    return {
        "jobId": identifier,
        "operation": operation,
        "status": status,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "expiresAt": row["expires_at"],
        **(
            {"sources": spec.get("sources"), "calculations": spec.get("calculations")}
            if calculation
            else {"source": spec.get("source")}
        ),
        "grid": spec.get("grid"),
        "area": (
            {"kind": spec["area"]["kind"], "bounds": spec["area"]["bounds"]}
            if spec
            else None
        ),
        "progress": row["progress"],
        "error": row["error"],
        "result": (
            {
                "url": f"/api/processing/jobs/{identifier}/result",
                "provenanceUrl": f"/api/processing/jobs/{identifier}/provenance",
                "filename": row["artifact"]["filename"],
                "bytes": row["artifact"]["size"],
                "sha256": row["artifact"]["sha256"],
                **(
                    {
                        "rows": row["artifact"]["rows"],
                        "cacheHit": row["artifact"].get("cache_hit", False),
                    }
                    if calculation
                    else {"validPixels": row["artifact"]["valid_pixels"]}
                ),
            }
            if ready and row["artifact"]
            else None
        ),
    }


class ProcessingService:
    """Own job lifecycle and supported operation commands through narrow providers."""

    def __init__(
        self,
        jobs: JobStore,
        artifacts: JobArtifactStore,
        *,
        changes: JobChanges | None = None,
        submission_wait_seconds: float = 0.45,
        model_registry: ModelRegistry | None = None,
        model_authorizer: RasterSourceAuthorizer | None = None,
    ) -> None:
        """Compose job storage and currently supported raster-operation capabilities.

        Args:
            jobs: Durable job and admission adapter.
            artifacts: Confined result-file adapter.
            changes: Lifecycle-managed owned-job notification provider.
            submission_wait_seconds: Observation budget per calculation submission,
                finite and non-negative; zero gives immediate acknowledgement. The final
                owned-state read also incurs the ordinary database access latency.
            model_registry: Validated installed recipes; bundled definitions load
                eagerly when omitted, failing readiness if invalid.
            model_authorizer: Catalog-only source authority for capturing model
                inputs at admission. Existing raster endpoints retain their behavior.

        Raises:
            ValueError: If the submission observation budget is negative or non-finite.
        """
        if submission_wait_seconds < 0 or not math.isfinite(submission_wait_seconds):
            raise ValueError("Submission wait must be finite and non-negative")
        self.jobs = jobs
        self.artifacts = artifacts
        self.changes = changes
        self.submission_wait_seconds = submission_wait_seconds
        self.model_registry = (
            model_registry
            if model_registry is not None
            else ModelRegistry.load_installed()
        )
        self.model_authorizer = model_authorizer

    async def submit_model_run(
        self, owner: str, request: ModelRunRequest
    ) -> dict[str, Any]:
        """Start a model run, or recover a previously accepted submission.

        Checks the selected model and source, fills in defaults, and saves the
        inputs before queueing work. Repeating the same request ID and inputs
        returns the original run even if its model or source is no longer installed.

        Args:
            owner: Hash of the requesting browser's Processing session cookie.
            request: The chosen model, input datasets, area, parameters and run label.

        Returns:
            The newly queued run, or the original run for an unchanged retry.

        Raises:
            ProcessingError: If the retry conflicts, model inputs are invalid, or
                the configured queue or storage limits prevent submission.
            RasterFeatureError: If the catalog cannot authorize the selected raster.
        """
        request_hash = hashlib.sha256(
            encode_canonical_json(
                request.model_dump(mode="json", exclude={"requestId"})
            )
        ).hexdigest()
        existing = await asyncio.to_thread(
            self.jobs.find_request, owner, request.requestId
        )
        if existing is not None:
            require_operation(existing, MODEL_OPERATION)
            if existing["request_hash"] != request_hash:
                raise ProcessingError(
                    "request_conflict",
                    "That request ID has different model inputs.",
                    409,
                )
            return public_job(existing)
        calculation, invocation = build_model_calculation_request(
            request, self.model_registry
        )
        if self.model_authorizer is None:
            raise ProcessingError(
                "models_unavailable", "Model source authorization is unavailable.", 503
            )
        operation = get_model_operation(invocation.model.definition.steps[0].operation)
        source = operation.source(calculation)
        signature = None
        if not isinstance(source, RunArtifactReference):
            authorized = await self.model_authorizer.authorize(source)
            signature = tuple(authorized.source_signature.to_catalog())
        reference = operation.polygon(calculation)
        polygons = await self.read_polygon_area(owner, reference) if reference else None
        operation_plan = operation.queue(calculation, polygons)
        operation_plan = await self.capture_input_file(owner, source, operation_plan)
        prepared = build_model_job_submission(
            operation_plan,
            invocation,
            signature,
        )
        row = await asyncio.to_thread(
            self.jobs.submit, owner, request.requestId, prepared, request_hash
        )
        return public_job(row)

    async def capture_input_file(self, owner: str, source: RasterSourceReference, prepared: PreparedJobPlan) -> PreparedJobPlan:
        """Capture a published raster identity for atomic job-input admission.

        Args:
            owner: Requesting browser session hash.
            source: Catalog identity or owned published-file reference.
            prepared: Operation-owned queued specification.

        Returns:
            Plan with a private input identity when needed. Private work is not
            coalesced with another submission; catalog sharing stays unchanged.

        Raises:
            ProcessingError: If the file is unavailable or is not published raster data.
        """
        if not isinstance(source, RunArtifactReference):
            return prepared
        file = await asyncio.to_thread(self.jobs.inspect_input_file, owner, source.jobId, source.artifactId)
        if file.media_type != "image/tiff" or file.role not in {"result", "intermediate"} or file.size <= 0:
            raise ProcessingError("invalid_raster_input", "Choose a published raster result or scientific raster intermediate.", 422)
        return replace(prepared, input_files=(file,), work_key=None)

    async def list_models(self) -> dict[str, Any]:
        """List every installed model recipe and its setup fields.

        Returns:
            Model definitions, versions and checksums, without accessing datasets or rendering.
        """
        return {"models": self.model_registry.list_models()}

    async def export_installed_model_yaml(self, identifier: str, version: str) -> bytes:
        """Export an installed model definition as reusable Model YAML.

        Args:
            identifier: The model ID returned by discovery.
            version: The installed model version to export.

        Returns:
            UTF-8 YAML bytes describing the recipe.

        Raises:
            ProcessingError: If the model version is unavailable or cannot be exported.
        """
        return export_yaml(self.model_registry.get(identifier, version).to_document())

    async def export_job_yaml(self, owner: str, identifier: str, *, run: bool) -> bytes:
        """Export the recipe or run details saved with this browser session's job.

        Args:
            owner: Hash of the requesting browser's Processing session cookie.
            identifier: The model run's job ID.
            run: True for Run YAML including inputs and execution details; False for
                only the reusable Model YAML recipe.

        Returns:
            UTF-8 YAML bytes using the saved recipe, independent of the current library.

        Raises:
            ProcessingError: If the job is unavailable to this session or its metadata expired.
        """
        row = await asyncio.to_thread(self.jobs.get, identifier, owner)
        return export_model_job_yaml(row, run=run)

    async def get_model_invocation(self, owner: str, identifier: str) -> dict[str, Any]:
        """Read a run's original setup for inspection or duplication.

        Args:
            owner: Hash of the requesting browser's Processing session cookie.
            identifier: The accepted model run's job ID.

        Returns:
            The saved recipe, inputs and effective parameter values as JSON data.

        Raises:
            ProcessingError: If the session cannot access the run or its metadata
                is no longer available.
        """
        row = await asyncio.to_thread(self.jobs.get, identifier, owner)
        return read_model_invocation(row).model_dump(mode="json", by_alias=True)

    async def list_model_runs(
        self, owner: str, limit: int, cursor: str | None
    ) -> dict[str, Any]:
        """Return one page of the requesting browser session's model runs.

        Args:
            owner: Hash of the browser's Processing session cookie.
            limit: Maximum runs to return on this page, between one and 100.
            cursor: The previous response's nextCursor, or None for the newest runs.

        Returns:
            Model run statuses and a nextCursor when older matching runs exist.

        Raises:
            ProcessingError: If pagination values are invalid or job storage is unavailable.
        """
        if not 1 <= limit <= 100:
            raise ProcessingError(
                "invalid_limit", "Choose between one and 100 model runs."
            )
        rows = await asyncio.to_thread(
            self.jobs.list_session_jobs_page,
            owner,
            (MODEL_OPERATION,),
            limit + 1,
            decode_model_run_cursor(cursor),
        )
        return {
            "jobs": [public_job(row) for row in rows[:limit]],
            "nextCursor": (
                encode_model_run_cursor(rows[limit - 1]) if len(rows) > limit else None
            ),
        }

    async def subscribe_jobs(self, owner: str) -> JobSubscription:
        """Subscribe to hints for the same owner used by ordinary job reads.

        Args:
            owner: Hashed session capability from the HTTP boundary.

        Returns:
            A subscription which the transport must close on every exit path.

        Raises:
            ProcessingError: If live updates are disabled or at capacity.
        """
        if self.changes is None:
            raise ProcessingError(
                "events_unavailable",
                "Live updates are unavailable; use job status polling.",
                503,
            )
        return self.changes.subscribe(owner)

    async def upload_polygon_area(
        self, owner: str, polygons: PolygonSummaryInput
    ) -> dict[str, Any]:
        """Retain submitted polygon geometry for this browser's summary calculations.

        Args:
            owner: Current Processing browser-session hash.
            polygons: Validated committed polygons after the user's filter.

        Returns:
            Small area reference, geographic envelope and polygon count.

        Raises:
            ProcessingError: If temporary input storage is full or unavailable.
        """
        checksum = polygons.geometry_hash()
        identifier = await asyncio.to_thread(
            self.jobs.save_input, owner, checksum, polygons.model_dump(mode="json")
        )
        return {
            "polygonArea": {"id": identifier, "sha256": checksum},
            "bbox": polygons.bounds(),
            "matched": len(polygons.polygons),
        }

    async def read_polygon_area(
        self, owner: str, reference: PolygonAreaReference
    ) -> AggregateArea:
        """Load exact polygons from an input owned by the requesting browser.

        Args:
            owner: Current Processing browser-session hash.
            reference: Expiring input ID and expected geometry hash.

        Returns:
            Validated geometry copied into this calculation job.

        Raises:
            ProcessingError: If the input expired or is not owned by the caller.
            ValueError: If persisted geometry violates its input contract.
        """
        payload = await asyncio.to_thread(
            self.jobs.get_input, owner, reference.id, reference.sha256
        )
        polygons = PolygonSummaryInput.model_validate(payload)
        return AggregateArea(
            kind="polygons",
            bounds=polygons.bounds(),
            geometryHash=reference.sha256,
            geometries=tuple(p.model_dump(mode="json") for p in polygons.polygons),
        )

    async def discard_polygon_area(self, owner: str, identifier: str) -> None:
        """Release polygons that this browser no longer uses for new calculations.

        Args:
            owner: Current Processing session hash.
            identifier: Uploaded polygon-area ID.

        Raises:
            ProcessingError: If the storage operation fails.
        """
        await asyncio.to_thread(self.jobs.discard_input, owner, identifier)

    async def submit_raster_clip(
        self, owner: str, request: ClipJobRequest
    ) -> dict[str, Any]:
        """Join identical active clipping work or queue a clip with its complete inputs.

        Args:
            owner: Current browser-session hash.
            request: Catalog raster, explicit area and stable submission key.

        Returns:
            The caller's handle for shared/new work, or the same handle on retry.

        Raises:
            ProcessingError: If the retry changes inputs or admission is full.
        """
        inputs = ClipInputs.model_validate(
            request.model_dump(exclude={"requestId"}, by_alias=True)
        )
        request_hash = hashlib.sha256(
            json.dumps(
                inputs.model_dump(mode="json", by_alias=True), sort_keys=True
            ).encode()
        ).hexdigest()
        operation = get_model_operation("raster.clip.v1")
        prepared = operation.queue(request, None)
        try:
            prepared = await self.capture_input_file(owner, operation.source(request), prepared)
        except ProcessingError:
            existing = await asyncio.to_thread(self.jobs.find_request, owner, request.requestId)
            if existing is None or existing["request_hash"] != request_hash:
                raise
            require_operation(existing, operation.id)
            return public_job(existing)
        row = await asyncio.to_thread(
            self.jobs.submit,
            owner,
            request.requestId,
            prepared,
            request_hash,
        )
        require_operation(row, operation.id)
        return public_job(row)

    async def submit_calculation_inputs(
        self, owner: str, request: AggregateJobRequest
    ) -> dict[str, Any]:
        """Join identical active statistics work or queue a calculation with its inputs.

        Args:
            owner: Current browser-session hash.
            request: Validated catalog source, selected area, formulas and stable
                retry key. Direct callers must construct AggregateJobRequest
                through its normal validation, just as the HTTP boundary does.

        Returns:
            The caller's observed job and labels, or the same handle after a retry.
            Completion observation uses the same budget as a calculation batch.

        Raises:
            ProcessingError: For conflicting retries, unavailable polygon inputs,
                or exhausted queue and job-record capacity.
        """
        inputs = request
        request_hash = hashlib.sha256(
            json.dumps(
                inputs.model_dump(mode="json", by_alias=True, exclude={"requestId"}),
                sort_keys=True,
            ).encode()
        ).hexdigest()
        existing = await asyncio.to_thread(
            self.jobs.find_request, owner, request.requestId
        )
        if existing:
            require_operation(existing, "raster.aggregate.v1")
            if existing.get("request_hash") != request_hash:
                raise ProcessingError(
                    "request_conflict",
                    "That request ID has different calculation inputs.",
                    409,
                )
        else:
            submission = await self.build_calculation_submission(
                owner, request, {}, request_hash
            )
            if isinstance(submission.prepared, ProcessingError):
                raise submission.prepared
        if existing:
            row = existing
        else:
            row = await asyncio.to_thread(
                self.jobs.submit,
                owner,
                request.requestId,
                submission.prepared,
                request_hash,
            )
        return (await self._observe_submitted_calculations(owner, [public_job(row)]))[0]

    async def build_calculation_submission(
        self,
        owner: str,
        request: AggregateJobRequest,
        polygon_inputs: dict[PolygonAreaReference, AggregateArea | ProcessingError],
        request_hash: str | None = None,
    ) -> JobSubmission:
        """Capture validated inputs and resolve each owned polygon reference once.

        Args:
            owner: Current session hash.
            request: Already validated calculation request.
            polygon_inputs: Request-local resolution results for repeated areas.
            request_hash: Previously computed request identity for single-request recovery.

        Returns:
            Storage admission data, or a resolution error carried with its retry
            identity so a previously accepted request can still be recovered.

        Raises:
            ValueError: If persisted polygon input violates its storage contract.
        """
        request_hash = (
            request_hash
            or hashlib.sha256(
                json.dumps(
                    request.model_dump(
                        mode="json", by_alias=True, exclude={"requestId"}
                    ),
                    sort_keys=True,
                ).encode()
            ).hexdigest()
        )
        polygons = None
        if request.polygonArea:
            reference = request.polygonArea
            if reference not in polygon_inputs:
                try:
                    polygon_inputs[reference] = await self.read_polygon_area(
                        owner, reference
                    )
                except ProcessingError as error:
                    polygon_inputs[reference] = error
            polygons = polygon_inputs[reference]
            if isinstance(polygons, ProcessingError):
                return JobSubmission(
                    request.requestId, request_hash, "raster.aggregate.v1", polygons
                )
        operation = get_model_operation("raster.aggregate.v1")
        prepared = operation.queue(request, polygons)
        try:
            prepared = await self.capture_input_file(owner, operation.source(request), prepared)
        except ProcessingError as error:
            return JobSubmission(request.requestId, request_hash, operation.id, error)
        return JobSubmission(request.requestId, request_hash, operation.id, prepared)

    async def submit_calculation_batch(
        self, owner: str, requests: list[AggregateJobRequest]
    ) -> list[dict[str, Any] | ProcessingError]:
        """Submit independent calculations through one store admission transaction.

        Args:
            owner: Current browser-session hash.
            requests: One to fifty requests validated at the HTTP boundary.

        Returns:
            Public job snapshots or sanitized per-item rejections, in input order.
            Workers prepare and execute accepted jobs after admission commits.
            Observe accepted work within one submission budget before returning
            the same snapshots used by ordinary status reads.

        Raises:
            ProcessingError: If the shared admission transaction is unavailable.
        """
        polygon_inputs: dict[PolygonAreaReference, AggregateArea | ProcessingError] = {}
        submissions = [
            await self.build_calculation_submission(owner, request, polygon_inputs)
            for request in requests
        ]
        results = await asyncio.to_thread(self.jobs.submit_batch, owner, submissions)
        return await self._observe_submitted_calculations(
            owner,
            [
                result if isinstance(result, ProcessingError) else public_job(result)
                for result in results
            ],
        )

    async def _observe_submitted_calculations(
        self, owner: str, outcomes: list[dict[str, Any] | ProcessingError]
    ) -> list[dict[str, Any] | ProcessingError]:
        """Observe committed jobs within one deadline, preserving admission outcomes.

        Subscribe before reading owned state so a completion between admission
        and registration is recovered by that read. Hints prompt fresh snapshots;
        a final deadline read also recovers missed hints. No transaction or result
        payload is retained by the subscription. Unavailable observation preserves
        accepted snapshots for the normal browser status/retry flow.

        Args:
            owner: Session hash that admitted the calculations.
            outcomes: Public accepted jobs and independent admission errors.

        Returns:
            Latest owned snapshots and original errors in admission order. Ready
            results and unfinished jobs retain the existing response contract.

        Raises:
            asyncio.CancelledError: After releasing subscription capacity; committed
                jobs remain recoverable through their original request keys.
        """
        active = {"queued", "running", "cancelling"}
        snapshots = {
            outcome["jobId"]: outcome
            for outcome in outcomes
            if isinstance(outcome, dict)
        }
        identifiers = [key for key, job in snapshots.items() if job["status"] in active]
        if not identifiers or not self.submission_wait_seconds:
            return outcomes
        try:
            subscription = await self.subscribe_jobs(owner)
        except ProcessingError:
            return outcomes
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.submission_wait_seconds
        try:
            while True:
                status = await self.read_job_statuses(owner, identifiers)
                snapshots.update({job["jobId"]: job for job in status["jobs"]})
                if all(snapshots[key]["status"] not in active for key in identifiers):
                    break
                remaining = deadline - loop.time()
                if remaining <= 0:
                    break
                await subscription.wait(remaining)
        except ProcessingError:
            pass
        finally:
            subscription.close()
        return [
            snapshots[outcome["jobId"]] if isinstance(outcome, dict) else outcome
            for outcome in outcomes
        ]

    async def get(self, owner: str, identifier: str) -> dict[str, Any]:
        """Read one owner's public job state.

        Args:
            owner: Current session hash.
            identifier: Opaque job ID.

        Returns:
            Public lifecycle and ready download links.
        """
        row = await asyncio.to_thread(self.jobs.get, identifier, owner)
        return public_job(row)

    async def list_owned(self, owner: str) -> list[dict[str, Any]]:
        """Recover bounded recent jobs for the current browser session.

        Args:
            owner: Current session hash.

        Returns:
            At most 50 public job summaries, newest first.
        """
        rows = await asyncio.to_thread(
            self.jobs.list_owned, owner, ("raster.clip.v1", "raster.aggregate.v1")
        )
        return [public_job(row) for row in rows]

    async def read_job_statuses(
        self, owner: str, identifiers: list[str]
    ) -> dict[str, Any]:
        """Return requested job statuses without reading unrelated job history.

        Args:
            owner: Current session hash.
            identifiers: Validated public job IDs, at most 100.

        Returns:
            Public jobs and unavailable IDs, each in request order with duplicates
            removed. Foreign and nonexistent IDs are indistinguishable.
        """
        rows = await asyncio.to_thread(self.jobs.read_owned_jobs, owner, identifiers)
        by_id = {row["id"]: row for row in rows}
        requested = list(dict.fromkeys(identifiers))
        return {
            "jobs": [public_job(by_id[value]) for value in requested if value in by_id],
            "unavailableJobIds": [value for value in requested if value not in by_id],
        }

    async def cancel(
        self, owner: str, identifier: str, delete: bool = False
    ) -> dict[str, Any]:
        """Request explicit cancellation or remove a terminal job's result.

        Args:
            owner: Current session hash.
            identifier: Owned opaque job ID.
            delete: Revoke a terminal result rather than cancel active work.

        Returns:
            Updated public state; running cancellation completes after child exit.
        """
        return public_job(
            await asyncio.to_thread(self.jobs.cancel, identifier, owner, delete)
        )

    async def download(
        self, owner: str, identifier: str, provenance: bool = False
    ) -> ArtifactDownload:
        """Authorize a finished artifact and acquire its transfer lifetime.

        Args:
            owner: Current session hash.
            identifier: Owned job ID.
            provenance: Download JSON provenance instead of the result file.

        Returns:
            Confined file, response metadata and transfer lease. Summary CSV/JSON
            also carries small replacement bytes using this caller's formula labels.

        Raises:
            ProcessingError: If unavailable, expired, or transfer capacity is full.
        """
        row, lease = await asyncio.to_thread(
            self.jobs.acquire_transfer, identifier, owner
        )
        try:
            artifact = row["artifact"]
            path = await asyncio.to_thread(
                self.artifacts.result_path,
                row["attempt_id"],
                provenance,
                result_name=artifact.get("result_name", "result.tif"),
            )
            if provenance:
                data = await asyncio.to_thread(path.read_bytes)
                size = len(data)
                sha256 = hashlib.sha256(data).hexdigest()
                filename = str(PurePath(artifact["filename"]).with_suffix(".json"))
                media_type = "application/json"
            else:
                size, sha256, filename = (
                    artifact["size"],
                    artifact["sha256"],
                    artifact["filename"],
                )
                # Results created before media types were recorded were all
                # raster clips; preserve their existing download content type.
                media_type = artifact.get("media_type", "image/tiff")
                if path.stat().st_size != size:
                    raise ProcessingError(
                        "result_changed",
                        "This result file is no longer intact. Submit a new job.",
                        410,
                    )
            content = None
            if row.get("presentation"):
                rows = present_calculation_rows(artifact["rows"], row["presentation"])
                content = statistics_csv(rows)
                if provenance:
                    document = json.loads(data)
                    document.update(row["presentation"])
                    if document.get("cachedRows") is not None:
                        document["cachedRows"] = present_calculation_rows(
                            document["cachedRows"], row["presentation"]
                        )
                    document.update(
                        rows=rows,
                        size=len(content),
                        sha256=hashlib.sha256(content).hexdigest(),
                    )
                    content = json.dumps(document, allow_nan=False).encode("utf-8")
                size = len(content)
                sha256 = hashlib.sha256(content).hexdigest()
            return ArtifactDownload(
                path, filename, size, sha256, lease, media_type, content
            )
        except BaseException:
            await asyncio.to_thread(self.jobs.transfer_heartbeat, lease, True)
            raise

    async def list_model_artifacts(self, owner: str, identifier: str) -> dict[str, Any]:
        """List complete retained files belonging to this browser session's run.

        Args:
            owner: Current session hash.
            identifier: Public model-run ID.

        Returns:
            File metadata and availability, without private filesystem information.

        Raises:
            ProcessingError: If the model run is unavailable to this session.
            ValidationError: If persisted file metadata is malformed.
        """
        row = await asyncio.to_thread(self.jobs.get, identifier, owner)
        require_operation(row, MODEL_OPERATION)
        return serialize_model_artifacts(row)

    async def download_model_artifact(
        self, owner: str, identifier: str, artifact_id: str
    ) -> ArtifactDownload:
        """Authorize one run file and retain all its files until transfer finishes.

        Args:
            owner: Current session hash.
            identifier: Public model-run ID.
            artifact_id: Opaque file ID from this run's manifest.

        Returns:
            Confined file and renewable transfer lease for the existing response.

        Raises:
            ProcessingError: If ownership, expiry, file identity or integrity checks fail.
            ValidationError: If the persisted manifest is malformed.
        """
        row, lease = await asyncio.to_thread(
            self.jobs.acquire_transfer, identifier, owner
        )
        try:
            require_operation(row, MODEL_OPERATION)
            stored = row["artifact"].get("manifest")
            manifest = read_artifact_manifest(stored) if stored else None
            file = (
                next((item for item in manifest.files if item.id == artifact_id), None)
                if manifest
                else None
            )
            if file is None:
                raise ProcessingError(
                    "artifact_not_found", "This result file is unavailable.", 404
                )
            path = await asyncio.to_thread(
                self.artifacts.artifact_path, row["attempt_id"], file.storage_name
            )
            if path.stat().st_size != file.size:
                raise ProcessingError(
                    "result_changed",
                    "This result file is no longer intact. Run the model again.",
                    410,
                )
            return ArtifactDownload(
                path, file.filename, file.size, file.sha256, lease, file.media_type
            )
        except BaseException:
            await asyncio.to_thread(self.jobs.transfer_heartbeat, lease, True)
            raise

    async def check_model_artifact(
        self, owner: str, identifier: str, artifact_id: str
    ) -> tuple[int, str, str]:
        """Recheck a retained file's ownership, availability and immutable metadata.

        This does not acquire another transfer slot or authorize a new filesystem
        read. Callers already holding a lease use it before delivering a result.

        Args:
            owner: Server-derived session hash.
            identifier: Opaque run identity.
            artifact_id: Opaque published file identity.

        Returns:
            Current byte count, checksum and media type.

        Raises:
            ProcessingError: If the session, run or file is no longer available.
            ValidationError: If persisted file metadata is malformed.
        """
        manifest = await self.list_model_artifacts(owner, identifier)
        if manifest["availability"] != "available":
            raise ProcessingError(
                "result_unavailable", "This result is no longer available.", 409
            )
        file = next(
            (file for file in manifest["files"] if file["artifactId"] == artifact_id),
            None,
        )
        if file is None:
            raise ProcessingError(
                "artifact_not_found", "This result file is unavailable.", 404
            )
        return file["bytes"], file["sha256"], file["mediaType"]

    async def transfer_heartbeat(self, lease: str, release: bool = False) -> bool:
        """Renew or release a response-owned download lease.

        Args:
            lease: Opaque transfer capability from download authorization.
            release: Release after the response ends or disconnects.

        Returns:
            Whether the transfer lease existed.
        """
        return await asyncio.to_thread(self.jobs.transfer_heartbeat, lease, release)
