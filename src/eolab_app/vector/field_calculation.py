"""Submit whole-layer arithmetic checks through the authenticated Jobs client."""

from typing import Annotated, cast

import httpx2
from pydantic import BaseModel, ConfigDict, Field, model_validator

from eolab_app.calculated_fields import CalculatedField
from eolab_app.catalog.vector_contract import CatalogVectorRequest
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector import field_calculation_operation
from eolab_jobs.client import JobFailed, JobsClient, MAX_REQUEST_BYTES


class FieldCalculationRequest(BaseModel):
    """Define the complete ordered calculated-field list for one vector view.

    Attributes:
        source: Catalog, upload or run-file identity; never a filesystem path.
        calculatedFields: Candidate definitions. Each may use original fields or
            earlier definitions. The view installs the complete list on success.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    source: (
        CatalogVectorRequest
        | field_calculation_operation.UploadedCalculationSource
        | field_calculation_operation.ArtifactCalculationSource
    )
    calculatedFields: Annotated[tuple[CalculatedField, ...], Field(max_length=64)]

    @model_validator(mode="after")
    def bound_definition_payload(self) -> "FieldCalculationRequest":
        """Leave room for private credentials inside the Jobs request size limit.

        Returns:
            This accepted source and definition list.

        Raises:
            ValueError: If the formula definitions cannot fit in one Jobs request.
        """
        if (
            len(self.model_dump_json(by_alias=True).encode("utf-8"))
            > MAX_REQUEST_BYTES - 1024
        ):
            raise ValueError(
                "These field definitions are too large. Shorten the expressions or use fewer fields."
            )
        return self


class FieldCalculationJobs:
    """Run a complete attribute calculation and cancel it when its caller leaves."""

    def __init__(self, jobs: JobsClient) -> None:
        """Use the application's authenticated Jobs client.

        Args:
            jobs: Existing execution, observation and cancellation adapter.
        """
        self.jobs = jobs

    async def calculate(
        self, inputs: field_calculation_operation.FieldCalculationInput
    ) -> field_calculation_operation.FieldCalculationResult:
        """Wait for whole-layer validation before returning accepted definitions.

        Args:
            inputs: Source identity, candidate fields and server-only credentials.

        Returns:
            Complete field metadata and missing-value counts; no partial installation.

        Raises:
            VectorConflictError: If a formula, source or execution service is unavailable.
            asyncio.CancelledError: After Jobs confirms the native process has stopped.
        """
        try:
            result = await self.jobs.run(
                {
                    "operation": "vector.field-calculation.v1",
                    "inputs": inputs.model_dump(mode="json", by_alias=True),
                    "priority": 0,
                },
                timeout_seconds=None,
                delete_on_completion=True,
                require_terminal_cleanup=True,
            )
            outcome = (
                field_calculation_operation.FieldCalculationOutcome.model_validate(
                    result.value
                )
            )
        except JobFailed as error:
            raise VectorConflictError(
                "The field calculation could not finish. Try again."
            ) from error
        except (httpx2.HTTPError, ValueError, TimeoutError) as error:
            raise VectorConflictError(
                "The field calculator is temporarily unavailable. Try again shortly."
            ) from error
        if outcome.error is not None:
            raise VectorConflictError(outcome.error)
        return cast(field_calculation_operation.FieldCalculationResult, outcome.result)
