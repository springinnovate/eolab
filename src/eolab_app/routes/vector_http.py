"""Stable HTTP error translation for vector visualization boundaries."""

from fastapi import HTTPException

from eolab_app.vector.errors import (
    VectorAssetError,
    VectorConflictError,
    VectorFeatureError,
    VectorNotFoundError,
    VectorRequestError,
    VectorUpstreamError,
)


def vector_http_exception(error: VectorFeatureError) -> HTTPException:
    """Translate one vector application failure into the HTTP contract.

    Args:
        error: Application-level vector failure.

    Returns:
        FastAPI exception with stable status and public detail.

    Raises:
        TypeError: If a new vector failure lacks an explicit mapping.
    """
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
