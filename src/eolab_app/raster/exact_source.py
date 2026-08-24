"""Provably bounded native-resolution source-window raster reads."""

import math
from dataclasses import dataclass

import numpy
import rasterio
from rasterio.windows import Window

from eolab_app.raster.read_cancellation import (
    RasterReadCancellationCheck,
    require_active_raster_read,
)
from eolab_app.raster.source_contract import (
    SourceBlockIndex,
    decoded_source_bytes_for_blocks,
    read_native_raster_block,
    require_bounded_source_structure,
    source_block_indexes_for_window,
)


EXACT_SOURCE_MAX_DIMENSION = 512
EXACT_SOURCE_MAX_BLOCK_READS = 1_024
EXACT_SOURCE_MAX_DECODED_BYTES = 64 * 1024 * 1024


@dataclass(frozen=True)
class ExactSourceWindowPlan:
    """Immutable proof for one bounded native-resolution source window.

    Attributes:
        source_window: Integral source-pixel window clipped to the raster.
        block_indexes: Intersecting native band-one blocks in row-major order.
        decoded_source_bytes: Conservative cumulative value and validity bytes.
    """

    source_window: Window
    block_indexes: tuple[SourceBlockIndex, ...]
    decoded_source_bytes: int


def plan_exact_source_window(
    dataset: rasterio.io.DatasetReader,
    source_window: Window,
) -> ExactSourceWindowPlan | None:
    """Admit a source-pixel window under every exact-read work limit.

    Args:
        dataset: Open one-band raster with supported native validity metadata.
        source_window: Positive integral window wholly inside the raster.

    Returns:
        Exact bounded read plan, or ``None`` when the window exceeds an exact
        dimension, native-block, or decoded-work ceiling.

    Raises:
        ValueError: If source structure or the supplied window is invalid.
    """
    require_bounded_source_structure(dataset)
    numeric_window = tuple(
        float(value)
        for value in (
            source_window.col_off,
            source_window.row_off,
            source_window.width,
            source_window.height,
        )
    )
    if not all(
        math.isfinite(value) and value.is_integer()
        for value in numeric_window
    ):
        raise ValueError("Exact raster source window must be integral")
    column_offset, row_offset, width, height = (
        int(value) for value in numeric_window
    )
    if (
        column_offset < 0
        or row_offset < 0
        or width < 1
        or height < 1
        or column_offset + width > dataset.width
        or row_offset + height > dataset.height
    ):
        raise ValueError("Exact raster source window is outside the source")
    if width > EXACT_SOURCE_MAX_DIMENSION or height > EXACT_SOURCE_MAX_DIMENSION:
        return None
    block_shape = tuple(int(value) for value in dataset.block_shapes[0])
    block_indexes = source_block_indexes_for_window(source_window, block_shape)
    if len(block_indexes) > EXACT_SOURCE_MAX_BLOCK_READS:
        return None
    decoded_source_bytes = decoded_source_bytes_for_blocks(
        dataset,
        block_indexes,
    )
    if decoded_source_bytes > EXACT_SOURCE_MAX_DECODED_BYTES:
        return None
    return ExactSourceWindowPlan(
        source_window=source_window,
        block_indexes=block_indexes,
        decoded_source_bytes=decoded_source_bytes,
    )


def read_exact_source_window(
    dataset: rasterio.io.DatasetReader,
    plan: ExactSourceWindowPlan,
    cancellation_requested: RasterReadCancellationCheck | None = None,
) -> numpy.ma.MaskedArray:
    """Read every pixel in an admitted window one native block at a time.

    Args:
        dataset: Open source that owns the already-established plan.
        plan: Immutable exact source-window plan for this dataset.
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
        block = read_native_raster_block(dataset, block_window)
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
