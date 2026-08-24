"""Server-owned exact source-window reads for close raster map views."""

import math
from dataclasses import dataclass

import numpy
import rasterio
from affine import TransformNotInvertibleError
from rasterio.warp import transform_bounds
from rasterio.windows import Window

from eolab_app.raster.sample_grid import (
    SourceBlockIndex,
    _block_indexes_for_window,
    _decoded_bytes_for_blocks,
    _read_native_block,
    _require_source_contract,
)
from eolab_app.raster.read_cancellation import (
    RasterReadCancellationCheck,
    require_active_raster_read,
)


EXACT_DETAIL_MAX_DIMENSION = 512
EXACT_DETAIL_MAX_SOURCE_BLOCK_READS = 1_024
EXACT_DETAIL_MAX_DECODED_SOURCE_BYTES = 64 * 1024 * 1024
EXACT_DETAIL_EDGE_DENSIFY_POINTS = 21
EXACT_DETAIL_WINDOW_PADDING_PIXELS = 1


@dataclass(frozen=True)
class ExactDetailPlan:
    """Immutable proof for one bounded current-view source window.

    Attributes:
        source_window: Integral source-pixel envelope clipped to the raster.
        block_indexes: Intersecting native band-one blocks in row-major order.
        decoded_source_bytes: Conservative cumulative value and validity bytes.
    """

    source_window: Window
    block_indexes: tuple[SourceBlockIndex, ...]
    decoded_source_bytes: int


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
    _require_source_contract(dataset)
    source_window = _source_window_for_projected_bounds(dataset, projected_bounds)
    if source_window is None:
        return None
    if (
        int(source_window.width) > EXACT_DETAIL_MAX_DIMENSION
        or int(source_window.height) > EXACT_DETAIL_MAX_DIMENSION
    ):
        return None
    block_shape = tuple(int(value) for value in dataset.block_shapes[0])
    block_indexes = _block_indexes_for_window(source_window, block_shape)
    if len(block_indexes) > EXACT_DETAIL_MAX_SOURCE_BLOCK_READS:
        return None
    decoded_source_bytes = _decoded_bytes_for_blocks(dataset, block_indexes)
    if decoded_source_bytes > EXACT_DETAIL_MAX_DECODED_SOURCE_BYTES:
        return None
    return ExactDetailPlan(
        source_window=source_window,
        block_indexes=block_indexes,
        decoded_source_bytes=decoded_source_bytes,
    )


def read_exact_current_view(
    dataset: rasterio.io.DatasetReader,
    plan: ExactDetailPlan,
    cancellation_requested: RasterReadCancellationCheck | None = None,
) -> numpy.ma.MaskedArray:
    """Read every pixel in an admitted source window one native block at a time.

    Args:
        dataset: Open source that owns the already-established plan.
        plan: Immutable exact-detail plan returned for this dataset.
        cancellation_requested: Optional thread-safe obsolescence predicate.

    Returns:
        Complete masked source window at native resolution. Each intersecting
        native block is read once without resampling or a boundless read.

    Raises:
        RasterReadCancelled: If every request waiter disconnects.
        rasterio.errors.RasterioError: If an admitted native-block read fails.
    """
    source_window = plan.source_window
    row_start = int(source_window.row_off)
    column_start = int(source_window.col_off)
    row_stop = row_start + int(source_window.height)
    column_stop = column_start + int(source_window.width)
    values = numpy.ma.masked_all(
        (int(source_window.height), int(source_window.width)),
        dtype=numpy.dtype(dataset.dtypes[0]),
    )
    for block_index in plan.block_indexes:
        require_active_raster_read(cancellation_requested)
        block_window = dataset.block_window(1, *block_index)
        block = _read_native_block(dataset, block_window)
        require_active_raster_read(cancellation_requested)
        block_row_start = int(block_window.row_off)
        block_column_start = int(block_window.col_off)
        copy_row_start = max(row_start, block_row_start)
        copy_column_start = max(column_start, block_column_start)
        copy_row_stop = min(
            row_stop,
            block_row_start + int(block_window.height),
        )
        copy_column_stop = min(
            column_stop,
            block_column_start + int(block_window.width),
        )
        values[
            copy_row_start - row_start:copy_row_stop - row_start,
            copy_column_start - column_start:copy_column_stop - column_start,
        ] = block[
            copy_row_start - block_row_start:copy_row_stop - block_row_start,
            copy_column_start - block_column_start:copy_column_stop - block_column_start,
        ]
    return values
