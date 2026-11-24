"""Publish and edit named maps without coupling storage to catalog or rendering."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress
import logging
import re
from typing import Annotated, Any
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.routing import APIRoute
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.responses import JSONResponse

from eolab_app.map_layer_documents import MapDrawingLayer
from eolab_app.saved_maps.models import (
    CreateSavedMap,
    INVALID_MAP_EDIT_LINK,
    MapAnnotationLayer,
    MapUploadLayer,
    MapVectorArtifactLayer,
    MAX_REQUEST_BYTES,
    PublishedMapSummary,
    PublishedSavedMap,
    SavedMap,
    SavedMapEditToken,
    SavedMapError,
    Slug,
    UpdateSavedMap,
)
from eolab_app.saved_maps.store import SavedMapStore
from eolab_app.routes.admin_auth import create_administrator_dependency


def require_map_edit_token(
    credentials: Annotated[
        HTTPAuthorizationCredentials | None, Depends(HTTPBearer(auto_error=False))
    ],
) -> str:
    """Read the private map edit credential from the Authorization header.

    Args:
        credentials: Bearer credentials supplied by the private editor.

    Returns:
        The well-formed token to check against this map in storage.

    Raises:
        SavedMapError: If the token is absent or malformed.
    """
    if credentials is None or not re.fullmatch(
        r"[0-9a-f]{64}", credentials.credentials
    ):
        raise SavedMapError(403, INVALID_MAP_EDIT_LINK)
    return credentials.credentials


def require_same_site_map_write(request: Request, message: str) -> None:
    """Reject a saved-map write initiated by a different site.

    Args:
        request: Incoming publication or private edit request.
        message: User-facing instruction if the request is cross-site.

    Raises:
        HTTPException: If the request came from another site.
    """
    origin = request.headers.get("origin")
    if request.headers.get("sec-fetch-site") == "cross-site" or (
        origin and urlsplit(origin).netloc != request.url.netloc
    ):
        raise HTTPException(403, message)


def validate_site_local_layers(payload: CreateSavedMap, request: Request) -> None:
    """Keep site-local layer references tied to the site that owns them.

    Args:
        payload: Map document to publish or save.
        request: HTTP request identifying the site.

    Raises:
        HTTPException: If a local layer reference belongs to another site.
    """
    if any(
        isinstance(
            layer,
            (
                MapAnnotationLayer,
                MapDrawingLayer,
                MapUploadLayer,
                MapVectorArtifactLayer,
            ),
        )
        for layer in payload.view.layers
    ) and (urlsplit(payload.view.viewer.origin).netloc != request.url.netloc):
        raise HTTPException(
            422,
            "Saved drawings, shared layers, uploads and run results must belong to this EOLab site.",
        )


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
            if request.method in {"POST", "PUT"}:
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
            except HTTPException as error:
                response = JSONResponse(
                    {"detail": error.detail}, error.status_code, headers=error.headers
                )
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
        response_model=PublishedSavedMap,
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
    ) -> PublishedSavedMap:
        """Publish a new named map. Anyone with the link can read it.

        Args:
            payload: Title, unique URL name and existing saved-map JSON.
            request: Request used to reject browser cross-origin writes.
            response: Response carrying the created record's API location.
            x_eolab_saved_maps: Must be 1; a browser preflight safeguard, not a credential.

        Returns:
            Created map and its private edit token. Reusing a URL name never
            overwrites its contents or returns the existing token.

        Raises:
            HTTPException: If a browser submits from another origin or a site-local
                layer reference belongs to another site.
            SavedMapError: If the name is taken, capacity is full or storage fails.
        """
        require_same_site_map_write(request, "Create saved maps from this site.")
        validate_site_local_layers(payload, request)
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

    @router.get(
        "/{slug}/edit", response_model=SavedMap, response_model_exclude_unset=True
    )
    def load_private_map_editor(
        slug: Slug, edit_token: Annotated[str, Depends(require_map_edit_token)]
    ) -> SavedMap:
        """Load the current map revision for the holder of its private edit link.

        Args:
            slug: Fixed URL name of the published map.
            edit_token: Bearer token supplied by the private edit link.

        Returns:
            Current map and revision, without any edit or contribution credentials.

        Raises:
            SavedMapError: If the link is inactive or storage is unavailable.
        """
        return store.get_saved_map(slug, edit_token=edit_token)

    @router.put(
        "/{slug}/edit", response_model=SavedMap, response_model_exclude_unset=True
    )
    def save_private_map_changes(
        slug: Slug,
        payload: UpdateSavedMap,
        request: Request,
        edit_token: Annotated[str, Depends(require_map_edit_token)],
    ) -> SavedMap:
        """Save changes to one map using its private edit link and current revision.

        Args:
            slug: Existing map's fixed URL name.
            payload: Replacement configuration and revision opened for editing.
            request: Origin used to check the write and any site-local layer references.
            edit_token: Bearer token supplied by the private edit link.

        Returns:
            Updated map and revision at the same public URL.

        Raises:
            HTTPException: If the write or site-local layers belong to another site.
            SavedMapError: If the link is inactive, the name or revision changed,
                or storage is unavailable.
        """
        require_same_site_map_write(request, "Save map changes from this site.")
        validate_site_local_layers(payload, request)
        return store.update_saved_map(slug, payload, edit_token=edit_token)

    return router


def create_saved_maps_admin_router(store: SavedMapStore, password: str) -> APIRouter:
    """Expose administrator editing, edit-link management and reversible deletion.

    Args:
        store: Saved-map storage initialized by the existing public router.
        password: Configured admin password; empty disables administration.

    Returns:
        Size-bounded administration API, independent of catalog and shared polygons.
    """
    router = APIRouter(
        prefix="/api/admin/saved-maps",
        route_class=SavedMapRoute,
        dependencies=[Depends(create_administrator_dependency(password))],
        tags=["Published map administration"],
    )

    @router.get("")
    def list_maps() -> list[PublishedMapSummary]:
        """List active and deleted published maps for the admin page.

        Returns:
            Map titles, URL names, deletion times and whether an edit link exists.

        Raises:
            SavedMapError: If storage is unavailable.
        """
        return store.list_published_maps()

    @router.get("/{slug}", response_model=SavedMap, response_model_exclude_unset=True)
    def load_map_for_editing(slug: Slug) -> SavedMap:
        """Load the saved configuration and revision for an administrator's draft.

        Args:
            slug: Fixed URL name of the published map.

        Returns:
            Current map, without acquiring or changing its shared contributions.

        Raises:
            SavedMapError: If missing or storage is unavailable.
        """
        return store.get_saved_map(slug)

    @router.put("/{slug}", response_model=SavedMap, response_model_exclude_unset=True)
    def save_map_changes(
        slug: Slug, payload: UpdateSavedMap, request: Request
    ) -> SavedMap:
        """Save an administrator's draft at the same published URL.

        Args:
            slug: Existing map's fixed URL name.
            payload: Replacement configuration and revision opened for editing.
            request: Origin used to validate site-local layer references.

        Returns:
            Updated saved configuration and revision.

        Raises:
            HTTPException: If site-local layer references belong to another site.
            SavedMapError: If missing, renamed, stale, or storage is unavailable.
        """
        validate_site_local_layers(payload, request)
        return store.update_saved_map(slug, payload)

    @router.post("/{slug}/edit-link", response_model=SavedMapEditToken)
    def issue_map_edit_link(slug: Slug) -> SavedMapEditToken:
        """Create a private edit link for an active map, replacing any previous link.

        Args:
            slug: Fixed URL name of the map selected by the administrator.

        Returns:
            New private token to share with the publisher.

        Raises:
            SavedMapError: If the map is absent, deleted, or storage is unavailable.
        """
        return SavedMapEditToken(editToken=store.issue_edit_token(slug))

    @router.delete("/{slug}/edit-link", status_code=204)
    def revoke_map_edit_link(slug: Slug) -> Response:
        """Disable the private edit link while retaining the published map.

        Args:
            slug: Fixed URL name of the map selected by the administrator.

        Returns:
            Empty success response, including when the link was already revoked.

        Raises:
            SavedMapError: If the map does not exist or storage is unavailable.
        """
        store.revoke_edit_token(slug)
        return Response(status_code=204)

    @router.delete("/{slug}", status_code=204)
    def delete_map(slug: Slug) -> Response:
        """Make a published map unavailable while keeping its configuration for Undo.

        Args:
            slug: Fixed URL name of the map to hide.

        Returns:
            Empty success response, including when already deleted.

        Raises:
            SavedMapError: If the map does not exist or storage is unavailable.
        """
        store.set_map_deleted(slug, deleted=True)
        return Response(status_code=204)

    @router.post("/{slug}/restore", status_code=204)
    def restore_map(slug: Slug) -> Response:
        """Restore a deleted map at its original URL without changing shared polygons.

        Args:
            slug: Fixed URL name of the map to restore.

        Returns:
            Empty success response, including when already active.

        Raises:
            SavedMapError: If the map does not exist or storage is unavailable.
        """
        store.set_map_deleted(slug, deleted=False)
        return Response(status_code=204)

    return router
