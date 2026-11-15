"""Expose browser-owned upload usage without exposing storage paths or credentials."""

from collections.abc import Awaitable, Callable
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.routing import APIRoute
from starlette.responses import JSONResponse

from eolab_app.routes.browser_identity import get_browser_owner_hash
from eolab_app.upload_storage import UploadError, UploadStorage, UploadSummary


def upload_browser(request: Request, response: Response) -> str:
    """Recognize upload ownership and require the same-origin mutation header.

    Args:
        request: Incoming upload request.
        response: Response renewing the existing private browser cookie.

    Returns:
        Hashed browser identity used to authorize private original files.

    Raises:
        HTTPException: If a mutation is cross-origin or lacks X-EOLab-Uploads: 1.
    """
    return get_browser_owner_hash(request, response, mutation_header="X-EOLab-Uploads")


class PrivateUploadRoute(APIRoute):
    """Keep upload metadata and errors private without buffering request bodies."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        """Wrap an upload endpoint with shared errors and private response headers.

        Returns:
            Handler translating upload failures without leaking storage details.
        """
        handler = super().get_route_handler()

        async def private(request: Request) -> Response:
            """Handle one streamed upload request or private usage query.

            Args:
                request: Incoming request passed unchanged to the endpoint.

            Returns:
                Private, non-cacheable response, including admission errors.
            """
            try:
                response = await handler(request)
            except UploadError as error:
                response = JSONResponse({"detail": str(error)}, error.status)
            except HTTPException as error:
                response = JSONResponse(
                    {"detail": error.detail}, error.status_code, headers=error.headers
                )
            except RequestValidationError as error:
                response = await request_validation_exception_handler(request, error)
            response.headers["Cache-Control"] = "private, no-store"
            response.headers["X-Content-Type-Options"] = "nosniff"
            return response

        return private


def create_uploads_router(storage: UploadStorage) -> APIRouter:
    """Expose shared usage for all uploaded original file formats.

    Args:
        storage: Sole upload lifecycle and budget owner composed by the application.

    Returns:
        Private browser-owned summary router; format adapters retain their APIs.
    """
    router = APIRouter(
        prefix="/api/uploads", tags=["uploads"], route_class=PrivateUploadRoute
    )
    Browser = Annotated[str, Depends(upload_browser)]

    @router.get("", response_model=UploadSummary)
    def summarize_uploads(browser: Browser) -> UploadSummary:
        """Return available originals, expiry dates and occupied storage slots.

        Args:
            browser: Identity supplied by the validated private browser cookie.

        Returns:
            Only this browser's records and usage; global storage remains private.

        Raises:
            UploadError: If admitted metadata or storage usage cannot be read.
        """
        return storage.summary(browser)

    return router
