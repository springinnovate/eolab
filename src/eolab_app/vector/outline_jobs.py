"""Request simplified outlines of filtered vector features through Jobs."""

from typing import Any

import httpx2

from eolab_jobs.client import JobFailed, JobsClient
from eolab_app.catalog_selection import CatalogSelection
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.outline_operation import OutlineResult


class OutlineJobs:
    """Submit map-outline jobs and validate the returned geometry and bounds."""

    def __init__(self, jobs: JobsClient) -> None:
        """Use an authenticated Jobs client for outline requests.

        Args:
            jobs: Operation-independent client with bounded transport/cleanup.
        """
        self.jobs = jobs

    async def __call__(self, selection: CatalogSelection) -> dict[str, Any]:
        """Create a simplified map outline for a catalog feature selection.

        Args:
            selection: Immutable Catalog identity, source signature and filter.

        Returns:
            Validated GeoJSON FeatureCollection and its WGS 84 bounding box.

        Raises:
            VectorConflictError: If execution or outline result validation fails.
            asyncio.CancelledError: After the client cancels abandoned work.
        """
        try:
            result = await self.jobs.run(
                {
                    "operation": "vector.outline.v1",
                    "inputs": {
                        "selection": selection.model_dump(mode="json", by_alias=True)
                    },
                    "priority": -10,
                    "executionTimeoutSeconds": 15,
                    "queueTimeoutSeconds": 10,
                },
                timeout_seconds=40,
                delete_on_completion=True,
            )
            return OutlineResult.model_validate(result.value).model_dump(mode="json")
        except (httpx2.HTTPError, ValueError, JobFailed, TimeoutError) as error:
            raise VectorConflictError(
                "The map outline is unavailable; retry the selection."
            ) from error
