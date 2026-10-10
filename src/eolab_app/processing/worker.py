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

from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
)
from eolab_app.execution.reusable_process import ReusableProcess, run_process
from eolab_app.processing.models import Artifact, ProcessingError
from eolab_app.processing.artifact_manifest import FileDeclaration
from eolab_app.processing.clip_models import RasterClipLimits
from eolab_app.processing.aggregate_models import RasterAggregateLimits
from eolab_app.raster.models import AuthorizedRaster
from eolab_app.raster.source_models import RasterSourceReference, RunArtifactReference
from eolab_app.raster.source_identity import RasterSourceIdentity
from eolab_app.source_files import verify_source_file
from eolab_app.processing.model_operations import get_model_operation
from eolab_app.processing.raster_operations import RasterOperationContext
from eolab_app.processing.ports import JobArtifactStore, JobStore, JobWakeup
from eolab_app.raster.errors import RasterFeatureError
from eolab_app.raster.ports import RasterSourceAuthorizer
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
    """Own one attempt's workflow without teaching storage about application services."""

    def __init__(
        self,
        authorizer: RasterSourceAuthorizer,
        jobs: JobStore,
        artifacts: JobArtifactStore,
        limits: RasterClipLimits,
        *,
        native: ReusableProcess | None = None,
        areas: CatalogSelectionReader | None = None,
    ) -> None:
        """Compose the worker's narrow capabilities.

        Args:
            authorizer: Independent catalog source authorization.
            jobs: Durable global admission and attempt fencing.
            artifacts: Confined scratch and atomic result-file storage.
            limits: Deployment-wide bounded processing policy.
            native: Lifecycle-managed execution lane supplied by composition.
            areas: Catalog vector reader used to resolve filtered calculation areas.
        """
        self.areas = areas
        self.authorizer = authorizer
        self.jobs = jobs
        self.artifacts = artifacts
        self.limits = limits
        self.native = native
        self.aggregate_limits = RasterAggregateLimits.with_lifecycle(limits)
        # Fail startup for invalid packaged definitions rather than hiding them
        # from discovery or accepting work the worker cannot dispatch.
        ModelRegistry.load_installed()

    def _operation_context(
        self, reuse_results: bool, source_checksum: str | None = None
    ) -> RasterOperationContext:
        """Supply existing execution capabilities to a registered raster operation.

        Args:
            reuse_results: Whether this attempt may reuse scalar results.
            source_checksum: Verified published checksum when using a private file.

        Returns:
            Operation context without browser, recipe or rendering state.
        """
        return RasterOperationContext(
            self.jobs,
            self.areas,
            self.limits,
            self.aggregate_limits,
            self.native,
            run_process,
            reuse_results,
            source_checksum,
        )

    async def _resolve_source(
        self, row: dict[str, Any], source: RasterSourceReference
    ) -> tuple[AuthorizedRaster, str | None]:
        """Authorize catalog data or verify a file retained by this accepted job.

        Args:
            row: Claimed computation with its current attempt token.
            source: Operation-owned catalog or published-file reference.

        Returns:
            Confined raster path and stat identity, plus its published checksum
            for private inputs. The durable grant survives parent expiry/deletion.

        Raises:
            ProcessingError: If the accepted grant or file identity is invalid.
            RasterFeatureError: If catalog authorization fails.
            ProcessDeadlineError: If bounded checksum verification times out.
        """
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
        identity = await run_process(
            verify_source_file,
            (path, file.size, file.sha256),
            min(30, self.limits.plan_timeout_seconds),
            self.native,
        )
        if identity is None:
            raise ProcessingError(
                "source_changed",
                "The retained raster is no longer intact. Run the parent model again.",
                409,
            )
        return (
            AuthorizedRaster(
                path, RasterSourceIdentity.from_catalog(list(identity[1:]))
            ),
            file.sha256,
        )

    async def _prepare_operation(
        self, row: dict[str, Any]
    ) -> tuple[AuthorizedRaster, str | None]:
        """Prepare registered operation inputs within the current fenced attempt.

        Args:
            row: Claimed job updated with its prepared specification and reservation.

        Returns:
            Authorized source and published checksum reusable in this attempt.

        Raises:
            ProcessingError: If authorization, cancellation, planning or reservation fails.
            TimeoutError: If preparation exceeds its time limit.
        """
        model = (
            ModelRunSpec.model_validate(row["spec"])
            if row["spec"]["operation"] == MODEL_OPERATION
            else None
        )
        data = model.calculation if model else row["spec"]
        identifier = data.operation if model else data["operation"]
        operation = get_model_operation(identifier)
        queued = operation.parse_specification(data)
        async with asyncio.timeout(self.limits.plan_timeout_seconds):
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
                row, operation.source(queued)
            )
            if (
                model is not None
                and model.sourceSignature is not None
                and tuple(authorized.source_signature.to_catalog())
                != model.sourceSignature
            ):
                raise ProcessingError(
                    "source_changed",
                    "The raster changed after this model run was accepted.",
                    409,
                )
            prepared = await operation.prepare(
                self._operation_context(model is None, checksum), queued, authorized
            )
            if model is not None:
                prepared = record_model_preparation(row, prepared, self.limits)
            row.update(
                await asyncio.to_thread(
                    self.jobs.save_prepared_job, row["id"], row["attempt_id"], prepared
                )
            )
            return authorized, checksum

    async def _execute(self, row: dict[str, Any]) -> Artifact | None:
        """Authorize the inputs, reuse or calculate values, and publish result files.

        Args:
            row: Job claimed with a unique execution fencing token.

        Returns:
            Result-file metadata, or None after preparation returns the job to
            the existing queue until its disk reservation fits.

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
            authorized, checksum = await self._prepare_operation(row)
            if not handler.reuse_prepared_source:
                authorized = None
        if row["status"] == "queued":
            return None
        calculation_spec = (
            ModelRunSpec.model_validate(row["spec"]).calculation
            if model
            else row["spec"]
        )
        spec = handler.prepared_type.model_validate(calculation_spec)
        source = handler.source(spec)
        resolved_area = None
        if spec.area.kind == "catalogSelection":
            if self.areas is None:
                raise ProcessingError(
                    "selection_unavailable",
                    "Catalog selection reader is unavailable.",
                    409,
                )
            resolved_area = await self.areas.resolve_for_sampling(
                spec.area.catalogSelection
            )
            spec = spec.model_copy(
                update={
                    "area": spec.area.model_copy(update={"resolved": resolved_area})
                }
            )
        if authorized is None:
            authorized, checksum = await self._resolve_source(row, source)
        if spec.sourceChecksum != checksum:
            raise ProcessingError(
                "source_changed",
                "The prepared input does not match the accepted raster file.",
                409,
            )
        context = self._operation_context(model is None, checksum)
        target, action, limits = handler.execution(spec, context, row["reserved_bytes"])
        if (
            model is not None
            and model.sourceSignature is not None
            and tuple(authorized.source_signature.to_catalog()) != model.sourceSignature
        ):
            raise ProcessingError(
                "source_changed",
                "The raster changed after this model run was accepted.",
                409,
            )
        directory = await asyncio.to_thread(
            self.artifacts.prepare,
            row["attempt_id"],
            row["reserved_bytes"],
            self.limits,
        )
        if model is None:
            value = await handler.cached(context, spec, directory)
            if value is not None:
                if resolved_area is not None:
                    await self.areas.resolve_for_sampling(resolved_area.selection)
                if (
                    checksum is not None
                    and RasterSourceIdentity.read(authorized.source_path)
                    != authorized.source_signature
                ):
                    raise ProcessingError(
                        "source_changed",
                        "The retained raster changed during calculation.",
                        409,
                    )
                return await self._publish_result(row, value)
        status, value = await run_process(
            target,
            (action, (authorized.source_path, spec, directory, limits)),
            self.limits.runtime_seconds,
            self.native,
        )
        if status != "ok":
            raise ProcessingError(*value)
        if (
            checksum is not None
            and RasterSourceIdentity.read(authorized.source_path)
            != authorized.source_signature
        ):
            raise ProcessingError(
                "source_changed", "The retained raster changed during calculation.", 409
            )
        if resolved_area is not None:
            await self.areas.resolve_for_sampling(resolved_area.selection)
        return await self._publish_result(row, value)

    async def _publish_result(
        self, row: dict[str, Any], artifact: Artifact
    ) -> Artifact:
        """Publish complete declared files without blocking heartbeats or racing cleanup.

        Args:
            row: Running attempt with its admitted disk reservation and declarations.
            artifact: Native result metadata; all native file handles are closed.

        Returns:
            The original scientific result with its verified immutable inventory.

        Raises:
            ProcessingError: If file validation, retention limits or publication fail.
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
                row["reserved_bytes"],
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
            async with asyncio.timeout(self.limits.runtime_seconds):
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
                if artifact is None:
                    # Preparation has stopped and durable storage owns the wait.
                    finished = True
                    return True
                reusable_results = None
                if row["spec"]["operation"] != MODEL_OPERATION:
                    handler = get_model_operation(row["spec"]["operation"])
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
                    "code": "time_limit",
                    "detail": "The job exceeded its processing time limit. Choose a smaller area.",
                }
            elif isinstance(error, (RasterFeatureError, SelectionUnavailableError)):
                detail = {
                    "code": "source_unavailable",
                    "detail": "The catalog source is unavailable or changed. Check the layer, then submit the job again.",
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
        await asyncio.to_thread(
            self.artifacts.remove_orphans, retained, self.limits.runtime_seconds + 30
        )


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
