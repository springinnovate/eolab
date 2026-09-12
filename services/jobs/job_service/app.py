"""Authenticated HTTP boundary for bounded, ephemeral diagnostic jobs."""

import hashlib
import hmac
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator
from typing import Annotated
from uuid import UUID

from fastapi import Depends, FastAPI, Header, Query, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from job_service.configuration import Settings, load_settings
from job_service.manager import JobError, JobManager
from job_service.operations_registry import OPERATIONS
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException
from starlette.middleware.base import RequestResponseEndpoint
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from job_service.models import (
    API_VERSION,
    ErrorResponse,
    Health,
    JobPage,
    JobResult,
    JobSnapshot,
    JobStatus,
    Operations,
    SubmitJob,
    UpdateJob,
)

PREFIX = "/api/jobs"
MAX_REQUEST_BYTES = 65536


def error_response(status: int, code: str, message: str) -> JSONResponse:
    """Build the public error envelope without including submitted inputs.

    Args:
        status: HTTP status code.
        code: Stable machine-readable error code.
        message: Safe explanation for the caller.

    Returns:
        A JSON error response with caching disabled.
    """
    return JSONResponse(
        {"error": {"code": code, "message": message}},
        status_code=status,
        headers={"Cache-Control": "no-store"},
    )


