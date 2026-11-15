"""Accept private reference masks through the shared upload ownership boundary."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from eolab_app.raster_uploads import RasterUpload, RasterUploadStore
from eolab_app.routes.uploads import PrivateUploadRoute, upload_browser
from eolab_app.upload_storage import UploadRecord


def create_raster_uploads_router(store: RasterUploadStore) -> APIRouter:
    """Expose raster admission and owned-file access without rendering dependencies.

    Args:
        store: Raster inspector using the application's shared upload storage.

    Returns:
        Private, non-cacheable endpoints accepting raw GeoTIFF request bodies.
    """
    router = APIRouter(
        prefix="/api/raster-uploads",
        tags=["raster uploads"],
        route_class=PrivateUploadRoute,
    )
    Browser = Annotated[str, Depends(upload_browser)]

    @router.post(
        "",
        status_code=201,
        response_model=RasterUpload,
        openapi_extra={
            "requestBody": {
                "required": True,
                "content": {
                    "image/tiff": {"schema": {"type": "string", "format": "binary"}}
                },
            }
        },
    )
    async def upload(
        request: Request,
        browser: Browser,
        name: Annotated[str, Query(min_length=1, max_length=200, pattern=r"\S")],
    ) -> RasterUpload:
        """Store a binary reference mask belonging to this browser.

        Args:
            request: Raw single-band GeoTIFF body.
            browser: Validated private upload owner.
            name: Display label that is never interpreted as a path.

        Returns:
            Original mask metadata, opaque ID and seven-day expiry.

        Raises:
            UploadError: If the file, quota or storage rejects admission.
        """
        return await store.create(browser, name, request.stream())

    @router.get("/{identifier}", response_model=UploadRecord)
    def describe_upload(identifier: UUID, browser: Browser) -> UploadRecord:
        """Return the requesting browser's unexpired raster upload record.

        Args:
            identifier: Opaque uploaded-raster ID.
            browser: Validated private upload owner.

        Returns:
            Path-free identity, display name, size and expiry.

        Raises:
            UploadError: If the file is expired, unavailable or owned elsewhere.
        """
        metadata, _source = store.storage.get_upload_source(
            browser, identifier, "raster"
        )
        return metadata

    @router.delete("/{identifier}", status_code=204)
    def delete_upload(identifier: UUID, browser: Browser) -> None:
        """Withdraw a raster upload and delete files no active calculation needs.

        Args:
            identifier: Opaque uploaded-raster ID.
            browser: Validated private upload owner.

        Raises:
            UploadError: If the file is unavailable or removal fails.
        """
        store.storage.get_upload_source(browser, identifier, "raster")
        store.storage.delete(browser, identifier)

    return router
