"""Thin same-origin HTTP delivery for owned raster clip jobs and downloads."""

import asyncio
from contextlib import suppress
import hashlib
import re
import secrets
from collections.abc import Awaitable, Callable
from typing import Annotated, Any
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Path, Request, Response
from fastapi.routing import APIRoute
from starlette.responses import FileResponse

from eolab_app.processing.models import (
    ArtifactDownload,
    ClipPlanRequest,
    ClipSubmitRequest,
    ProcessingError,
    ClipJobResponse,
    ClipJobsResponse,
    ClipPlanResponse,
)
from eolab_app.processing.service import RasterClipService
from eolab_app.raster.errors import RasterFeatureError
from eolab_app.routes.raster_http import raster_http_exception
from eolab_app.routes.http_disconnect import (
    HttpClientDisconnectedError,
    run_until_http_disconnect,
    wait_for_http_disconnect,
)

COOKIE = "__Host-eolab-processing"
JobId = Annotated[str, Path(pattern=r"^[a-f0-9]{32}$")]
MUTATION_SCHEMA = {
    "parameters": [
        {
            "in": "header",
            "name": "X-EOLab-Processing",
            "required": True,
            "schema": {"type": "string", "enum": ["1"], "default": "1"},
        }
    ]
}


class BoundedProcessingRoute(APIRoute):
    """Bound tiny catalog/area requests before FastAPI parses their JSON."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        """Wrap request parsing with an explicit 16 KiB body ceiling.

        Returns:
            Handler retaining normal validation and disconnect semantics.
        """
        handler = super().get_route_handler()

        async def bounded(request: Request) -> Response:
            """Buffer a small POST body and reject oversized chunked bodies.

            Args:
                request: Incoming ASGI request, before JSON parsing.

            Returns:
                The normal route response after bounded input validation.

            Raises:
                HTTPException: If the processing request body exceeds 16 KiB.
            """
            if request.method != "POST":
                return await handler(request)
            body = bytearray()
            async for chunk in request.stream():
                if len(body) + len(chunk) > 16 * 1024:
                    raise HTTPException(
                        413, "Clip requests must be smaller than 16 KiB."
                    )
                body.extend(chunk)
            delivered = False

            async def receive() -> dict[str, Any]:
                """Replay the bounded body, then preserve the real disconnect channel.

                Returns:
                    One body message followed by original ASGI receive messages.
                """
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {
                        "type": "http.request",
                        "body": bytes(body),
                        "more_body": False,
                    }
                return await request.receive()

            return await handler(Request(request.scope, receive))

        return bounded


def _owner(request: Request, response: Response) -> str:
    """Mint or read an unguessable session capability without exposing it to JS.

    Args:
        request: Incoming same-origin request.
        response: Response receiving a new secure, HttpOnly cookie when needed.

    Returns:
        One-way session hash used in the job database.

    Raises:
        HTTPException: If a browser attempts a cross-origin mutation.
    """
    if request.method in {"POST", "DELETE"}:
        origin = request.headers.get("origin")
        if (
            request.headers.get("sec-fetch-site") == "cross-site"
            or (origin and urlsplit(origin).netloc != request.url.netloc)
            or request.headers.get("x-eolab-processing") != "1"
        ):
            raise HTTPException(
                403, "Use a same-origin processing request with X-EOLab-Processing: 1."
            )
    token = request.cookies.get(COOKIE, "")
    if not re.fullmatch(r"[a-f0-9]{64}", token):
        token = secrets.token_hex(32)
        response.set_cookie(
            COOKIE,
            token,
            max_age=7 * 86_400,
            secure=True,
            httponly=True,
            samesite="lax",
            path="/",
        )
    response.headers["Cache-Control"] = "private, no-store"
    return hashlib.sha256(token.encode()).hexdigest()


async def _result(awaitable: Any) -> Any:
    """Translate only owned sanitized errors into HTTP responses.

    Args:
        awaitable: Application operation already supplied with validated input.

    Returns:
        Public application result.

    Raises:
        HTTPException: For known processing or catalog authorization failures.
    """
    try:
        return await awaitable
    except ProcessingError as error:
        raise HTTPException(
            error.status,
            {"code": error.code, "message": error.detail},
            headers={"Retry-After": "5"} if error.status in {429, 503} else None,
        ) from error
    except RasterFeatureError as error:
        raise raster_http_exception(error) from error
    except HttpClientDisconnectedError as error:
        raise HTTPException(499, "The clip planning request was cancelled") from error


class LeasedClipResponse(FileResponse):
    """Range-capable file delivery that keeps expiry cleanup away from transfers."""

    def __init__(
        self, artifact: ArtifactDownload, service: RasterClipService, provenance: bool
    ) -> None:
        """Configure an immutable result response after owner authorization.

        Args:
            artifact: Confined file and transfer capability.
            service: Owner of the transfer lifecycle.
            provenance: Select JSON content type rather than GeoTIFF.
        """
        super().__init__(
            artifact.path,
            filename=artifact.filename,
            media_type="application/json" if provenance else "image/tiff",
            headers={
                "ETag": f'"{artifact.sha256}"',
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
            },
        )
        self.lease = artifact.lease_id
        self.service = service

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        """Send bounded chunks/ranges and stop on disconnection or lease loss.

        Args:
            scope: ASGI response scope.
            receive: ASGI disconnection receiver.
            send: ASGI response sender.

        Raises:
            RuntimeError: If the transfer can no longer retain its artifact.
        """

        async def renew() -> None:
            """Renew only while a live response consumes its owned file."""
            while True:
                await asyncio.sleep(30)
                if not await self.service.transfer_heartbeat(self.lease):
                    raise RuntimeError("Clip transfer lease expired")

        # Keep file transfer completion inside this response's lifetime rather
        # than delegating it to an ASGI path-send extension after returning.
        scope = {
            **scope,
            "extensions": {
                name: value
                for name, value in scope.get("extensions", {}).items()
                if name != "http.response.pathsend"
            },
        }
        response = asyncio.create_task(super().__call__(scope, receive, send))
        heartbeat = asyncio.create_task(renew())
        disconnect = asyncio.create_task(
            wait_for_http_disconnect(Request(scope, receive))
        )
        tasks = (response, heartbeat, disconnect)
        try:
            async with asyncio.timeout(3600):
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            with suppress(ProcessingError):
                await self.service.transfer_heartbeat(self.lease, release=True)


def create_processing_router(service: RasterClipService) -> APIRouter:
    """Expose clip operations without embedding native work in request handlers.

    Args:
        service: Composed processing application owner.

    Returns:
        Router independent of map visibility, publication, and histogram state.
    """
    router = APIRouter(
        prefix="/api/processing",
        tags=["processing"],
        route_class=BoundedProcessingRoute,
    )

    @router.post(
        "/raster-clips/plan",
        response_model=ClipPlanResponse,
        openapi_extra=MUTATION_SCHEMA,
    )
    async def plan(
        body: ClipPlanRequest, request: Request, response: Response
    ) -> dict[str, Any]:
        """Plan a bounded native clip from a catalog source and explicit area.

        Args:
            body: Validated source and area request.
            request: HTTP owner and origin context.
            response: Cookie and cache-control response.

        Returns:
            Reviewable expiring clip plan.
        """
        return await _result(
            run_until_http_disconnect(
                request, service.plan(_owner(request, response), body)
            )
        )

    @router.post(
        "/raster-clips",
        status_code=202,
        response_model=ClipJobResponse,
        openapi_extra=MUTATION_SCHEMA,
    )
    async def submit(
        body: ClipSubmitRequest, request: Request, response: Response
    ) -> dict[str, Any]:
        """Accept one reviewed plan with idempotent durable queue admission.

        Args:
            body: Plan ID and client request key.
            request: HTTP owner/origin context.
            response: Response cookie and headers.

        Returns:
            Accepted public job, recoverable after the browser disconnects.
        """
        job = await _result(service.submit(_owner(request, response), body))
        response.headers["Location"] = f"/api/processing/jobs/{job['jobId']}"
        return job

    @router.get("/jobs", response_model=ClipJobsResponse)
    async def jobs(request: Request, response: Response) -> dict[str, Any]:
        """Recover the current session's recent jobs and establish its cookie.

        Args:
            request: Current browser session context.
            response: Secure owner-cookie response.

        Returns:
            Bounded owned job summaries.
        """
        return {"jobs": await _result(service.list_owned(_owner(request, response)))}

    @router.get("/jobs/{job_id}", response_model=ClipJobResponse)
    async def get(
        job_id: JobId, request: Request, response: Response
    ) -> dict[str, Any]:
        """Read one owned job's progress and result availability.

        Args:
            job_id: Strict opaque job ID.
            request: Current browser session.
            response: Private cache policy response.

        Returns:
            Public job state.
        """
        return await _result(service.get(_owner(request, response), job_id))

    @router.post(
        "/jobs/{job_id}/cancel",
        status_code=202,
        response_model=ClipJobResponse,
        openapi_extra=MUTATION_SCHEMA,
    )
    async def cancel(
        job_id: JobId, request: Request, response: Response
    ) -> dict[str, Any]:
        """Request cancellation without releasing active native-work capacity.

        Args:
            job_id: Strict owned job ID.
            request: Current owner/origin context.
            response: Private response metadata.

        Returns:
            Updated job; cancellation completes only after child exit.
        """
        return await _result(service.cancel(_owner(request, response), job_id))

    @router.delete(
        "/jobs/{job_id}", response_model=ClipJobResponse, openapi_extra=MUTATION_SCHEMA
    )
    async def delete(
        job_id: JobId, request: Request, response: Response
    ) -> dict[str, Any]:
        """Revoke a terminal clip result and schedule safe artifact cleanup.

        Args:
            job_id: Strict owned terminal job ID.
            request: Current owner/origin context.
            response: Private response metadata.

        Returns:
            Deleted public job state.
        """
        return await _result(
            service.cancel(_owner(request, response), job_id, delete=True)
        )

    @router.api_route("/jobs/{job_id}/result", methods=["GET", "HEAD"])
    async def result(job_id: JobId, request: Request, response: Response) -> Response:
        """Download an owned immutable GeoTIFF using standard HTTP ranges.

        Args:
            job_id: Strict owned job ID.
            request: Current owner capability and Range headers.
            response: Owner-cookie context.

        Returns:
            Streaming attachment retaining a renewable transfer lease.
        """
        range_header = request.headers.get("range", "")
        if len(range_header) > 128 or "," in range_header:
            raise HTTPException(416, "Use one byte range per clip download request.")
        artifact = await _result(service.download(_owner(request, response), job_id))
        return LeasedClipResponse(artifact, service, False)

    @router.get("/jobs/{job_id}/provenance")
    async def provenance(
        job_id: JobId, request: Request, response: Response
    ) -> Response:
        """Download the owned clip's path-free provenance and checksum.

        Args:
            job_id: Strict owned job ID.
            request: Current owner capability.
            response: Owner-cookie context.

        Returns:
            Immutable provenance JSON attachment.
        """
        artifact = await _result(
            service.download(_owner(request, response), job_id, provenance=True)
        )
        return LeasedClipResponse(artifact, service, True)

    return router
