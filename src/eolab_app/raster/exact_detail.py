"""Server-owned exact source-window reads for close raster map views."""

import math

import numpy
import rasterio
from affine import TransformNotInvertibleError
from rasterio.warp import transform_bounds
from rasterio.windows import Window

from eolab_app.raster.exact_source import (
    EXACT_SOURCE_MAX_BLOCK_READS,
    EXACT_SOURCE_MAX_DECODED_BYTES,
    EXACT_SOURCE_MAX_DIMENSION,
    ExactSourceWindowPlan as ExactDetailPlan,
    plan_exact_source_window,
    read_exact_source_window,
)
from eolab_app.raster.read_cancellation import RasterReadCancellationCheck


# Compatibility names retain the established public detail-preview contract;
# source planning itself is rendering-neutral and owned by ``exact_source``.
EXACT_DETAIL_MAX_DIMENSION = EXACT_SOURCE_MAX_DIMENSION
EXACT_DETAIL_MAX_SOURCE_BLOCK_READS = EXACT_SOURCE_MAX_BLOCK_READS
EXACT_DETAIL_MAX_DECODED_SOURCE_BYTES = EXACT_SOURCE_MAX_DECODED_BYTES
EXACT_DETAIL_EDGE_DENSIFY_POINTS = 21
EXACT_DETAIL_WINDOW_PADDING_PIXELS = 1


def _source_window_for_projected_bounds(
    dataset: rasterio.io.DatasetReader,
    projected_bounds: tuple[float, float, float, float],
) -> Window | None:
    """Conservatively bound one Web-Mercator view in source pixels.

    The view edges are densified during CRS transformation, enclosed by an
    axis-aligned source-CRS rectangle, transformed through the complete inverse
    affine, padded by one source pixel for numeric roundoff, and clipped to the
    raster. The resulting envelope may contain pixels outside the visible map
    polygon, but it can never authorize a read outside its explicit window.

    Args:
        dataset: Open georeferenced raster satisfying the source contract.
        projected_bounds: Ordered finite EPSG:3857 view bounds.

    Returns:
        Positive integral source window, or ``None`` when the transformed view
        does not overlap source pixels.

    Raises:
        ValueError: If bounds, transformation, or affine metadata is invalid.
        rasterio.errors.RasterioError: If CRS transformation fails.
    """
    if not (
        len(projected_bounds) == 4
        and all(math.isfinite(value) for value in projected_bounds)
        and projected_bounds[0] < projected_bounds[2]
        and projected_bounds[1] < projected_bounds[3]
    ):
        raise ValueError("Exact detail projected bounds are invalid")
    source_bounds = transform_bounds(
        "EPSG:3857",
        dataset.crs,
        *projected_bounds,
        densify_pts=EXACT_DETAIL_EDGE_DENSIFY_POINTS,
    )
    if not all(math.isfinite(value) for value in source_bounds):
        raise ValueError("Exact detail transformation produced non-finite bounds")
    try:
        inverse_transform = ~dataset.transform
    except TransformNotInvertibleError:
        raise ValueError("Exact detail source affine is not invertible") from None

    left, bottom, right, top = source_bounds
    pixel_corners = tuple(
        inverse_transform * (x, y)
        for x, y in (
            (left, bottom),
            (left, top),
            (right, bottom),
            (right, top),
        )
    )
    if not all(
        math.isfinite(value)
        for column, row in pixel_corners
        for value in (column, row)
    ):
        raise ValueError("Exact detail transformation produced non-finite pixels")

    padding = EXACT_DETAIL_WINDOW_PADDING_PIXELS
    column_start = max(
        0,
        math.floor(min(column for column, _ in pixel_corners)) - padding,
    )
    row_start = max(
        0,
        math.floor(min(row for _, row in pixel_corners)) - padding,
    )
    column_stop = min(
        dataset.width,
        math.ceil(max(column for column, _ in pixel_corners)) + padding,
    )
    row_stop = min(
        dataset.height,
        math.ceil(max(row for _, row in pixel_corners)) + padding,
    )
    if column_start >= column_stop or row_start >= row_stop:
        return None
    return Window(
        column_start,
        row_start,
        column_stop - column_start,
        row_stop - row_start,
    )


def plan_exact_current_view(
    dataset: rasterio.io.DatasetReader,
    projected_bounds: tuple[float, float, float, float],
) -> ExactDetailPlan | None:
    """Admit an exact current-view window only under every fixed work limit.

    Args:
        dataset: Open one-band raster with supported native validity metadata.
        projected_bounds: Ordered finite EPSG:3857 map/raster intersection.

    Returns:
        Exact bounded read plan, or ``None`` when the view is outside the
        source or remains too broad for exact rendering. Returning ``None`` is
        the owned signal to retain the selected sample-grid policy.

    Raises:
        ValueError: If source structure, bounds, transformation, or affine
            metadata violates the exact-detail contract.
        rasterio.errors.RasterioError: If CRS transformation fails.
    """
    source_window = _source_window_for_projected_bounds(dataset, projected_bounds)
    if source_window is None:
        return None
    return plan_exact_source_window(dataset, source_window)


def read_exact_current_view(
    dataset: rasterio.io.DatasetReader,
    plan: ExactDetailPlan,
    cancellation_requested: RasterReadCancellationCheck | None = None,
) -> numpy.ma.MaskedArray:
    """Read one admitted current-view plan through the shared exact reader.

    Args:
        dataset: Open source that owns the already-established plan.
        plan: Immutable exact-detail plan returned for this dataset.
        cancellation_requested: Optional thread-safe obsolescence predicate.

    Returns:
        Complete masked source window at native resolution.

    Raises:
        RasterReadCancelled: If every request waiter disconnects.
        rasterio.errors.RasterioError: If an admitted native-block read fails.
    """
    return read_exact_source_window(dataset, plan, cancellation_requested)
