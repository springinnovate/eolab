"""Create and retrieve named maps without coupling storage to catalog or rendering."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress
import logging
from typing import Annotated, Any
from urllib.parse import urlsplit

from fastapi import APIRouter, Header, HTTPException, Request, Response
from fastapi.routing import APIRoute
from starlette.responses import JSONResponse

from eolab_app.saved_maps.models import (
    CreateSavedMap,
    MAX_REQUEST_BYTES,
    SavedMap,
    SavedMapError,
    Slug,
)
from eolab_app.saved_maps.store import SavedMapStore


class SavedMapRoute(APIRoute):
    """Bound uploads before JSON parsing and return safe storage errors."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        """Wrap FastAPI validation with a body limit and no-cache responses.

        Returns:
            Handler for a saved-map endpoint.
        """
        handler = super().get_route_handler()

        async def bounded(request: Request) -> Response:
            """Reject oversized uploads and translate saved-map storage failures.

            Args:
                request: Incoming HTTP request.

            Returns:
                Endpoint response or safe JSON error.

            Raises:
                HTTPException: If the upload is larger than the request limit.
            """
            if request.method == "POST":
                body = bytearray()
                async for chunk in request.stream():
                    if len(body) + len(chunk) > MAX_REQUEST_BYTES:
                        raise HTTPException(
                            413, "Saved-map requests must fit within 516 KiB."
                        )
                    body.extend(chunk)
                delivered = False
                original_receive = request.receive

                async def receive() -> dict[str, Any]:
                    """Replay the size-checked body once, then forward disconnect events.

                    Returns:
                        ASGI request or disconnect message.
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
            try:
                response = await handler(request)
            except SavedMapError as error:
                response = JSONResponse(
                    {"detail": str(error)}, status_code=error.status
                )
            except (RecursionError, UnicodeError):
                response = JSONResponse(
                    {
                        "detail": "Map JSON is too deeply nested or contains invalid text."
                    },
                    status_code=422,
                )
            response.headers["Cache-Control"] = "no-store"
            response.headers["X-Content-Type-Options"] = "nosniff"
            return response

        return bounded


def create_saved_maps_router(store: SavedMapStore) -> APIRouter:
    """Register named-map endpoints and retry schema setup without blocking other APIs.

    Args:
        store: PostgreSQL persistence owned by saved maps.

    Returns:
        Router with independently initialized storage.
    """

    @asynccontextmanager
    async def lifespan(_: Any) -> AsyncIterator[None]:
        """Keep storage initialization alive until it succeeds or the app stops.

        Args:
            _: Application supplied by FastAPI.

        Yields:
            Control while the router serves requests.
        """

        async def initialize_storage() -> None:
            """Retry schema setup after database outages.

            Returns:
                When storage is ready; cancellation stops retries at shutdown.
            """
            while True:
                try:
                    await asyncio.to_thread(store.initialize_schema)
                    return
                except SavedMapError:
                    logging.getLogger(__name__).warning(
                        "Saved-map storage unavailable; retrying in 10 seconds"
                    )
                    await asyncio.sleep(10)

        task = asyncio.create_task(initialize_storage())
        try:
            yield
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    router = APIRouter(
        prefix="/api/saved-maps",
        tags=["saved maps"],
        route_class=SavedMapRoute,
        lifespan=lifespan,
        responses={
            503: {
                "description": "Saved-map storage is unavailable or site capacity is full."
            }
        },
    )

    @router.post(
        "",
        status_code=201,
        response_model=SavedMap,
        response_model_exclude_unset=True,
        responses={
            403: {"description": "Browser request came from another origin."},
            409: {"description": "The map link name is already in use."},
            413: {"description": "The request exceeds 516 KiB."},
        },
    )
    def create_saved_map(
        payload: CreateSavedMap,
        request: Request,
        response: Response,
        x_eolab_saved_maps: Annotated[str, Header(pattern="^1$")],
    ) -> SavedMap:
        """Save an immutable named map. Anyone with the link can read it.

        Args:
            payload: Title, unique URL name and existing saved-map JSON.
            request: Request used to reject browser cross-origin writes.
            response: Response carrying the created record's API location.
            x_eolab_saved_maps: Must be 1; a browser preflight safeguard, not a credential.

        Returns:
            Created map. Reusing a URL name never overwrites its contents.

        Raises:
            HTTPException: If a browser submits from another origin.
            SavedMapError: If the name is taken, capacity is full or storage fails.
        """
        origin = request.headers.get("origin")
        if request.headers.get("sec-fetch-site") == "cross-site" or (
            origin and urlsplit(origin).netloc != request.url.netloc
        ):
            raise HTTPException(403, "Create saved maps from this site.")
        result = store.create_saved_map(payload)
        response.headers["Location"] = f"/api/saved-maps/{result.slug}"
        return result

    @router.get(
        "/{slug}",
        response_model=SavedMap,
        response_model_exclude_unset=True,
        responses={404: {"description": "No saved map has this URL name."}},
    )
    def get_saved_map(slug: Slug) -> SavedMap:
        """Retrieve a saved map without opening its layers or changing it.

        Args:
            slug: Map's lowercase URL name.

        Returns:
            Stored configuration and creation time.

        Raises:
            SavedMapError: If the map is absent or storage fails.
        """
        return store.get_saved_map(slug)

    return router