class RequestSizeLimit:
    """Bound incoming bodies before JSON decoding, including chunked requests."""

    def __init__(self, app: ASGIApp) -> None:
        """Wrap the application.

        Args:
            app: Downstream ASGI application.
        """
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Admit a bounded HTTP body or return 413 without invoking handlers.

        Args:
            scope: ASGI connection metadata.
            receive: Incoming message receiver.
            send: Outgoing response sender.
        """
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            if len(body) + len(chunk) > MAX_REQUEST_BYTES:
                await error_response(
                    413, "request_too_large", "Request exceeds 65536 bytes."
                )(scope, receive, send)
                return
            body.extend(chunk)
            if not message.get("more_body", False):
                break
        delivered = False

        async def replay() -> Message:
            """Deliver the admitted body once, then preserve disconnect events.

            Returns:
                The buffered request or a subsequent ASGI message.
            """
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


def create_app(settings: Settings | None = None) -> FastAPI:
    """Create the single-process service with a lifespan-owned execution manager.

    Args:
        settings: Optional already-validated configuration for an embedded host
            or isolated test. When supplied, environment loading is skipped.
            Uvicorn's no-argument factory path loads the environment once.

    Returns:
        HTTP app with bounded ephemeral job execution and public discovery/docs.

    Raises:
        ValueError: For invalid deployment configuration.
    """
    configuration = settings if settings is not None else load_settings()
    manager = JobManager(configuration)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        """Own admission and subprocess cleanup for this application instance.

        Args:
            app: Hosting ASGI application.

        Yields:
            Control while the manager is running.
        """
        await manager.start()
        try:
            yield
        finally:
            await manager.close()

    app = FastAPI(
        title="Job service",
        version=API_VERSION,
        lifespan=lifespan,
        description="One execution lane with a bounded priority queue. Jobs and results are "
        "in memory and lost on restart. Use Authorize with a configured caller bearer token. "
        "diagnostic.v1 supports normal, delay and exception modes. SSE and artifacts remain unavailable.",
        docs_url=f"{PREFIX}/docs",
        openapi_url=f"{PREFIX}/openapi.json",
        redoc_url=None,
        swagger_ui_oauth2_redirect_url=None,
    )
    app.add_middleware(RequestSizeLimit)
    bearer = HTTPBearer(auto_error=False)

    async def authenticate(
        credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    ) -> str:
        """Resolve a deployment-configured owner, never a submitted identity.

        Args:
            credentials: Parsed bearer header.

        Returns:
            Trusted stable caller name.

        Raises:
            HTTPException: If credentials are absent, invalid or unconfigured.
        """
        if not configuration.callers:
            raise HTTPException(503, "Job callers are not configured")
        if credentials is not None and len(credentials.credentials) <= 256:
            digest = hashlib.sha256(credentials.credentials.encode()).hexdigest()
            for owner, expected in configuration.callers.items():
                if hmac.compare_digest(digest, expected):
                    return owner
        raise HTTPException(
            401,
            "Valid Job service bearer credentials required",
            headers={"WWW-Authenticate": "Bearer"},
        )

    Owner = Annotated[str, Depends(authenticate)]

    @app.exception_handler(JobError)
    async def job_error(request: Request, exc: JobError) -> JSONResponse:
        """Translate domain errors without exposing internal records.

        Args:
            request: Incoming request.
            exc: Safe lifecycle error.

        Returns:
            Structured HTTP failure, including retry advice for full capacity.
        """
        status = {
            "not_found": 404,
            "conflict": 409,
            "capacity": 503,
            "invalid_request": 422,
        }[exc.code]
        response = error_response(status, exc.code, str(exc))
        if status == 503:
            response.headers["Retry-After"] = "1"
        return response

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException) -> JSONResponse:
        """Normalize routing, authorization and unsupported-hook errors.

        Args:
            request: Incoming request.
            exc: HTTP boundary failure.

        Returns:
            Safe error envelope with protocol headers preserved.
        """
        codes = {
            501: "not_implemented",
            404: "not_found",
            405: "method_not_allowed",
            401: "unauthorized",
            503: "unavailable",
        }
        response = error_response(
            exc.status_code,
            codes.get(exc.status_code, "request_failed"),
            str(exc.detail),
        )
        response.headers.update(exc.headers or {})
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_request(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        """Report invalid fields without reflecting submitted values.

        Args:
            request: Incoming request.
            exc: Request validation error.

        Returns:
            422 error identifying at most eight fields.
        """
        fields = ", ".join(
            ".".join(map(str, error["loc"])) for error in exc.errors()[:8]
        )
        return error_response(
            422, "invalid_request", f"Invalid request fields: {fields}"
        )

    @app.middleware("http")
    async def no_cache(
        request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        """Prevent caching owner-scoped state and responses.

        Args:
            request: Incoming request.
            call_next: Starlette's downstream HTTP dispatcher.

        Returns:
            Response with no-store caching policy.
        """
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get(f"{PREFIX}/health", response_model=Health)
    async def health() -> Health:
        """Report readiness and configured admission.

        Returns:
            Ephemeral mode and current ability to accept authenticated jobs.
        """
        return Health(acceptsJobs=bool(configuration.callers) and manager.accepting)

    @app.get(f"{PREFIX}/operations", response_model=Operations)
    async def operations() -> Operations:
        """Discover code-installed operation schemas.

        Returns:
            Registered operation descriptions.
        """
        return Operations(
            operations=[operation.describe() for operation in OPERATIONS.values()]
        )

    errors = {code: {"model": ErrorResponse} for code in (401, 404, 409, 413, 422, 503)}

    @app.post(PREFIX, response_model=JobSnapshot, status_code=202, responses=errors)
    async def submit(
        payload: SubmitJob,
        owner: Owner,
        response: Response,
        idempotency_key: Annotated[
            str,
            Header(
                alias="Idempotency-Key",
                min_length=1,
                max_length=128,
                pattern=r"^[A-Za-z0-9._:-]+$",
            ),
        ],
    ) -> JobSnapshot:
        """Admit a job; repeated keys return the original retained job.

        Args:
            payload: Immutable invocation and timeout/priority settings.
            owner: Authenticated caller.
            response: Response used to publish the status Location.
            idempotency_key: Caller-scoped retry identity.

        Returns:
            Current admitted job snapshot, possibly terminal on a retry.

        Raises:
            JobError: For invalid operation, conflict or exhausted capacity.
        """
        snapshot = manager.submit(owner, idempotency_key, payload)
        response.headers["Location"] = f"{PREFIX}/{snapshot.jobId}"
        return snapshot

    @app.get(PREFIX, response_model=JobPage, responses=errors)
    async def list_jobs(
        owner: Owner,
        status: JobStatus | None = None,
        limit: Annotated[int, Query(ge=1, le=100)] = 20,
        cursor: Annotated[str | None, Query(min_length=1, max_length=512)] = None,
    ) -> JobPage:
        """List only the authenticated caller's retained jobs.

        Args:
            owner: Authenticated caller.
            status: Optional current-state filter.
            limit: Maximum page length.
            cursor: Retained last-seen job identity from the preceding page.

        Returns:
            Bounded admission-order page.

        Raises:
            JobError: For an invalid or expired cursor.
        """
        return manager.list(owner, status, limit, cursor)

    @app.get(f"{PREFIX}/{{job_id}}", response_model=JobSnapshot, responses=errors)
    async def get_job(job_id: UUID, owner: Owner) -> JobSnapshot:
        """Read authoritative owned status.

        Args:
            job_id: Job identity.
            owner: Authenticated caller.

        Returns:
            Current snapshot.

        Raises:
            JobError: If the owned job is unavailable.
        """
        return manager.get(owner, job_id)

    @app.patch(f"{PREFIX}/{{job_id}}", response_model=JobSnapshot, responses=errors)
    async def update_job(job_id: UUID, payload: UpdateJob, owner: Owner) -> JobSnapshot:
        """Change queued priority without preempting running work.

        Args:
            job_id: Job identity.
            payload: New priority.
            owner: Authenticated caller.

        Returns:
            Updated snapshot.

        Raises:
            JobError: If unavailable or no longer queued.
        """
        return manager.update(owner, job_id, payload.priority)

    @app.post(
        f"{PREFIX}/{{job_id}}/cancel", response_model=JobSnapshot, responses=errors
    )
    async def cancel_job(job_id: UUID, owner: Owner) -> JobSnapshot:
        """Cancel queued work or request hard stopping of the running child.

        Args:
            job_id: Job identity.
            owner: Authenticated caller.

        Returns:
            Current state; cancelling becomes cancelled after child cleanup.

        Raises:
            JobError: If the owned job is unavailable.
        """
        return manager.cancel(owner, job_id)

    @app.get(f"{PREFIX}/{{job_id}}/result", response_model=JobResult, responses=errors)
    async def result(job_id: UUID, owner: Owner) -> JobResult:
        """Retrieve owned successful output.

        Args:
            job_id: Job identity.
            owner: Authenticated caller.

        Returns:
            Retained inline JSON result.

        Raises:
            JobError: If unavailable or not succeeded.
        """
        return manager.result(owner, job_id)

    @app.delete(f"{PREFIX}/{{job_id}}", status_code=204, responses=errors)
    async def delete_job(job_id: UUID, owner: Owner) -> Response:
        """Delete terminal state, result and its idempotency reservation.

        Args:
            job_id: Job identity.
            owner: Authenticated caller.

        Returns:
            Empty 204 response.

        Raises:
            JobError: If unavailable or still active.
        """
        manager.delete(owner, job_id)
        return Response(status_code=204)

    @app.get(
        f"{PREFIX}/{{job_id}}/events",
        responses={**errors, 501: {"model": ErrorResponse}},
    )
    async def events(job_id: UUID, owner: Owner) -> None:
        """Reserve SSE for later; callers can poll authoritative status.

        Args:
            job_id: Job identity.
            owner: Authenticated caller.

        Raises:
            JobError: If the owned job is unavailable.
            HTTPException: 501 for an owned job; no stream is opened.
        """
        manager.get(owner, job_id)
        raise HTTPException(501, "Job events are not implemented; poll job status")

    @app.get(
        f"{PREFIX}/{{job_id}}/artifacts/{{artifact_id}}",
        responses={**errors, 501: {"model": ErrorResponse}},
    )
    async def artifact(job_id: UUID, artifact_id: UUID, owner: Owner) -> None:
        """Reserve file results for a later operation migration.

        Args:
            job_id: Job identity.
            artifact_id: Reserved artifact identity.
            owner: Authenticated caller.

        Raises:
            JobError: If the owned job is unavailable.
            HTTPException: 501; diagnostics produce no artifacts.
        """
        manager.get(owner, job_id)
        raise HTTPException(501, "Artifact downloads are not implemented")

    return app
