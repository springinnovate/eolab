"""Expose administrator-owned Habitat input preparation and retained reports."""

from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.responses import JSONResponse

from eolab_app.catalog_selection import SelectionUnavailableError
from eolab_app.processing.habitat_preparation_models import (
    OPERATION,
    BULK_OPERATION,
    HabitatBulkPreparationRequest,
    HabitatBulkPreparationSummary,
    HabitatInputPreparationInputs,
    HabitatInputPreparationRequest,
    PreparationRequestId,
)
from eolab_app.processing.models import (
    JobProgressResponse,
    JobResponse,
    JobResultResponse,
    ProcessingError,
)
from eolab_app.processing.service import ProcessingService
from eolab_app.routes.admin_auth import create_administrator_dependency
from eolab_app.routes.processing import JobDownloadResponse, RequestSizeLimitedRoute

PreparationJobId = Annotated[str, Path(pattern=r"^[a-f0-9]{32}$")]


class HabitatDownloadMeasurements(BaseModel):
    """Expose successful download activity independently of worker heartbeats.

    Attributes:
        cachedTiles: Reusable tiles that required no download by this attempt.
        downloadedTiles: Successfully downloaded and validated tiles in this attempt.
        failedTiles: Terminal tile failures, excluded from throughput and remaining work.
        downloadedBytes: Compressed response bytes for successful tile downloads.
        elapsedSeconds: Monotonic acquisition time measured at observedAt.
        observedAt: UTC snapshot timestamp; active rates age from this observation.
        lastDownloadAt: Last successful download time, or None before any completed.
    """

    cachedTiles: Annotated[int, Field(ge=0)]
    downloadedTiles: Annotated[int, Field(ge=0)]
    failedTiles: Annotated[int, Field(ge=0)]
    downloadedBytes: Annotated[int, Field(ge=0)]
    elapsedSeconds: Annotated[float, Field(ge=0, allow_inf_nan=False)]
    observedAt: datetime
    lastDownloadAt: datetime | None


class HabitatPreparationProgress(JobProgressResponse):
    """Report measured completed and total tiles once acquisition has planned them.

    Attributes:
        completed: Number of complete reusable tiles, including existing cache hits.
        total: Number of tiles needed for the selected polygons, or None while unknown.
        unit: Work unit supplied by the native progress producer.
        details: Acquisition measurements once cache coverage has been counted.
    """

    completed: int | None = None
    total: int | None = None
    unit: str | None = None
    details: HabitatDownloadMeasurements | None = None


class HabitatPreparationReport(JobResultResponse):
    """Describe a retained preparation report without representing current coverage.

    Attributes:
        year: Assessment year of the prepared scientific stack.
        configurationSha256: Scientific identity recorded by this preparation.
        tileCount: Number of reusable input tiles covered when this job completed.
        requiredTileCount: Number of tiles needed for the selected area and year.
        failedTileCount: Number of remote tile downloads that failed in this job.
    """

    year: int
    configurationSha256: str
    tileCount: int
    requiredTileCount: int
    failedTileCount: int


class HabitatPreparationJob(JobResponse):
    """Describe one administrator-owned preparation with separately expiring metadata.

    Attributes:
        operation: Habitat input-preparation discriminator, never a model run.
        inputs: Saved name, Catalog AOI, year and identity until metadata expiry.
        metadataExpiresAt: Saved-input expiry after completion, or None while active.
        progress: Actual work counts supplied by the existing worker.
        result: Downloadable preparation report while ordinary result retention allows.
    """

    operation: Literal["habitat.prepare-inputs.v1"] = OPERATION
    inputs: HabitatInputPreparationInputs | None
    metadataExpiresAt: datetime | None
    progress: HabitatPreparationProgress
    result: HabitatPreparationReport | None


class HabitatBulkPreparationReport(JobResultResponse):
    """Describe completed bulk checks and admissions, not finished tile downloads.

    Attributes:
        areaCount: Distinct saved areas and years checked by this bulk request.
        queuedCount: Individual preparations accepted into the ordinary queue.
        cachedCount: Areas with complete current cached tile coverage.
        activeCount: Areas skipped because a matching preparation was active.
        failedCount: Areas whose coverage check or admission failed.
    """

    areaCount: int
    queuedCount: int
    cachedCount: int
    activeCount: int
    failedCount: int


