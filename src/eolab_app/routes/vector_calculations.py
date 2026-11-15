"""Calculate private vector-view fields without changing their original sources."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Annotated, cast

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, StrictStr
from starlette.responses import JSONResponse, StreamingResponse
from starlette.types import Receive, Scope, Send

from eolab_app.calculated_fields import (
    CalculatedField,
    CalculatedFieldError,
    validate_calculated_fields,
)
from eolab_app.routes.browser_identity import get_browser_owner_hash
from eolab_app.routes.http_disconnect import (
    HttpClientDisconnectedError,
    run_until_http_disconnect,
)
from eolab_app.routes.vector_http import PrivateVectorRoute, vector_http_exception
from eolab_app.source_files import LeasedSourceFiles, SourceFileError
from eolab_app.vector.errors import VectorFeatureError
from eolab_app.vector.field_calculation import (
    FieldCalculationJobs,
    FieldCalculationRequest,
)
from eolab_app.vector.field_calculation_operation import (
    ArtifactCalculationSource,
    FieldCalculationInput,
    FieldCalculationResult,
    UploadedCalculationSource,
)
from eolab_app.vector_uploads import VectorUploadError


class FieldCalculationValidationRequest(BaseModel):
    """Check formulas against supplied metadata without reading a vector source.

    Attributes:
        fields: Original attribute names and types shown by the browser, excluding
            calculated fields. This advisory schema does not authorize calculation.
        calculatedFields: Complete candidate definitions in evaluation order.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    fields: dict[StrictStr, StrictStr]
    calculatedFields: Annotated[tuple[CalculatedField, ...], Field(max_length=64)]


class FieldCalculationResponse(Response):
    """Keep a long calculation's JSON response alive until completion or disconnect.

    JSON whitespace sent every fifteen seconds prevents an idle proxy timeout.
    A failure after streaming starts uses the ordinary ``detail`` JSON body with
    HTTP 200; the browser must read the complete body before accepting a result.
    """

    def __init__(
        self,
        calculate: Callable[[], Awaitable[FieldCalculationResult]],
        headers: dict[str, str],
        *,
        heartbeat_seconds: float = 15,
    ) -> None:
        """Retain the operation and browser headers without starting native work.

        Args:
            calculate: Authorized calculation retaining source leases through cleanup.
            headers: Session cookies and private-cache headers from the route.
            heartbeat_seconds: Maximum idle interval while the calculation is pending.
        """
        super().__init__(headers=headers)
        self.calculate = calculate
        self.heartbeat_seconds = heartbeat_seconds

    def _result_response(
        self, task: asyncio.Task[FieldCalculationResult]
    ) -> JSONResponse:
        """Serialize completed values or the existing safe vector error contract.

        Args:
            task: Completed calculation, including authorization and source cleanup.

        Returns:
            Validated result or a path-free error with its ordinary HTTP status.
        """
        headers = {
            key: value for key, value in self.headers.items() if key != "content-length"
        }
        try:
            result = task.result()
        except (SourceFileError, VectorUploadError) as error:
            return JSONResponse({"detail": str(error)}, error.status, headers=headers)
        except VectorFeatureError as error:
            failure = vector_http_exception(error)
            return JSONResponse(
                {"detail": failure.detail}, failure.status_code, headers=headers
            )
        return JSONResponse(result.model_dump(mode="json"), headers=headers)

    async def _chunks(
        self, task: asyncio.Task[FieldCalculationResult]
    ) -> AsyncIterator[bytes]:
        """Send only whitespace before the complete result, never partial fields.

        Args:
            task: Pending whole-source calculation.

        Yields:
            JSON whitespace heartbeats followed by the complete JSON result or error.
        """
        while not task.done():
            yield b"\n"
            await asyncio.wait((task,), timeout=self.heartbeat_seconds)
        yield self._result_response(task).body

    async def _send(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Preserve early HTTP errors, then stream while owning native cancellation.

        Args:
            scope: ASGI request metadata.
            receive: ASGI receiver, used only by an immediate JSON response.
            send: ASGI response sender.
        """
        task = asyncio.create_task(self.calculate())
        try:
            completed, _ = await asyncio.wait((task,), timeout=self.heartbeat_seconds)
            if completed:
                await self._result_response(task)(scope, receive, send)
            else:
                headers = {
                    key: value
                    for key, value in self.headers.items()
                    if key != "content-length"
                }
                headers.update(
                    {
                        "cache-control": "private, no-store, no-transform",
                        "x-accel-buffering": "no",
                    }
                )
                stream = StreamingResponse(
                    self._chunks(task), media_type="application/json", headers=headers
                )
                await stream.stream_response(send)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Cancel a disconnected request and wait for native exit before returning.

        Args:
            scope: ASGI request metadata.
            receive: ASGI request/disconnect receiver.
            send: ASGI response sender.
        """
        try:
            await run_until_http_disconnect(
                Request(scope, receive), self._send(scope, receive, send)
            )
        except HttpClientDisconnectedError:
            return


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
        Private advisory validation and calculation endpoints. Aborted calculations
        cancel native work before cleanup.
    """
    router = APIRouter(
        prefix="/api/vector-calculations",
        tags=["vector calculations"],
        route_class=PrivateVectorRoute,
    )

    @router.post("/validate", status_code=204, response_class=Response)
    async def validate_fields(body: FieldCalculationValidationRequest) -> Response:
        """Check expression syntax and field references without starting a job.

        Args:
            body: Browser-visible original metadata and complete candidate formulas.

        Returns:
            Empty success response. Calculation still checks the actual authorized
            source schema before accepting any fields.

        Raises:
            HTTPException: If a formula cannot use the supplied field metadata.
        """
        try:
            validate_calculated_fields(body.calculatedFields, body.fields)
        except CalculatedFieldError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return Response(status_code=204)

    @router.post("", response_model=FieldCalculationResult)
    async def calculate_fields(
        body: FieldCalculationRequest, request: Request, response: Response
    ) -> Response:
        """Check every feature before accepting a view's complete formula list.

        Args:
            body: Source identifiers and ordered calculated-field definitions.
            request: Same-origin credentials and connection cancellation observer.
            response: Renews the appropriate private-source cookie.

        Returns:
            Complete accepted values or a safe error; long waits send JSON whitespace.

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

        return FieldCalculationResponse(calculate, dict(response.headers))

    return router
