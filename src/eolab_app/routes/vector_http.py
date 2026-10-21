"""Translate vector HTTP errors and keep browser-owned vector responses private."""

from collections.abc import Awaitable, Callable

from fastapi import HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.routing import APIRoute
from starlette.responses import JSONResponse

from eolab_app.vector_uploads import VectorUploadError

from eolab_app.vector.errors import (
    VectorAssetError,
    VectorConflictError,
    VectorFeatureError,
    VectorFilterCountCapacityError,
    VectorFilterCountQueueTimeoutError,
    VectorNotFoundError,
    VectorPublicationError,
    VectorRequestError,
    VectorUpstreamError,
)


class PrivateVectorRoute(APIRoute):
    """Keep upload and rendering responses private, including their error details."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        """Wrap an endpoint without buffering its streamed request body.

        Returns:
            Handler translating vector failures and applying private headers.
        """
        handler = super().get_route_handler()

        async def private(request: Request) -> Response:
            """Return an endpoint result or safe error with private response headers.

            Args:
                request: Incoming upload or private-vector rendering request.

            Returns:
                Response whose content must not be cached by browsers or proxies.
            """
            try:
                response = await handler(request)
            except (VectorUploadError, VectorFeatureError, HTTPException) as error:
                if isinstance(error, VectorUploadError):
                    failure = HTTPException(error.status, str(error))
                elif isinstance(error, VectorFeatureError):
                    failure = vector_http_exception(error)
                else:
                    failure = error
                response = JSONResponse(
                    {"detail": failure.detail},
                    failure.status_code,
                    headers=failure.headers,
                )
            except RequestValidationError as error:
                response = await request_validation_exception_handler(request, error)
            response.headers["Cache-Control"] = "private, no-store"
            response.headers["X-Content-Type-Options"] = "nosniff"
            return response

        return private


def vector_http_exception(error: VectorFeatureError) -> HTTPException:
    """Translate one vector application failure into the HTTP contract.

    Args:
        error: Application-level vector failure.

    Returns:
        FastAPI exception with stable status and public detail.

    Raises:
        TypeError: If a new vector failure lacks an explicit mapping.
    """
    if isinstance(
        error, (VectorFilterCountCapacityError, VectorFilterCountQueueTimeoutError)
    ):
        full = isinstance(error, VectorFilterCountCapacityError)
        return HTTPException(
            status_code=429 if full else 503,
            detail={
                "category": (
                    "filter_count_queue_full" if full else "filter_count_queue_timeout"
                ),
                "message": error.detail,
            },
            headers={"Retry-After": "2"},
        )
    if isinstance(error, VectorPublicationError):
        status_codes = {
            "reader_rejection": 422,
            "connectivity": 503,
            "authentication": 502,
            "timeout": 504,
            "configuration": 503,
            "upstream_failure": 502,
        }
        return HTTPException(
            status_code=status_codes[error.category],
            detail={"category": error.category, "message": error.detail},
        )
    mappings: tuple[tuple[type[VectorFeatureError], int], ...] = (
        (VectorRequestError, 400),
        (VectorNotFoundError, 404),
        (VectorAssetError, 422),
        (VectorConflictError, 409),
        (VectorUpstreamError, 502),
    )
    for error_type, status_code in mappings:
        if isinstance(error, error_type):
            return HTTPException(status_code=status_code, detail=error.detail)
    raise TypeError(f"Unmapped vector failure: {type(error).__name__}")
