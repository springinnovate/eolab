"""Serve private author-owned Planning tools with cancellable source validation."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress
import logging
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.routing import APIRoute
from starlette.responses import JSONResponse

from eolab_app.planning.models import (
    MAX_REQUEST_BYTES,
    PlanningError,
    PlanningTool,
    PlanningToolDocument,
    PlanningToolSummary,
    UpdatePlanningTool,
)
from eolab_app.planning.service import PlanningToolService
from eolab_app.routes.browser_identity import get_browser_owner_hash
from eolab_app.routes.http_disconnect import (
    HttpClientDisconnectedError,
    run_until_http_disconnect,
)


class PlanningToolRoute(APIRoute):
    """Bound definition uploads and keep every Planning response private."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        """Wrap FastAPI validation with private, bounded document delivery.

        Returns:
            Handler preserving disconnect events after bounded parsing.
        """
        handler = super().get_route_handler()

        async def private(request: Request) -> Response:
            """Read a bounded definition and translate errors with private headers.

            Args:
                request: Incoming Planning API request.

            Returns:
                Private endpoint or actionable error response.
            """
            try:
                if request.method in {"POST", "PUT"}:
                    body = bytearray()
                    async for chunk in request.stream():
                        if len(body) + len(chunk) > MAX_REQUEST_BYTES:
                            raise HTTPException(
                                413, "Planning requests must fit within 516 KiB."
                            )
                        body.extend(chunk)
                    delivered = False
                    original_receive = request.receive

                    async def receive() -> dict[str, Any]:
                        """Replay the bounded body once, then forward disconnect events.

                        Returns:
                            Original body or subsequent ASGI receive message.
                        """
                        nonlocal delivered
                        if not delivered:
                            delivered = True
                            return {
                                "type": "http.request",
                                "body": bytes(body),
                                "more_body": False,
                            }
                        return await original_receive()

                    request = Request(request.scope, receive)
                response = await handler(request)
            except PlanningError as error:
                response = JSONResponse(
                    {"detail": str(error)}, status_code=error.status
                )
            except HTTPException as error:
                response = JSONResponse(
                    {"detail": error.detail},
                    status_code=error.status_code,
                    headers=error.headers,
                )
            except RequestValidationError as error:
                response = await request_validation_exception_handler(request, error)
            except (RecursionError, UnicodeError):
                response = JSONResponse(
                    {
                        "detail": "Planning JSON is too deeply nested or contains invalid text."
                    },
                    status_code=422,
                )
            response.headers["Cache-Control"] = "private, no-store"
            response.headers["X-Content-Type-Options"] = "nosniff"
            return response

        return private


def planning_author(request: Request, response: Response) -> str:
    """Read browser identity and require same-origin Planning mutations.

    Args:
        request: Browser request with the existing private identity cookie.
        response: Response renewing that cookie.

    Returns:
        Server-only browser owner hash.

    Raises:
        HTTPException: A mutation lacks its required header or comes from another origin.
    """
    return get_browser_owner_hash(request, response, mutation_header="X-EOLab-Planning")


def create_planning_tools_router(service: PlanningToolService) -> APIRouter:
    """Expose author-only tools and initialize storage independently of other APIs.

    Args:
        service: Planning source-validation and persistence owner.

    Returns:
        Router with private responses and independently retried schema setup.
    """

    @asynccontextmanager
    async def lifespan(_: Any) -> AsyncIterator[None]:
        """Retry owned schema setup without delaying unrelated application routes.

        Args:
            _: Application supplied by FastAPI.

        Yields:
            Control while endpoints serve requests.
        """

        async def initialize() -> None:
            """Retry temporary storage outages until initialized or shutdown cancels work.

            Returns:
                Once the Planning schema is ready.
            """
            while True:
                try:
                    await asyncio.to_thread(service.store.initialize_schema)
                    return
                except PlanningError:
                    logging.getLogger(__name__).warning(
                        "Planning storage unavailable; retrying in 10 seconds"
                    )
                    await asyncio.sleep(10)

        task = asyncio.create_task(initialize())
        try:
            yield
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    router = APIRouter(
        prefix="/api/planning/tools",
        tags=["planning"],
        route_class=PlanningToolRoute,
        lifespan=lifespan,
    )
    Author = Annotated[str, Depends(planning_author)]

    @router.get("", response_model=list[PlanningToolSummary])
    def list_tools(author: Author) -> list[PlanningToolSummary]:
        """List this browser author's saved Planning tools.

        Args:
            author: Server-derived owner hash.

        Returns:
            Author-only summaries without layer definitions.

        Raises:
            PlanningError: Storage is unavailable.
        """
        return service.store.list_tools(author)

    @router.get(
        "/{identifier}", response_model=PlanningTool, response_model_exclude_unset=True
    )
    def get_tool(identifier: UUID, author: Author) -> PlanningTool:
        """Return a complete tool only to its original browser author.

        Args:
            identifier: Opaque tool ID.
            author: Server-derived owner hash.

        Returns:
            Stored layer roles, intervention names and revision.

        Raises:
            PlanningError: The tool is unavailable to this author or storage failed.
        """
        return service.store.get_tool(author, identifier)

    @router.post(
        "",
        status_code=201,
        response_model=PlanningTool,
        response_model_exclude_unset=True,
    )
    async def create_tool(
        payload: PlanningToolDocument,
        request: Request,
        response: Response,
        author: Author,
    ) -> PlanningTool:
        """Validate live Catalog roles and parcel IDs before saving a new tool.

        Args:
            payload: New durable tool definition.
            request: Request whose disconnect cancels validation.
            response: Response carrying the created tool's location.
            author: Server-derived owner hash.

        Returns:
            Created author-owned definition at revision one.

        Raises:
            HTTPException: The author disconnected during validation.
            PlanningError: Source validation or storage failed.
        """
        try:
            result = await run_until_http_disconnect(
                request, service.create_tool(author, payload)
            )
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Planning tool creation cancelled") from error
        response.headers["Location"] = f"/api/planning/tools/{result.id}"
        return result

    @router.put(
        "/{identifier}", response_model=PlanningTool, response_model_exclude_unset=True
    )
    async def update_tool(
        identifier: UUID, payload: UpdatePlanningTool, request: Request, author: Author
    ) -> PlanningTool:
        """Replace this author's tool only at the last acknowledged revision.

        Args:
            identifier: Existing opaque tool ID.
            payload: Replacement definition and expected revision.
            request: Request whose disconnect cancels validation.
            author: Server-derived owner hash.

        Returns:
            Updated tool and new revision.

        Raises:
            HTTPException: The author disconnected during validation.
            PlanningError: Ownership, revision, source validation or storage failed.
        """
        try:
            return await run_until_http_disconnect(
                request, service.update_tool(author, identifier, payload)
            )
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Planning tool update cancelled") from error

    return router
