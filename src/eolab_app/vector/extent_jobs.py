"""Read filtered original-source bounds through the Jobs service."""

from typing import Any

import httpx2

from eolab_jobs.client import JobFailed, JobsClient
from eolab_app.catalog_selection import VectorSelection
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.extent_operation import (
    ArtifactExtentSelection,
    SelectionExtentResult,
)


class ExtentJobs:
    """Submit original-source extent jobs with cancellation and readable errors."""

    def __init__(self, jobs: JobsClient) -> None:
        """Use the application's authenticated Jobs connection.

        Args:
            jobs: Client that submits jobs, waits for results and cancels abandoned work.
        """
        self.jobs = jobs

    async def __call__(
        self, selection: VectorSelection, upload_owner: str | None = None
    ) -> dict[str, Any]:
        """Queue an original-source read and return projected feature envelopes.

        Args:
            selection: Catalog or upload source and filter, with no private path.
            upload_owner: Server-derived browser identity, kept inside Jobs.

        Returns:
            Matching count and WGS84 bounds, including an empty successful result.

        Raises:
            VectorConflictError: For read failures or Jobs overload.
            asyncio.CancelledError: After Jobs cancels and cleans up abandoned work.
        """
        return await self._measure(
            {
                "selection": selection.model_dump(mode="json", by_alias=True),
                "uploadOwner": upload_owner,
            }
        )

    async def measure_artifact(
        self, selection: ArtifactExtentSelection, read_lease: str
    ) -> dict[str, Any]:
        """Measure a run artifact while retaining its lease until native work stops.

        Args:
            selection: Opaque run/file identities and the selected attribute filter.
            read_lease: Existing source-owner capability held by the calling request.

        Returns:
            Matching count and WGS84 bounds, including an empty successful result.

        Raises:
            VectorConflictError: For unavailable sources, native failures or Jobs overload.
            asyncio.CancelledError: Only after Jobs confirms native work has stopped.
        """
        return await self._measure(
            {
                "selection": selection.model_dump(mode="json"),
                "readLease": read_lease,
            },
            require_terminal_cleanup=True,
        )

    async def _measure(
        self, inputs: dict[str, Any], *, require_terminal_cleanup: bool = False
    ) -> dict[str, Any]:
        """Execute the registered extent operation with its established queue budgets.

        Args:
            inputs: Captured source descriptor and its server-only read credential.
            require_terminal_cleanup: Keep cancellation pending until Jobs confirms exit,
                so a caller holding a deletable result file can safely release it.

        Returns:
            Validated matching count and projected bounds.

        Raises:
            VectorConflictError: If Jobs or the original source cannot supply an extent.
            asyncio.CancelledError: After the selected cancellation cleanup completes.
        """
        try:
            result = await self.jobs.run(
                {
                    "operation": "vector.selection-extent.v1",
                    "inputs": inputs,
                    "priority": 0,
                    "executionTimeoutSeconds": 15,
                    "queueTimeoutSeconds": 30,
                },
                timeout_seconds=60,
                delete_on_completion=True,
                require_terminal_cleanup=require_terminal_cleanup,
            )
            measured = SelectionExtentResult.model_validate(result.value)
        except JobFailed as error:
            message = {
                "expired": "Vector zoom waited too long in the job queue; try again.",
                "timed_out": "Vector reading exceeded its time budget",
                "cancelled": "Vector zoom was cancelled; try again.",
            }.get(
                error.snapshot.status,
                "Bounds of the filtered features could not be read; try zooming again.",
            )
            raise VectorConflictError(message) from error
        except httpx2.HTTPStatusError as error:
            message = (
                "The application is busy or unavailable; try zooming again shortly."
                if error.response.status_code == 503
                else "Filtered features are unavailable; try zooming again."
            )
            raise VectorConflictError(message) from error
        except (httpx2.HTTPError, ValueError, TimeoutError) as error:
            raise VectorConflictError(
                "Filtered features are unavailable; try zooming again."
            ) from error
        if measured.error is not None:
            raise VectorConflictError(measured.error)
        return measured.extent.model_dump(mode="json")
