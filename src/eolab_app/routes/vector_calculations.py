"""Calculate private vector-view fields without changing their original sources."""

from collections.abc import Callable
from typing import cast

from fastapi import APIRouter, HTTPException, Request, Response

from eolab_app.routes.browser_identity import get_browser_owner_hash
from eolab_app.routes.http_disconnect import (
    HttpClientDisconnectedError,
    run_until_http_disconnect,
)
from eolab_app.routes.vector_http import PrivateVectorRoute
from eolab_app.source_files import LeasedSourceFiles
from eolab_app.vector.field_calculation import (
    ArtifactCalculationSource,
    FieldCalculationInput,
    FieldCalculationJobs,
    FieldCalculationRequest,
    FieldCalculationResult,
    UploadedCalculationSource,
)


def create_vector_calculation_router(
    calculations: FieldCalculationJobs,
    files: LeasedSourceFiles,
    read_result_owner: Callable[[Request, Response], str],
) -> APIRouter:
    """Connect the calculator to existing execution and private-source lifecycles.

    Args:
        calculations: Jobs-backed attribute scan, independent of rendering.
        files: Original run-file authorization and renewable read-lease owner.
        read_result_owner: Composition-supplied Processing session boundary.

    Returns:
        A private endpoint whose aborted requests cancel native work before cleanup.
    """
    router = APIRouter(
        prefix="/api/vector-calculations",
        tags=["vector calculations"],
        route_class=PrivateVectorRoute,
    )

    @router.post("", response_model=FieldCalculationResult)
    async def calculate_fields(
        body: FieldCalculationRequest, request: Request, response: Response
    ) -> FieldCalculationResult:
        """Check every feature before accepting a view's complete formula list.

        Args:
            body: Source identifiers and ordered calculated-field definitions.
            request: Same-origin credentials and connection cancellation observer.
            response: Renews the appropriate private-source cookie.

        Returns:
            Accepted definitions, combined attribute metadata and missing counts.

        Raises:
            HTTPException: If the browser disconnects or private authorization fails.
            SourceFileError: If a run result is unavailable, expired or loses its lease.
            VectorConflictError: If calculation, validation or original-source reading fails.
        """
        source = body.source
        upload_owner = (
            get_browser_owner_hash(request, response, mutation_header="X-EOLab-Uploads")
            if isinstance(source, UploadedCalculationSource)
            else None
        )
        result_owner = (
            read_result_owner(request, response)
            if isinstance(source, ArtifactCalculationSource)
            else None
        )

        async def calculate() -> FieldCalculationResult:
            """Retain private result files until all calculation work has stopped.

            Returns:
                Complete accepted definitions after source access is rechecked.

            Raises:
                SourceFileError: If the private run file is unavailable.
                VectorConflictError: If the calculation cannot finish.
            """
            if isinstance(source, ArtifactCalculationSource):
                async with files.open(
                    cast(str, result_owner), source.jobId, source.artifactId
                ) as file:
                    return await calculations.calculate(
                        FieldCalculationInput(
                            source=source,
                            calculatedFields=body.calculatedFields,
                            readLease=file.lease_id,
                        )
                    )
            return await calculations.calculate(
                FieldCalculationInput(
                    source=source,
                    calculatedFields=body.calculatedFields,
                    uploadOwner=upload_owner,
                )
            )

        try:
            return await run_until_http_disconnect(request, calculate())
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Field calculation cancelled") from error

    return router
