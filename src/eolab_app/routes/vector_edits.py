"""Keep exact polygon edits within the original-source and private upload boundaries."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import replace
from functools import partial
from uuid import uuid5

from fastapi import APIRouter, HTTPException, Request, Response
from starlette.responses import JSONResponse

from eolab_app.catalog_selection import (
    ResolvedCatalogSelection,
    SelectionUnavailableError,
    UploadedSelection,
    VectorSourceOwners,
)
from eolab_app.routes.browser_identity import get_browser_owner_hash
from eolab_app.routes.http_disconnect import (
    HttpClientDisconnectedError,
    run_until_http_disconnect,
)
from eolab_app.routes.vector_http import PrivateVectorRoute, read_vector_source_owners
from eolab_app.upload_storage import UploadError
from eolab_app.vector.geometry_edit import (
    EditSource,
    PolygonEditRead,
    ReadPolygonEdit,
    SavePolygonEdit,
    read_polygon_edit,
    write_polygon_edit,
)
from eolab_app.vector_uploads import VectorUpload, VectorUploadError, VectorUploadStore

OpenEditSource = Callable[
    [EditSource, str | VectorSourceOwners | None],
    AbstractAsyncContextManager[ResolvedCatalogSelection],
]
MAX_EDIT_REQUEST_BYTES = 1024 * 1024


class PolygonEditRoute(PrivateVectorRoute):
    """Bound edit JSON before FastAPI parses nested source and coordinate arrays."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        """Return the private vector handler wrapped in the edit body limit.

        Returns:
            Handler accepting a bounded geometry edit document.
        """
        handler = super().get_route_handler()

        async def bounded(request: Request) -> Response:
            """Pass at most one MiB of edit JSON to the validated endpoint.

            Args:
                request: May supply the JSON as multiple chunks.

            Returns:
                The endpoint response or a private payload-too-large error.
            """
            body = bytearray()
            async for chunk in request.stream():
                if len(body) + len(chunk) > MAX_EDIT_REQUEST_BYTES:
                    return JSONResponse(
                        {"detail": "The polygon edit request is too large."},
                        status_code=413,
                        headers={
                            "Cache-Control": "private, no-store",
                            "X-Content-Type-Options": "nosniff",
                        },
                    )
                body.extend(chunk)
            request._body = bytes(body)
            return await handler(request)

        return bounded


def create_vector_edit_router(
    open_selection: OpenEditSource,
    uploads: VectorUploadStore,
    read_artifact_owner: Callable[[Request, Response], str],
) -> APIRouter:
    """Provide filtered geometry reads and saves of new private vector snapshots.

    Args:
        open_selection: Original-source reader that validates the exact identity
            and applied predicate, including references to other polygon layers.
        uploads: Existing private GeoPackage owner and admission.
        read_artifact_owner: Browser ownership used by run or drawing filter sources.

    Returns:
        Same-origin vector editing router. It requires no rendering publication.
    """
    router = APIRouter(
        prefix="/api/vector-edits",
        tags=["vector editing"],
        route_class=PolygonEditRoute,
    )

    @asynccontextmanager
    async def open_edit_source(
        selection: EditSource,
        owners: str | VectorSourceOwners | None,
    ) -> AsyncIterator[ResolvedCatalogSelection]:
        """Hold the exact source and keep an owned upload readable during native work.

        Args:
            selection: Path-free source descriptor and applied predicate.
            owners: Credentials needed by this source and its filter.

        Yields:
            Authorized Catalog layer or a private original held by a read lease.

        Raises:
            HTTPException: If the original source is no longer available.
            VectorUploadError: If the private source cannot be leased by this browser.
        """
        try:
            async with open_selection(selection, owners) as resolved:
                if isinstance(selection, UploadedSelection):
                    owner = (
                        owners.uploads
                        if isinstance(owners, VectorSourceOwners)
                        else owners
                    )
                    # The original-source boundary has already established ownership.
                    assert owner is not None
                    async with uploads.storage.open_source(
                        owner, selection.uploadId, "vector"
                    ) as (_, path):
                        yield replace(resolved, path=path)
                else:
                    yield resolved
        except SelectionUnavailableError as error:
            raise HTTPException(409, error.detail) from error
        except UploadError as error:
            raise VectorUploadError(error.status, str(error)) from error

    @router.post("/feature", response_model=PolygonEditRead)
    async def read_feature(
        payload: ReadPolygonEdit, request: Request, response: Response
    ) -> PolygonEditRead:
        """Return matching native IDs and editable vertices for this view.

        Args:
            payload: Authorized source request and a click position or native ID.
            request: HTTP connection that owns the cancellable read.
            response: Response renewing the private source credentials, if needed.

        Returns:
            The editable feature, a list of overlapping feature IDs, or an empty result.

        Raises:
            HTTPException: If selection access fails or the connection closes.
        """
        owners = read_vector_source_owners(
            payload.source, request, response, read_artifact_owner=read_artifact_owner
        )

        async def read_selected() -> PolygonEditRead:
            """Read the selected feature while its source is open."""
            async with open_edit_source(payload.source, owners) as source:
                return await read_polygon_edit(source, payload.target)

        try:
            return await run_until_http_disconnect(request, read_selected())
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Polygon reading cancelled.") from error

    @router.post("/save", response_model=VectorUpload)
    async def save_feature(
        payload: SavePolygonEdit, request: Request, response: Response
    ) -> VectorUpload:
        """Save a geometry revision as one ordinary private upload.

        Args:
            payload: The exact original feature and changes to its existing rings.
            request: Same-origin request carrying the uploader's browser identity.
            response: Response renewing the private owner cookie.

        Returns:
            The published immutable upload. A retry of the same draft returns that upload.

        Raises:
            HTTPException: If ownership, source access or the connection fails.
            VectorUploadError: If geometry, quota or atomic publication fails.
        """
        owners = read_vector_source_owners(
            payload.source, request, response, read_artifact_owner=read_artifact_owner
        )
        owner = owners.uploads if isinstance(owners, VectorSourceOwners) else owners
        if owner is None:
            owner = get_browser_owner_hash(
                request, response, mutation_header="X-EOLab-Uploads"
            )
        identifier = uuid5(payload.saveId, payload.model_dump_json(by_alias=True))

        async def find_revision() -> VectorUpload | None:
            """Return this browser's already published copy, if the same save completed."""
            try:
                metadata, _ = await asyncio.to_thread(
                    uploads.get_upload_source, owner, identifier
                )
                return metadata
            except VectorUploadError as error:
                if error.status != 404:
                    raise
                return None

        async def save_selected() -> VectorUpload:
            """Admit the draft through the existing upload owner while its input is open."""
            prior = await find_revision()
            if prior is not None:
                return prior
            try:
                async with open_edit_source(payload.source, owners) as source:
                    return await uploads.create(
                        owner,
                        payload.name.strip() or "Edited polygons",
                        partial(write_polygon_edit, source, payload),
                        identifier=identifier,
                    )
            except VectorUploadError:
                # Admission serializes writers. A concurrent retry may discover
                # that the same snapshot was published while it waited.
                prior = await find_revision()
                if prior is not None:
                    return prior
                raise

        try:
            return await run_until_http_disconnect(request, save_selected())
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Polygon saving cancelled.") from error

    return router
