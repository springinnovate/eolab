"""Accept private GeoPackages using the browser identity shared with annotations."""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, Response

from eolab_app.routes.browser_identity import get_browser_owner_hash
from eolab_app.routes.vector_http import PrivateVectorRoute
from eolab_app.vector.sources import resolve_uploaded_vector
from eolab_app.vector_uploads import VectorUpload, VectorUploadError, VectorUploadStore


def upload_browser(request: Request, response: Response) -> str:
    """Recognize the browser and require the upload API's same-origin mutation header.

    Args:
        request: Incoming browser request.
        response: Response renewing the existing private browser cookie.

    Returns:
        Hashed browser identity used to locate only its uploads.

    Raises:
        HTTPException: If a mutation lacks X-EOLab-Uploads: 1 or is cross-origin.
    """
    return get_browser_owner_hash(request, response, mutation_header="X-EOLab-Uploads")


def create_vector_uploads_router(store: VectorUploadStore) -> APIRouter:
    """Expose private upload access and clean interrupted writes at startup.

    POST accepts the raw GeoPackage body and a display name query parameter. Both
    mutations require X-EOLab-Uploads: 1. The browser cookie is the access credential;
    it is never returned in metadata. There is no public catalog registration.

    Args:
        store: Sole writer for this application's persistent upload directory.

    Returns:
        Router independent of rendering, analysis and Processing services.
    """

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        """Clean abandoned staging directories before accepting uploads.

        Args:
            _: Application supplied by FastAPI.

        Yields:
            Control while upload routes serve requests.

        Raises:
            OSError: If the configured upload volume cannot be initialized.
        """
        await asyncio.to_thread(store.initialize)
        yield

    router = APIRouter(
        prefix="/api/vector-uploads",
        tags=["vector uploads"],
        route_class=PrivateVectorRoute,
        lifespan=lifespan,
    )
    Browser = Annotated[str, Depends(upload_browser)]

    @router.get("", response_model=list[VectorUpload])
    def list_uploads(browser: Browser) -> list[VectorUpload]:
        """List uploads belonging to the requesting browser.

        Args:
            browser: Identity from the validated private cookie.

        Returns:
            Only this browser's published upload records.

        Raises:
            VectorUploadError: If upload metadata cannot be read.
        """
        return store.list_uploads(browser)

    @router.get("/{identifier}", response_model=VectorUpload)
    def describe_upload(identifier: UUID, browser: Browser) -> VectorUpload:
        """Return one accessible upload's layer, CRS and attribute schema.

        Args:
            identifier: Upload ID returned by upload/list.
            browser: Identity from the validated private cookie.

        Returns:
            Admission metadata without the server-only source grant or credentials.

        Raises:
            VectorUploadError: If the upload is unavailable to this browser or
                its storage cannot be read.
        """
        metadata, _source = resolve_uploaded_vector(store, browser, identifier)
        return metadata

    @router.post(
        "",
        status_code=201,
        response_model=VectorUpload,
        openapi_extra={
            "requestBody": {
                "required": True,
                "content": {
                    "application/geopackage+sqlite3": {
                        "schema": {"type": "string", "format": "binary"}
                    }
                },
            }
        },
    )
    async def upload(
        request: Request,
        browser: Browser,
        name: Annotated[str, Query(min_length=1, max_length=200, pattern=r"\S")],
    ) -> VectorUpload:
        """Store one immutable polygon GeoPackage from the streamed request body.

        Args:
            request: Raw GeoPackage body; no multipart envelope is used.
            browser: Identity from the validated private cookie.
            name: User-facing label, never interpreted as a filesystem path.

        Returns:
            Metadata and the opaque identifier for reopening this upload.

        Raises:
            VectorUploadError: If admission or storage fails.
        """
        return await store.create(browser, name, request.stream())

    @router.delete("/{identifier}", status_code=204)
    def delete_upload(identifier: UUID, browser: Browser) -> None:
        """Delete this browser's upload and its stored file.

        Args:
            identifier: Upload identifier returned by upload/list.
            browser: Identity from the validated private cookie.

        Raises:
            VectorUploadError: If the upload is unavailable or deletion fails.
        """
        store.delete(browser, identifier)

    return router