class HabitatBulkPreparationJob(JobResponse):
    """Expose a durable bulk request through the normal preparation history.

    Attributes:
        operation: Bulk retry discriminator, distinct from individual downloads.
        inputs: Captured scope size until metadata expiry; never source paths.
        metadataExpiresAt: Saved-summary expiry, or None while the job is active.
        progress: Existing worker lifecycle progress while checks run.
        result: Summary and downloadable per-area outcomes after checks finish.
    """

    operation: Literal["habitat.retry-missing-inputs.v1"] = BULK_OPERATION
    inputs: HabitatBulkPreparationSummary | None
    metadataExpiresAt: datetime | None
    progress: HabitatPreparationProgress
    result: HabitatBulkPreparationReport | None


HabitatPreparationHistoryJob = Annotated[
    HabitatPreparationJob | HabitatBulkPreparationJob, Field(discriminator="operation")
]
"""An individual download or bulk check identified by its operation."""


class HabitatPreparationList(BaseModel):
    """Return one page of administrator preparation history.

    Attributes:
        jobs: Individual and bulk jobs, newest first; excludes other operations and owners.
        nextCursor: Token for older retained jobs, or None at the end of history.
    """

    jobs: list[HabitatPreparationHistoryJob]
    nextCursor: str | None


class HabitatPreparationRetryRequest(BaseModel):
    """Identify an explicit retry command without changing the saved preparation inputs.

    Attributes:
        requestId: Stable command identifier for recovering a lost admission response.
    """

    model_config = ConfigDict(extra="forbid")
    requestId: PreparationRequestId


