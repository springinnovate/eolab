"""Application workflow and supervision for the dedicated clip worker."""

import asyncio
from contextlib import suppress
import logging
from typing import Any

from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
    run_bounded_process,
)
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.clip_models import ClipSpec, RasterClipLimits
from eolab_app.processing.ports import ClipArtifactStore, JobStore
from eolab_app.processing.raster_clip import clip_process_target
from eolab_app.raster.errors import RasterFeatureError
from eolab_app.raster.ports import RasterSourceAuthorizer

LOGGER = logging.getLogger(__name__)


class RasterClipWorker:
    """Own one attempt's workflow without teaching storage about application services."""

    def __init__(
        self,
        authorizer: RasterSourceAuthorizer,
        jobs: JobStore,
        artifacts: ClipArtifactStore,
        limits: RasterClipLimits,
    ) -> None:
        """Compose the worker's narrow capabilities.

        Args:
            authorizer: Independent catalog source authorization.
            jobs: Durable global admission and attempt fencing.
            artifacts: Confined scratch and atomic result-file storage.
            limits: Deployment-wide bounded processing policy.
        """
        self.authorizer = authorizer
        self.jobs = jobs
        self.artifacts = artifacts
        self.limits = limits

    async def _execute(self, row: dict[str, Any]) -> Any:
        """Authorize, run a native child, and publish only a validated result.

        Args:
            row: Job claimed with a unique execution fencing token.

        Returns:
            Validated artifact metadata after an atomic filesystem rename.

        Raises:
            ProcessingError: If the source, resources, or native operation fail.
        """
        spec = ClipSpec.model_validate(row["spec"])
        authorized = await self.authorizer.authorize(spec.source)
        if tuple(authorized.source_signature.to_catalog()) != spec.sourceSignature:
            raise ProcessingError(
                "source_changed",
                "The raster changed before clipping. Create a new plan.",
                409,
            )
        directory = await asyncio.to_thread(
            self.artifacts.prepare,
            row["attempt_id"],
            row["reserved_bytes"],
            self.limits,
        )
        status, value = await run_bounded_process(
            clip_process_target,
            ("clip", (authorized.source_path, spec, directory, self.limits)),
            self.limits.runtime_seconds,
        )
        if status != "ok":
            raise ProcessingError(*value)
        await self.authorizer.require_current(authorized)
        # The heartbeat/fencing check in finish is still required after rename;
        # if cancellation wins the race, this private file is never advertised.
        # This bounded local-directory rename must finish before cancellation
        # can mark the attempt terminal and permit cleanup of its files.
        self.artifacts.publish(row["attempt_id"], row["reserved_bytes"])
        return value

    async def run_once(self) -> bool:
        """Claim and fully supervise one attempt, or report that the slot is busy.

        Returns:
            True after handling a claimed job; False when nothing can be claimed.

        Raises:
            ProcessingError: If durable storage is unavailable.
            asyncio.CancelledError: After stopping native work on worker shutdown.
        """
        row = await asyncio.to_thread(self.jobs.claim)
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
                                "detail": "The clip was cancelled or its worker lease ended.",
                            },
                        )
                        finished = True
                        return True
                    await asyncio.wait((task,), timeout=2)
                artifact = task.result()
                finished = await asyncio.to_thread(
                    self.jobs.finish, identifier, attempt, artifact
                )
                if not finished:
                    await asyncio.to_thread(
                        self.jobs.finish,
                        identifier,
                        attempt,
                        None,
                        {
                            "code": "interrupted",
                            "detail": "This clip was cancelled before publication.",
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
                    "detail": "The clip exceeded its processing time limit. Choose a smaller area.",
                }
            elif isinstance(error, RasterFeatureError):
                detail = {
                    "code": "source_unavailable",
                    "detail": "The catalog source is unavailable or changed. Create a new plan after checking the layer.",
                }
            else:
                detail = {
                    "code": "processing_failed",
                    "detail": "The clip worker could not complete this operation.",
                }
            # Log no raw source paths, session capabilities, or connection strings.
            LOGGER.warning("Clip %s failed: %s", identifier, detail["code"])
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
                            "detail": "The worker stopped before the clip completed. Create a new clip to retry.",
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


async def serve(worker: RasterClipWorker) -> None:
    """Consume the queue using dependencies supplied by application composition.

    Args:
        worker: Composed worker with migrated storage and confined artifact paths.

    Raises:
        asyncio.CancelledError: After stopping active native work on shutdown.
    """
    while True:
        try:
            await worker.cleanup()
            if not await worker.run_once():
                await asyncio.sleep(2)
        except (ProcessingError, OSError):
            LOGGER.warning(
                "Clip worker storage is unavailable; retrying in five seconds"
            )
            await asyncio.sleep(5)
