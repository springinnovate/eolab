"""Submit vector-area measurements through the existing Jobs lifecycle client."""

from typing import Any

import httpx2

from eolab_jobs.client import JobFailed, JobsClient
from eolab_app.catalog_selection import CatalogSelection
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.selection_operation import SelectionMeasurementResult


class SelectionJobs:
    """Set measurement priority/deadlines and interpret its result for Vector."""

    def __init__(self, jobs: JobsClient) -> None:
        """Use the application's authenticated Jobs connection.

        Args:
            jobs: Existing client owning submission, observation and cancellation.
        """
        self.jobs = jobs

    async def __call__(self, selection: CatalogSelection) -> dict[str, Any]:
        """Queue a feature measurement and return counts/bounds when it finishes.

        Args:
            selection: Catalog source and filter, with no private path/geometry.

        Returns:
            The existing selection API's measurement fields.

        Raises:
            VectorConflictError: For invalid features, Jobs failure or overload.
            asyncio.CancelledError: After Jobs cancels and cleans up abandoned work.
        """
        try:
            result = await self.jobs.run(
                {
                    "operation": "vector.selection-measurement.v1",
                    "inputs": {
                        "selection": selection.model_dump(mode="json", by_alias=True)
                    },
                    "priority": 0,
                    "executionTimeoutSeconds": 15,
                    "queueTimeoutSeconds": 30,
                },
                timeout_seconds=60,
                delete_on_completion=True,
            )
            measured = SelectionMeasurementResult.model_validate(result.value)
        except JobFailed as error:
            message = {
                "expired": "Vector selection waited too long in the job queue; try again.",
                "timed_out": "Vector reading exceeded its time budget",
                "cancelled": "Vector selection was canceled; select the features again.",
            }.get(
                error.snapshot.status,
                "The selected vector features could not be measured; try again.",
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
