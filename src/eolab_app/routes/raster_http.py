"""Stable HTTP error translation shared by raster feature boundaries."""

from fastapi import HTTPException

from eolab_app.raster.errors import (
    RasterAssetError,
    RasterConflictError,
    RasterFeatureError,
    RasterNotFoundError,
    RasterPublicationError,
    RasterRequestError,
    RasterUpstreamError,
)


def raster_http_exception(error: RasterFeatureError) -> HTTPException:
    """Translate one application failure into the stable HTTP contract.

    Args:
        error: Application-level raster failure.

    Returns:
        FastAPI exception with the stable status and public error document.

    Raises:
        TypeError: If a new failure type has no explicit HTTP mapping.
    """
    if isinstance(error, RasterPublicationError):
        publication_status_codes = {
            "reader_rejection": 422,
            "connectivity": 503,
            "authentication": 502,
            "timeout": 504,
            "configuration": 503,
            "upstream_failure": 502,
        }
        return HTTPException(
            status_code=publication_status_codes[error.category],
            detail={"category": error.category, "message": error.detail},
        )

    status_codes: tuple[tuple[type[RasterFeatureError], int], ...] = (
        (RasterRequestError, 400),
        (RasterNotFoundError, 404),
        (RasterAssetError, 422),
        (RasterConflictError, 409),
        (RasterUpstreamError, 502),
    )
    for error_type, status_code in status_codes:
        if isinstance(error, error_type):
            return HTTPException(status_code=status_code, detail=error.detail)
    raise TypeError(f"Unmapped raster failure: {type(error).__name__}")
