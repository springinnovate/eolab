"""Request complete vector field statistics through the shared Jobs queue."""

import httpx2

from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.field_statistics import (
    VectorFieldStatistics,
    VectorLayerStatisticsRequest,
)
from eolab_app.vector.selection_operation import (
    LayerStatisticsInput,
    LayerStatisticsResult,
)
from eolab_jobs.client import JobFailed, JobsClient


class LayerStatisticsJobs:
    """Submit whole-layer field reads with the existing execution and lease lifecycle."""

    def __init__(self, jobs: JobsClient) -> None:
        """Use the application's authenticated Jobs connection.

        Args:
            jobs: Client that supervises queued work and its cancellation.
        """
        self.jobs = jobs

    async def __call__(
        self,
        request: VectorLayerStatisticsRequest,
        upload_owner: str | None,
        read_lease: str | None,
    ) -> tuple[VectorFieldStatistics, ...]:
        """Return complete benchmarks after the registered worker finishes.

        Args:
            request: Original source identity and requested fields.
            upload_owner: Server-derived credential for a private upload.
            read_lease: Protected read token held by the caller for a run result.

        Returns:
            Complete whole-layer statistics in field order.

        Raises:
            VectorConflictError: If the worker cannot complete the original-layer read.
            asyncio.CancelledError: After cancellation and required lease cleanup.
        """
        inputs = LayerStatisticsInput(
            request=request, uploadOwner=upload_owner, readLease=read_lease
        )
        try:
            result = await self.jobs.run(
                {
                    "operation": "vector.layer-statistics.v1",
                    "inputs": inputs.model_dump(
                        mode="json", by_alias=True, exclude_none=True
                    ),
                    "priority": 0,
                    "executionTimeoutSeconds": 20,
                    "queueTimeoutSeconds": 30,
                },
                timeout_seconds=60,
                delete_on_completion=True,
                require_terminal_cleanup=read_lease is not None,
            )
            return LayerStatisticsResult.model_validate(result.value).summaries
        except JobFailed as error:
            message = {
                "expired": "Layer statistics waited too long in the job queue.",
                "timed_out": "Reading the whole layer took too long.",
            }.get(error.snapshot.status, "The whole layer could not be read.")
            raise VectorConflictError(message) from error
        except (httpx2.HTTPError, ValueError, TimeoutError) as error:
            raise VectorConflictError("Layer statistics are unavailable.") from error
