"""Application workflow and supervision for explicitly supported processing jobs."""

from eolab_app.catalog_selection import (
    CatalogSelectionReader,
    SelectionUnavailableError,
)
import asyncio
from contextlib import suppress
from dataclasses import replace
from pathlib import PurePath
from threading import Event
import logging
from typing import Any
from pydantic import BaseModel

from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
)
from eolab_app.execution.reusable_process import ReusableProcess, run_process
from eolab_app.processing.models import Artifact, ProcessingError
from eolab_app.processing.artifact_manifest import FileDeclaration
from eolab_app.processing.clip_models import RasterClipLimits
from eolab_app.processing.aggregate_models import RasterAggregateLimits
from eolab_app.raster.models import AuthorizedRaster
from eolab_app.raster.source_models import (
    RasterSourceReference,
    RunArtifactReference,
    TemporalIntervalSelection,
)
from eolab_app.raster.temporal import ResolvedTemporalInterval
from eolab_app.processing.model_operations import get_model_operation
from eolab_app.processing.operation_context import OperationContext
from eolab_app.processing.vector_inputs import RetainedVectorSelectionReader
from eolab_app.processing.downstream_models import DownstreamLimits
from eolab_app.processing.ports import JobArtifactStore, JobStore, JobWakeup
from eolab_app.raster.errors import RasterFeatureError
from eolab_app.raster.ports import RasterSourceAuthorizer
from eolab_app.vector_uploads import VectorUploadStore
from eolab_app.processing.model_definitions import ModelRegistry
from eolab_app.processing.model_run_contracts import MODEL_OPERATION, ModelRunSpec
from eolab_app.processing.model_runs import (
    get_application_build_id,
    compute_implementation_checksum,
    record_model_preparation,
    declare_model_files,
)

LOGGER = logging.getLogger(__name__)


