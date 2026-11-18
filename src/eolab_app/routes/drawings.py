"""Serve reusable drawing sources with private ownership and opaque read links."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress
import logging
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from starlette.responses import JSONResponse

from eolab_app.drawings.models import (
    MAX_REQUEST_BYTES,
    CreateDrawingLayer,
    DrawingError,
    DrawingLayer,
    DrawingLayerSummary,
    UpdateDrawingLayer,
)
from eolab_app.drawings.store import DrawingLayerStore
from eolab_app.routes.browser_identity import get_browser_owner_hash


class DrawingRoute(APIRoute):
    """Bound source uploads and keep success and validation responses uncacheable."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        """Read bounded drawing requests and translate expected boundary errors.

        Returns:
            Handler preserving FastAPI validation and original disconnect events.
        """
        handler = super().get_route_handler()

        async def private(request: Request) -> Response:
            """Deliver source data and errors without caching browser permissions.

            Args:
                request: Incoming drawing API request.

            Returns:
                Private source response or actionable boundary error.
            """
            try:
                if request.method in {"POST", "PUT"}:
                    body = bytearray()
                    async for chunk in request.stream():
                        if len(body) + len(chunk) > MAX_REQUEST_BYTES:
                            raise HTTPException(
                                413,
                                "Drawing requests must fit within 8 MiB plus 4 KiB.",
                            )
                        body.extend(chunk)
                    delivered = False
                    original_receive = request.receive

                    async def receive() -> dict[str, Any]:
                        """Replay the bounded body once, then retain disconnect messages.

                        Returns:
                            Buffered body or the original subsequent ASGI message.
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
            except DrawingError as error:
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
                        "detail": "Drawing JSON is too deeply nested or contains invalid text."
                    },
                    status_code=422,
                )
            response.headers["Cache-Control"] = "private, no-store"
            response.headers["X-Content-Type-Options"] = "nosniff"
            return response

        return private


def drawing_browser_owner(request: Request, response: Response) -> str:
    """Read browser identity and require same-origin source mutations.

    Args:
        request: Browser request using the ordinary private owner cookie.
        response: Response renewing that cookie.

    Returns:
        Server-only owner hash, never returned as source metadata.

    Raises:
        HTTPException: A mutation is cross-site or lacks X-EOLab-Drawings: 1.
    """
    return get_browser_owner_hash(request, response, mutation_header="X-EOLab-Drawings")


def create_drawings_router(store: DrawingLayerStore) -> APIRouter:
    """Expose source creation, revision-checked writes and read-only linked access.

    Args:
        store: Durable drawing-source owner, independent of Planning and rendering.

    Returns:
        Drawing router with independent schema initialization and browser ownership.
    """

    @asynccontextmanager
    async def lifespan(_: Any) -> AsyncIterator[None]:
        """Initialize source storage without delaying unrelated application routes.

        Args:
            _: Application supplied by FastAPI.

        Yields:
            Control while source endpoints serve requests.
        """

        async def initialize() -> None:
            """Retry unavailable source storage until initialized or shutdown.

            Returns:
                Once drawing-source tables are available.
            """
            while True:
                try:
                    await asyncio.to_thread(store.initialize_schema)
                    return
                except DrawingError:
                    logging.getLogger(__name__).warning(
                        "Drawing storage unavailable; retrying in 10 seconds"
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
        prefix="/api/drawings",
        tags=["drawings"],
        route_class=DrawingRoute,
        lifespan=lifespan,
    )
    Owner = Annotated[str, Depends(drawing_browser_owner)]

    @router.get("", response_model=list[DrawingLayerSummary])
    def list_layers(owner: Owner) -> list[DrawingLayerSummary]:
        """List only the current browser's linked sources for reopening.

        Args:
            owner: Server-derived browser identity.

        Returns:
            Owned source summaries without geometry.

        Raises:
            DrawingError: Storage is unavailable.
        """
        return store.list_layers(owner)

    @router.post("", status_code=201, response_model=DrawingLayer)
    def create_layer(
        payload: CreateDrawingLayer, response: Response, owner: Owner
    ) -> DrawingLayer:
        """Create a source or acknowledge an identical retry without replacing data.

        Args:
            payload: Local layer identity and full committed collection.
            response: Response receiving the durable source location.
            owner: Server-derived browser identity.

        Returns:
            Original source identity, current revision and owner write permission.

        Raises:
            DrawingError: The local ID already has different data or storage failed.
        """
        result = store.create_layer(owner, payload)
        response.headers["Location"] = f"/api/drawings/{result.id}"
        return result

    @router.get("/{identifier}", response_model=DrawingLayer)
    def read_layer(identifier: UUID, owner: Owner) -> DrawingLayer:
        """Read a linked drawing without granting another browser permission to edit.

        Args:
            identifier: Opaque source ID retained by the caller's view or tool.
            owner: Browser identity used to derive canEdit.

        Returns:
            Current source data and caller-specific write permission.

        Raises:
            DrawingError: The source is missing or storage is unavailable.
        """
        return store.read_layer(identifier, owner)

    @router.put("/{identifier}", response_model=DrawingLayer)
    def update_layer(
        identifier: UUID, payload: UpdateDrawingLayer, owner: Owner
    ) -> DrawingLayer:
        """Save source edits only for the owner at the acknowledged revision.

        Args:
            identifier: Durable source ID.
            payload: Expected revision and full replacement collection.
            owner: Server-derived browser identity.

        Returns:
            Updated collection and incremented revision.

        Raises:
            DrawingError: Ownership, revision or storage prevents editing.
        """
        return store.update_layer(owner, identifier, payload)

    return router
