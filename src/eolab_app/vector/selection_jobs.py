"""Count filtered vector features through the Jobs service."""

from typing import Any

import httpx2

from eolab_jobs.client import JobFailed, JobsClient
from eolab_app.catalog_selection import VectorSelection
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.selection_operation import ComparisonResult, SelectionMeasurementResult


async def compare_selection_job(
    jobs: JobsClient, token: str, execution_seconds: int, *, max_timeout_seconds: float
) -> None:
    """Queue an exact polygon comparison and hold both original inputs until native exit.

    Args:
        jobs: Authenticated application connection to the existing Jobs queue.
        token: One-request capability for obtaining the source pair and returning its IDs.
        execution_seconds: Requested native budget for the comparison or Lasso stages.
        max_timeout_seconds: Operator's ceiling for queue and execution time.

    Raises:
        VectorConflictError: If the queue or native reader cannot complete the comparison.
        asyncio.CancelledError: After the job has stopped using both original sources.
    """
    # Jobs accepts whole-second overrides. Below one second its configured defaults apply.
    whole_seconds = int(max_timeout_seconds)
    execution_limit = min(execution_seconds, whole_seconds)
    queue_limit = min(30, whole_seconds)
    try:
        result = await jobs.run(
            {
                "operation": "vector.intersection.v1",
                "inputs": {"spatialRead": token},
                "priority": 0,
                "executionTimeoutSeconds": execution_limit or None,
                "queueTimeoutSeconds": queue_limit or None,
            },
            timeout_seconds=queue_limit + execution_limit + 10,
            delete_on_completion=True,
            require_terminal_cleanup=True,
        )
        outcome = ComparisonResult.model_validate(result.value)
    except (JobFailed, httpx2.HTTPError, ValueError, TimeoutError) as error:
        raise VectorConflictError("The polygon comparison could not finish. Try again.") from error
    if outcome.error:
        raise VectorConflictError(outcome.error)


class SelectionJobs:
    """Submit feature-count jobs with deadlines and readable errors."""

    def __init__(self, jobs: JobsClient) -> None:
        """Use the application's authenticated Jobs connection.

        Args:
            jobs: Client that submits jobs, waits for results and cancels abandoned work.
        """
        self.jobs = jobs

    async def __call__(
        self,
        selection: VectorSelection,
        upload_owner: str | None = None,
        read_lease: str | None = None,
    ) -> dict[str, Any]:
        """Queue an attribute read and return exact feature counts when it finishes.

        Args:
            selection: Catalog or upload source and filter, with no private path.
            upload_owner: Server-derived browser identity, kept inside Jobs.
            read_lease: Result-file capability held until native work stops.

        Returns:
            Matching and total feature counts.

        Raises:
            VectorConflictError: For empty selections, read failures or Jobs overload.
            asyncio.CancelledError: After Jobs cancels and cleans up abandoned work.
        """
        try:
            result = await self.jobs.run(
                {
                    "operation": "vector.selection-measurement.v1",
                    "inputs": {
                        "selection": selection.model_dump(mode="json", by_alias=True),
                        "uploadOwner": upload_owner,
                        **({"readLease": read_lease} if read_lease is not None else {}),
                    },
                    "priority": 0,
                    "executionTimeoutSeconds": 15,
                    "queueTimeoutSeconds": 30,
                },
                timeout_seconds=60,
                delete_on_completion=True,
                require_terminal_cleanup=read_lease is not None,
            )
            measured = SelectionMeasurementResult.model_validate(result.value)
        except JobFailed as error:
            message = {
                "expired": "Vector selection waited too long in the job queue; try again.",
                "timed_out": "Vector reading exceeded its time budget",
                "cancelled": "Vector selection was canceled; select the features again.",
            }.get(
                error.snapshot.status,
                "The selected vector features could not be counted; try again.",
            )
            raise VectorConflictError(message) from error
        except httpx2.HTTPStatusError as error:
            message = (
                "The vector selection job service is busy or unavailable; try again shortly."
                if error.response.status_code == 503
                else "The vector selection job service is unavailable; try again."
            )
            raise VectorConflictError(message) from error
        except (httpx2.HTTPError, ValueError, TimeoutError) as error:
            raise VectorConflictError(
                "The vector selection job service is unavailable; try again."
            ) from error
        if measured.error is not None:
            raise VectorConflictError(measured.error)
        return measured.measurements.model_dump(mode="json")