class ProcessingWorker:
    """Execute queued jobs, supervise their processes and publish completed results.

    Job storage controls claims and leases; registered operations prepare and
    calculate results. The worker maintains the lease and coordinates cancellation
    and cleanup throughout each attempt.
    """

    def __init__(
        self,
        authorizer: RasterSourceAuthorizer,
        jobs: JobStore,
        artifacts: JobArtifactStore,
        limits: RasterClipLimits,
        *,
        native: ReusableProcess | None = None,
        areas: CatalogSelectionReader | None = None,
        uploads: VectorUploadStore | None = None,
        downstream_limits: DownstreamLimits | None = None,
    ) -> None:
        """Configure source access, job storage, result files and calculation limits.

        Args:
            authorizer: Independent catalog source authorization.
            jobs: Durable global admission and attempt fencing.
            artifacts: Confined scratch and atomic result-file storage.
            limits: Deployment-wide concurrency, retention and cache policy.
            native: Lifecycle-managed execution lane supplied by composition.
            areas: Catalog vector reader used to resolve filtered calculation areas.
            uploads: Storage for original uploaded vectors retained by accepted jobs.
            downstream_limits: Optional downstream job lifecycle settings.
        """
        self.areas = areas
        self.uploads = uploads
        self.authorizer = authorizer
        self.jobs = jobs
        self.artifacts = artifacts
        self.limits = limits
        self.native = native
        self.aggregate_limits = RasterAggregateLimits.with_lifecycle(limits)
        self.downstream_limits = downstream_limits or DownstreamLimits.with_lifecycle(
            limits
        )
        # Fail startup for invalid packaged definitions rather than hiding them
        # from discovery or accepting work the worker cannot dispatch.
        ModelRegistry.load_installed()

    def _operation_context(
        self,
        row: dict[str, Any],
        reuse_results: bool,
        source_checksum: str | None = None,
    ) -> OperationContext:
        """Supply existing execution capabilities to a registered raster operation.

        Args:
            row: Claimed job with its retained upload references.
            reuse_results: Whether this attempt may reuse scalar results.
            source_checksum: Published checksum when using a private file.

        Returns:
            Operation context without browser, recipe or rendering state.

        Raises:
            ProcessingError: If retained upload reading is not configured.
        """
        areas = self.areas
        if row["input_uploads"]:
            if areas is None or self.uploads is None:
                raise ProcessingError(
                    "uploads_unavailable",
                    "Uploaded vector source access is unavailable.",
                    503,
                )
            areas = RetainedVectorSelectionReader(
                areas, self.uploads, row["input_uploads"]
            )
        return OperationContext(
            self.jobs,
            areas,
            self.limits,
            self.aggregate_limits,
            self.native,
            run_process,
            reuse_results,
            source_checksum,
            downstream_limits=self.downstream_limits,
        )

    async def _resolve_source(
        self,
        row: dict[str, Any],
        source: RasterSourceReference | TemporalIntervalSelection,
    ) -> tuple[AuthorizedRaster | ResolvedTemporalInterval, str | None]:
        """Resolve catalog raster observations or a file retained by this accepted job.

        Args:
            row: Claimed computation with its current attempt token.
            source: Operation-owned catalog raster, temporal interval or published-file reference.

        Returns:
            Confined raster input or temporal observations, and a checksum only for
            a private published file. A retained file survives parent expiry/deletion.

        Raises:
            ProcessingError: If the accepted grant or confined file is unavailable.
            RasterFeatureError: If catalog authorization fails.
        """
        if isinstance(source, TemporalIntervalSelection):
            return await self.authorizer.get_temporal_interval(source), None
        if not isinstance(source, RunArtifactReference):
            return await self.authorizer.authorize(source), None
        parent_attempt, file = await asyncio.to_thread(
            self.jobs.read_retained_input,
            row["id"],
            row["attempt_id"],
            source.job_id,
            source.artifact_id,
        )
        path = await asyncio.to_thread(
            self.artifacts.artifact_path, parent_attempt, file.storage_name
        )
        return (
            AuthorizedRaster(path, None),
            file.sha256,
        )

    async def _resolve_additional_sources(
        self,
        row: dict[str, Any],
        spec: Any,
        operation: Any,
    ) -> dict[str, AuthorizedRaster]:
        """Resolve additional Catalog or retained private rasters for this job.

        Args:
            row: Claimed job with the active attempt and retained input identities.
            spec: Queued or prepared operation specification.
            operation: Registered adapter declaring the additional raster references.

        Returns:
            Authorized native sources for this preparation or execution phase.

        Raises:
            ProcessingError: If a named source is unavailable.
        """
        result = {}
        for name, reference in (
            operation.extra_sources(spec) if operation.extra_sources else {}
        ).items():
            try:
                source, _ = await self._resolve_source(row, reference)
            except RasterFeatureError as error:
                raise ProcessingError(
                    "source_unavailable",
                    f"The model's {name} input is unavailable. {error.detail}",
                    422,
                ) from error
            result[name] = source
        return result

    async def _prepare_operation(
        self,
        row: dict[str, Any],
        calculation: BaseModel,
        model: ModelRunSpec | None,
    ) -> tuple[AuthorizedRaster | ResolvedTemporalInterval, str | None]:
        """Prepare the operation's inputs while the worker holds the job's execution lease.

        Args:
            row: Claimed job updated with its prepared specification.
            calculation: Validated queued specification for its registered operation.
            model: Validated recipe wrapper, or None for an ordinary raster job.

        Returns:
            Authorized source and published checksum reusable in this attempt.

        Raises:
            ProcessingError: If authorization or planning fails, or the attempt is cancelled.
        """
        operation = get_model_operation(calculation.operation)
        if not await asyncio.to_thread(
            self.jobs.heartbeat,
            row["id"],
            row["attempt_id"],
            {"phase": "preparing"},
        ):
            raise ProcessingError(
                "job_cancelled", "Calculation stopped before preparation.", 409
            )
        authorized, checksum = await self._resolve_source(
            row, operation.source(calculation)
        )
        context = self._operation_context(row, model is None, checksum)
        context.rasters.update(
            await self._resolve_additional_sources(row, calculation, operation)
        )
        prepared = await operation.prepare(context, calculation, authorized)
        if model is not None:
            prepared = record_model_preparation(row, model, prepared, self.limits)
        row.update(
            await asyncio.to_thread(
                self.jobs.save_prepared_job, row["id"], row["attempt_id"], prepared
            )
        )
        return authorized, checksum

    async def _execute(self, row: dict[str, Any]) -> Artifact:
        """Authorize the inputs, reuse or calculate values, and publish result files.

        Args:
            row: Job claimed with a unique execution fencing token.

        Returns:
            Metadata for the completed and published result files.

        Raises:
            ProcessingError: If the source, resources, or native operation fail.
        """
        operation = row["spec"]["operation"]
        model = (
            ModelRunSpec.model_validate(row["spec"])
            if operation == MODEL_OPERATION
            else None
        )
        if model is not None and (
            model.implementationRevision != compute_implementation_checksum()
            or model.applicationBuild != get_application_build_id()
        ):
            raise ProcessingError(
                "model_implementation_changed",
                "The model implementation changed before execution. Submit a new run.",
                409,
            )
        calculation_operation = model.calculation.operation if model else operation
        handler = get_model_operation(calculation_operation)
        calculation = handler.parse_specification(
            model.calculation if model else row["spec"]
        )
        authorized = None
        checksum = None
        if isinstance(calculation, handler.queued_type):
            authorized, checksum = await self._prepare_operation(
                row, calculation, model
            )
            calculation = (
                ModelRunSpec.model_validate(row["spec"]).calculation
                if model
                else handler.prepared_type.model_validate(row["spec"])
            )
        spec = calculation
        source = handler.source(spec)
        target, action, limits = handler.execution(
            spec, self._operation_context(row, model is None)
        )
        if authorized is None:
            authorized, checksum = await self._resolve_source(row, source)
        context = self._operation_context(row, model is None, checksum)
        context.rasters.update(
            await self._resolve_additional_sources(row, spec, handler)
        )
        native_sources, spec = await handler.execution_inputs(context, spec, authorized)
        directory = await asyncio.to_thread(
            self.artifacts.prepare,
            row["attempt_id"],
        )
        if model is None and handler.cached is not None:
            value = await handler.cached(context, spec, directory)
            if value is not None:
                return await self._publish_result(row, value)
        status, value = await run_process(
            target,
            (action, (native_sources, spec, directory, limits)),
            None,
            self.native,
        )
        if status != "ok":
            raise ProcessingError(*value)
        return await self._publish_result(row, value)

    async def _publish_result(
        self, row: dict[str, Any], artifact: Artifact
    ) -> Artifact:
        """Publish complete declared files without blocking heartbeats or racing cleanup.

        Args:
            row: Running attempt with its declared output files.
            artifact: Native result metadata; all native file handles are closed.

        Returns:
            The original scientific result with its verified immutable inventory.

        Raises:
            ProcessingError: If file validation or publication fails.
            asyncio.CancelledError: After the publication thread has stopped writing.
        """
        if row["spec"]["operation"] == MODEL_OPERATION:
            declarations = declare_model_files(row, artifact)
        else:
            declarations = (
                FileDeclaration(
                    name="result",
                    label="Result",
                    role="result",
                    storage_name=getattr(artifact, "result_name", "result.tif"),
                    filename=artifact.filename,
                    media_type=artifact.media_type,
                    size=artifact.size,
                    sha256=artifact.sha256,
                ),
            )
        declarations += (
            FileDeclaration(
                name="provenance",
                label="Provenance",
                role="provenance",
                storage_name="provenance.json",
                filename=str(PurePath(artifact.filename).with_suffix(".json")),
                media_type="application/json",
            ),
        )
        cancelled = Event()
        publication = asyncio.create_task(
            asyncio.to_thread(
                self.artifacts.publish,
                row["attempt_id"],
                declarations,
                cancelled,
            )
        )
        try:
            manifest = await asyncio.shield(publication)
        except asyncio.CancelledError:
            cancelled.set()
            # Repeated shutdown/cancel signals must not release cleanup while the
            # underlying thread is still hashing, deleting scratch, or renaming.
            while not publication.done():
                try:
                    await asyncio.shield(publication)
                except asyncio.CancelledError:
                    continue
                except Exception:
                    break
            if not publication.cancelled():
                publication.exception()
            raise
        # Database finish still fences cancellation/late attempts after the rename.
        return replace(artifact, manifest=manifest, additional_outputs=())

    async def run_once(self) -> bool:
        """Claim and fully supervise one attempt, or report that the slot is busy.

        Returns:
            True after handling a claimed job; False when nothing can be claimed.

        Raises:
            ProcessingError: If durable storage is unavailable.
            asyncio.CancelledError: After stopping native work on worker shutdown.
        """
        row = await asyncio.to_thread(self.jobs.claim_next_job)
        if row is None:
            return False
        identifier, attempt = row["id"], row["attempt_id"]
        task = asyncio.create_task(self._execute(row))
        finished = False
        try:
            while not task.done():
                progress = await asyncio.to_thread(self.artifacts.progress, attempt)
                if not await asyncio.to_thread(
                    self.jobs.heartbeat, identifier, attempt, progress
                ):
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                    await asyncio.to_thread(
                        self.jobs.finish,
                        identifier,
                        attempt,
                        None,
                        {
                            "code": "interrupted",
                            "detail": "The job was cancelled or its worker lease ended.",
                        },
                    )
                    finished = True
                    return True
                await asyncio.wait((task,), timeout=2)
            artifact = task.result()
            reusable_results = None
            if row["spec"]["operation"] != MODEL_OPERATION:
                handler = get_model_operation(row["spec"]["operation"])
                if handler.reusable is not None:
                    reusable_results = handler.reusable(
                        handler.prepared_type.model_validate(row["spec"]), artifact
                    )
            finished = await asyncio.to_thread(
                self.jobs.finish,
                identifier,
                attempt,
                artifact,
                reusable_results=reusable_results,
            )
            if not finished:
                await asyncio.to_thread(
                    self.jobs.finish,
                    identifier,
                    attempt,
                    None,
                    {
                        "code": "interrupted",
                        "detail": "This job was cancelled before publication.",
                    },
                )
                finished = True
        except asyncio.CancelledError:
            raise
        except Exception as error:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            if isinstance(error, ProcessingError):
                detail = {"code": error.code, "detail": error.detail}
            elif isinstance(error, (TimeoutError, ProcessDeadlineError)):
                detail = {
                    "code": "native_process_failed",
                    "detail": "The calculation process stopped before returning its result. Retry the run or ask the administrator to check the worker logs.",
                }
            elif isinstance(error, (RasterFeatureError, SelectionUnavailableError)):
                detail = {
                    "code": "source_unavailable",
                    "detail": "The input source is unavailable. Check the layer, then submit the job again.",
                }
            else:
                detail = {
                    "code": "processing_failed",
                    "detail": "The job worker could not complete this operation.",
                }
            # Log no raw source paths, session capabilities, or connection strings.
            LOGGER.warning("Processing job %s failed: %s", identifier, detail["code"])
            finished = await asyncio.to_thread(
                self.jobs.finish, identifier, attempt, None, detail
            )
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            if not finished:
                with suppress(ProcessingError):
                    await asyncio.to_thread(
                        self.jobs.finish,
                        identifier,
                        attempt,
                        None,
                        {
                            "code": "interrupted",
                            "detail": "The worker stopped before the job completed. Submit a new job to retry.",
                        },
                    )
        return True

    async def cleanup(self) -> None:
        """Remove terminal files/snapshots only after native and transfer leases end.

        Raises:
            ProcessingError: If storage state cannot be read safely.
            OSError: If filesystem cleanup failed; reservations are then retained.
        """
        for row in await asyncio.to_thread(self.jobs.cleanup_candidates):
            if row["attempt_id"]:
                await asyncio.to_thread(self.artifacts.remove, row["attempt_id"])
            await asyncio.to_thread(self.jobs.cleaned, row["id"])
        retained = await asyncio.to_thread(self.jobs.active_attempts)
        await asyncio.to_thread(self.artifacts.remove_orphans, retained, 30)


async def serve(
    worker: ProcessingWorker,
    wakeup: JobWakeup | None = None,
    cleanup_lock: asyncio.Lock | None = None,
) -> None:
    """Consume the queue using dependencies supplied by application composition.

    Args:
        worker: Composed worker with migrated storage and confined artifact paths.
        wakeup: Optional queue-change hints; durable claims remain authoritative.
        cleanup_lock: Shared by loops in the worker container so filesystem
            cleanup and its database acknowledgement cannot overlap.

    Raises:
        asyncio.CancelledError: After stopping active native work on shutdown.
    """
    try:
        while True:
            try:
                if wakeup is not None:
                    await wakeup.arm()
                if cleanup_lock is None:
                    await worker.cleanup()
                else:
                    async with cleanup_lock:
                        await worker.cleanup()
                if not await worker.run_once():
                    if wakeup is None:
                        await asyncio.sleep(2)
                    else:
                        await wakeup.wait(2)
            except (ProcessingError, OSError):
                LOGGER.warning(
                    "Processing worker storage is unavailable; retrying in five seconds"
                )
                await asyncio.sleep(5)
    finally:
        if wakeup is not None:
            await wakeup.close()
