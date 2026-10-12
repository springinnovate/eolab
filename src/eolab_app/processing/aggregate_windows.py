"""Group raster storage blocks into read windows and expression-evaluation tiles."""

from collections.abc import Iterator
from math import ceil

from rasterio.windows import Window

from eolab_app.processing.aggregate_models import AggregateExecutionPlan


def find_raster_block_bounds(
    window: Window, block_shape: tuple[int, int]
) -> tuple[int, int, int, int]:
    """Find the range of raster storage blocks intersecting a pixel window.

    Args:
        window: Integral, nonempty selection inside the source.
        block_shape: Native block height and width.

    Returns:
        First column, first row, exclusive last column and exclusive last row.
    """
    block_height, block_width = block_shape
    return (
        int(window.col_off) // block_width,
        int(window.row_off) // block_height,
        ceil((window.col_off + window.width) / block_width),
        ceil((window.row_off + window.height) / block_height),
    )


def plan_raster_read_windows(
    window: Window,
    block_shape: tuple[int, int],
    source_width: int,
    source_height: int,
    target: int | None,
    tile_side: int,
) -> AggregateExecutionPlan:
    """Plan read-window and evaluation-tile sizes within the selected raster blocks.

    Reads group adjacent storage blocks, expanding width before height, without
    adding blocks outside the selected range.

    Args:
        window: Integral admitted selection inside the source.
        block_shape: Native block height and width.
        source_width: Full source width for clipping edge blocks.
        source_height: Full source height for clipping edge blocks.
        target: Target pixel count per read, or None for one-block reads.
        tile_side: Maximum evaluation-tile side; 64 limits per-cell geometry work.

    Returns:
        Maximum effective dimensions and exact read count for this selection.
    """
    first_block_column, first_block_row, stop_block_column, stop_block_row = (
        find_raster_block_bounds(window, block_shape)
    )
    block_height, block_width = block_shape
    columns = (
        min(
            stop_block_column - first_block_column,
            max(1, target // (block_height * block_width)),
        )
        if target
        else 1
    )
    rows = (
        min(
            stop_block_row - first_block_row,
            max(1, target // (columns * block_width * block_height)),
        )
        if target
        else 1
    )
    width = min(columns * block_width, source_width - first_block_column * block_width)
    height = min(rows * block_height, source_height - first_block_row * block_height)
    if target is None:
        evaluation_width, evaluation_height = min(tile_side, width), min(
            tile_side, height
        )
    elif tile_side == 64:
        evaluation_width = min(tile_side, width, target)
        evaluation_height = min(tile_side, height, max(1, target // evaluation_width))
    else:
        evaluation_width = min(width, target)
        evaluation_height = min(height, max(1, target // evaluation_width))
    return AggregateExecutionPlan(
        targetChunkPixels=target,
        readWidth=width,
        readHeight=height,
        evaluationWidth=evaluation_width,
        evaluationHeight=evaluation_height,
        readWindows=ceil((stop_block_column - first_block_column) / columns)
        * ceil((stop_block_row - first_block_row) / rows),
    )


def iter_raster_read_windows(
    window: Window,
    block_shape: tuple[int, int],
    source_width: int,
    source_height: int,
    plan: AggregateExecutionPlan,
) -> Iterator[tuple[Window, int]]:
    """Yield nonoverlapping raster read windows without reading pixel values.

    Args:
        window: The original admitted selection.
        block_shape: Native block height and width.
        source_width: Full source width.
        source_height: Full source height.
        plan: Read dimensions from the raster batch plan.

    Yields:
        A source-edge-clipped window and the number of native blocks it covers.
    """
    first_block_column, first_block_row, stop_block_column, stop_block_row = (
        find_raster_block_bounds(window, block_shape)
    )
    block_height, block_width = block_shape
    columns, rows = ceil(plan.readWidth / block_width), ceil(
        plan.readHeight / block_height
    )
    for row in range(first_block_row, stop_block_row, rows):
        for col in range(first_block_column, stop_block_column, columns):
            window_block_columns, window_block_rows = min(
                columns, stop_block_column - col
            ), min(rows, stop_block_row - row)
            yield Window(
                col * block_width,
                row * block_height,
                min(
                    window_block_columns * block_width, source_width - col * block_width
                ),
                min(
                    window_block_rows * block_height, source_height - row * block_height
                ),
            ), window_block_columns * window_block_rows
