"""Read Catalog parcel attributes through the existing supervised Jobs service."""

from typing import TypeVar

import httpx2
from pydantic import BaseModel

from eolab_jobs.client import JobFailed, JobsClient
from eolab_app.catalog_selection import CatalogSelection
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.parcel_models import (
    ParcelIdInput,
    ParcelIdValidation,
    ParcelRowsInput,
    ParcelRowsPage,
)
from eolab_app.vector.parcel_operation import ParcelIdResult, ParcelRowsResult

ParcelResult = TypeVar("ParcelResult", ParcelIdResult, ParcelRowsResult)


class ParcelJobs:
    """Submit parcel validation/page reads with ordinary queue and cancellation rules."""

    def __init__(self, jobs: JobsClient) -> None:
        """Use the authenticated Jobs connection supplied by application composition.

        Args:
            jobs: Existing client owning submission, waiting and cancellation cleanup.
        """
        self.jobs = jobs

    async def validate_ids(
        self, selection: CatalogSelection, id_field: str
    ) -> ParcelIdValidation:
        """Validate all original IDs without using the current display filter.

        Args:
            selection: Authorized whole-layer Catalog descriptor.
            id_field: One original string or integer field.

        Returns:
            Complete-layer ID type and feature count.

        Raises:
            VectorConflictError: Validation, source access or Jobs failed.
            asyncio.CancelledError: After abandoned job cleanup.
        """
        outcome = await self._run(
            "vector.parcel-id-validation.v1",
            ParcelIdInput(selection=selection, idField=id_field),
            ParcelIdResult,
        )
        if outcome.error is not None:
            raise VectorConflictError(outcome.error)
        return outcome.validation

    async def read_rows(
        self,
        selection: CatalogSelection,
        id_field: str,
        fields: tuple[str, ...],
        offset: int,
        limit: int,
    ) -> ParcelRowsPage:
        """Read one page in original-source order after exact filtering.

        Args:
            selection: Authorized Catalog layer and current ordinary filter.
            id_field: Original ID field validated when the tool is configured.
            fields: Original attributes requested as display text.
            offset: Matching rows skipped before this page.
            limit: Maximum rows in the page.

        Returns:
            Lossless IDs, display properties and next offset, including empty success.

        Raises:
            VectorConflictError: Source access, page reading or Jobs failed.
            asyncio.CancelledError: After abandoned job cleanup.
        """
        outcome = await self._run(
            "vector.parcel-rows.v1",
            ParcelRowsInput(
                selection=selection,
                idField=id_field,
                fields=fields,
                offset=offset,
                limit=limit,
            ),
            ParcelRowsResult,
        )
        if outcome.error is not None:
            raise VectorConflictError(outcome.error)
        return outcome.page

    async def _run(
        self, operation: str, inputs: BaseModel, result_type: type[ParcelResult]
    ) -> ParcelResult:
        """Execute a parcel read under existing interactive Jobs budgets.

        Args:
            operation: Installed parcel operation name.
            inputs: Validated path-free native input.
            result_type: Expected result schema at the Jobs transport boundary.

        Returns:
            Validated operation result.

        Raises:
            VectorConflictError: Queue capacity, native read or transport failed.
            asyncio.CancelledError: After ordinary Jobs cancellation cleanup.
        """
        try:
            result = await self.jobs.run(
                {
                    "operation": operation,
                    "inputs": inputs.model_dump(mode="json", by_alias=True),
                    "priority": 0,
                    "executionTimeoutSeconds": 15,
                    "queueTimeoutSeconds": 30,
                },
                timeout_seconds=60,
                delete_on_completion=True,
            )
            return result_type.model_validate(result.value)
        except JobFailed as error:
            message = {
                "expired": "Parcel reading waited too long in the queue; try again.",
                "timed_out": "Parcel reading exceeded its time budget; use a smaller source.",
                "cancelled": "Parcel reading was cancelled; try again.",
            }.get(error.snapshot.status, "Parcels could not be read; try again.")
            raise VectorConflictError(message) from error
        except httpx2.HTTPStatusError as error:
            message = (
                "The application is busy or unavailable; try reading parcels again shortly."
                if error.response.status_code == 503
                else "Parcel reading is unavailable; try again."
            )
            raise VectorConflictError(message) from error
        except (httpx2.HTTPError, ValueError, TimeoutError) as error:
            raise VectorConflictError(
                "Parcel reading is unavailable; try again."
            ) from error