class HabitatPreparationRoute(RequestSizeLimitedRoute):
    """Preserve metadata-body limits and keep administration results and errors private."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        """Protect admin responses and translate the owning service's safe errors.

        Returns:
            Handler preserving authentication challenges and private error responses.
        """
        handler = super().get_route_handler()

        async def respond(request: Request) -> Response:
            """Return one preparation response with private browser-cache policy.

            Args:
                request: Incoming authenticated or rejected administration request.

            Returns:
                Operation result or sanitized source, storage and validation failure.
            """
            try:
                response = await handler(request)
            except HTTPException as error:
                response = JSONResponse(
                    {"detail": error.detail}, error.status_code, headers=error.headers
                )
            except RequestValidationError as error:
                response = await request_validation_exception_handler(request, error)
            except ProcessingError as error:
                response = JSONResponse({"detail": error.detail}, error.status)
            except SelectionUnavailableError as error:
                response = JSONResponse({"detail": error.detail}, 409)
            except ValidationError:
                response = JSONResponse(
                    {"detail": "This preparation's saved details could not be read."},
                    500,
                )
            response.headers["Cache-Control"] = "private, no-store"
            response.headers["X-Content-Type-Options"] = "nosniff"
            return response

        return respond


def create_habitat_preparation_router(
    service: ProcessingService, password: str
) -> APIRouter:
    """Expose protected preparation commands through the existing Processing service.

    Args:
        service: Existing job lifecycle owner, including its Catalog source reader.
        password: Existing administrator password; blank disables all endpoints.

    Returns:
        Admin-only router using a fixed server scope rather than browser cookies.
        Mutations require the existing same-origin administrator request header.
    """
    router = APIRouter(
        prefix="/api/admin/habitat/input-preparations",
        tags=["Ecosystem Condition input administration"],
        route_class=HabitatPreparationRoute,
        dependencies=[Depends(create_administrator_dependency(password))],
    )

    @router.post("", status_code=202, response_model=HabitatPreparationJob)
    async def submit_preparation(
        body: HabitatInputPreparationRequest,
    ) -> dict[str, object]:
        """Queue one named Catalog AOI and assessment year without running the model.

        Args:
            body: Stable submission identifier and requested preparation inputs.

        Returns:
            Accepted job, including an unchanged retry of an earlier submission.

        Raises:
            ProcessingError: If input validation, conflict detection or admission fails.
            SelectionUnavailableError: If Catalog source authorization rejects the AOI.
        """
        return await service.submit_habitat_input_preparation(body)

    @router.post(
        "/retry-all", status_code=202, response_model=HabitatBulkPreparationJob
    )
    async def submit_bulk_preparation(
        body: HabitatBulkPreparationRequest,
    ) -> dict[str, object]:
        """Accept a durable check and retry of every retained saved area and year.

        Args:
            body: Stable command identifier used to recover a lost response.

        Returns:
            Bulk job receipt. Checks and queued downloads continue after the
            browser leaves; individual outcomes appear in preparation history.

        Raises:
            ProcessingError: If recovery conflicts or durable admission fails.
            ValueError: If saved preparation metadata cannot be read.
        """
        return await service.submit_habitat_bulk_preparation(body)

    @router.get("", response_model=HabitatPreparationList)
    async def list_preparations(
        limit: int = Query(50, ge=1, le=100), cursor: str | None = Query(None)
    ) -> dict[str, object]:
        """Read one page of this site's administrator preparation history.

        Args:
            limit: Number of jobs to return, from one to 100.
            cursor: Previous continuation token, or None to start with newest jobs.

        Returns:
            Matching job statuses and a cursor for older retained entries.

        Raises:
            ProcessingError: If the cursor is invalid or job storage is unavailable.
        """
        return await service.list_habitat_input_preparations(limit, cursor)

    @router.get("/{job_id}", response_model=HabitatPreparationHistoryJob)
    async def get_preparation(job_id: PreparationJobId) -> dict[str, object]:
        """Read an individual or bulk preparation's status and report availability.

        Args:
            job_id: Preparation handle returned when the work was accepted.

        Returns:
            Current admin-owned preparation without worker paths or credentials.

        Raises:
            ProcessingError: If this preparation is unavailable to administration.
        """
        return await service.get_habitat_input_preparation(job_id)

    @router.post(
        "/{job_id}/cancel", status_code=202, response_model=HabitatPreparationHistoryJob
    )
    async def cancel_preparation(job_id: PreparationJobId) -> dict[str, object]:
        """Stop a preparation while preserving cached tiles and already queued children.

        Args:
            job_id: Preparation handle to stop through the existing worker lifecycle.

        Returns:
            Updated state, including cancelling until native work exits. Cancelling
            bulk checks leaves any individual preparations already queued intact.

        Raises:
            ProcessingError: If this preparation is unavailable or cancellation fails.
        """
        return await service.cancel_habitat_input_preparation(job_id)

    @router.post(
        "/{job_id}/retry", status_code=202, response_model=HabitatPreparationJob
    )
    async def retry_preparation(
        job_id: PreparationJobId, body: HabitatPreparationRetryRequest
    ) -> dict[str, object]:
        """Start a new attempt from saved inputs and reuse completed cached tiles.

        Args:
            job_id: Partial, failed, cancelled, interrupted or expired preparation handle.
            body: Stable retry-command identifier for lost-response recovery.

        Returns:
            Newly accepted preparation or the earlier acceptance of this command.

        Raises:
            ProcessingError: If saved inputs expired, configuration changed or admission fails.
            SelectionUnavailableError: If the original Catalog AOI is unavailable.
        """
        return await service.retry_habitat_input_preparation(job_id, body.requestId)

    @router.api_route("/{job_id}/report", methods=["GET", "HEAD"])
    async def download_report(job_id: PreparationJobId, request: Request) -> Response:
        """Download the retained preparation report with ordinary transfer protection.

        Args:
            job_id: Completed preparation handle whose report remains available.
            request: Authenticated request with an optional single byte range.

        Returns:
            Private JSON file response retaining the file until transfer completes.

        Raises:
            HTTPException: If the requested byte range is unsupported.
            ProcessingError: If the report is unavailable or expired.
        """
        byte_range = request.headers.get("range", "")
        if len(byte_range) > 128 or "," in byte_range:
            raise HTTPException(416, "Use one byte range per report download request.")
        artifact = await service.download_habitat_input_preparation(job_id)
        return JobDownloadResponse(artifact, service)

    @router.api_route("/{job_id}/provenance", methods=["GET", "HEAD"])
    async def download_provenance(job_id: PreparationJobId) -> Response:
        """Download retained preparation provenance without exposing credentials.

        Args:
            job_id: Completed preparation handle whose provenance remains available.

        Returns:
            Private provenance response with the existing renewable transfer lease.

        Raises:
            ProcessingError: If the preparation or retained provenance is unavailable.
        """
        artifact = await service.download_habitat_input_preparation(job_id, True)
        return JobDownloadResponse(artifact, service)

    return router
