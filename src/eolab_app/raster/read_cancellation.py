"""Cooperative cancellation contract for bounded Rasterio reads."""

from collections.abc import Callable


RasterReadCancellationCheck = Callable[[], bool]


class RasterReadCancelled(Exception):
    """Raised when every waiter has abandoned one bounded raster read."""


def require_active_raster_read(
    cancellation_requested: RasterReadCancellationCheck | None,
) -> None:
    """Stop work at a safe boundary after the last waiter disconnects.

    Args:
        cancellation_requested: Optional thread-safe predicate owned by the
            coalescing service.

    Returns:
        None while at least one request still owns the bounded read.

    Raises:
        RasterReadCancelled: If no request still needs the computation.
    """
    if cancellation_requested is not None and cancellation_requested():
        raise RasterReadCancelled
