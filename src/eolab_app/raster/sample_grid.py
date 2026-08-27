"""Provably bounded native-block sampling for raster sample grids."""

import math
from dataclasses import dataclass

import numpy
import rasterio
from affine import TransformNotInvertibleError
from rasterio.warp import transform as warp_transform
from rasterio.windows import Window

from eolab_app.raster.source_contract import (
    SourceBlockIndex,
    decoded_source_bytes_for_blocks,
    read_native_raster_block,
    require_bounded_source_structure,
)
from eolab_app.raster.read_cancellation import (
    RasterReadCancellationCheck,
    require_active_raster_read,
)


SAMPLE_GRID_MAX_DIMENSION = 127
# One exact center-sample grid can require one distinct native block per cell.
# The independent decoded-work ceiling below remains the controlling bound for
# large blocks and prevents this count from authorizing unbounded source work.
SAMPLE_GRID_MAX_SOURCE_BLOCK_READS = (
    SAMPLE_GRID_MAX_DIMENSION * SAMPLE_GRID_MAX_DIMENSION
)
# The reader streams one structurally bounded native block at a time. This
# cumulative-work ceiling is 9 GiB and is not a simultaneous-memory allocation.
# It accommodates all 16,129 center samples for common 256-by-256 float64
# blocks while retaining an explicit byte bound for larger native blocks and
# unusually large source blocks.
SAMPLE_GRID_MAX_DECODED_SOURCE_BYTES = 9 * 1024 * 1024 * 1024
SAMPLE_GRID_CENTER_OFFSETS = ((0.5, 0.5),)
SAMPLE_GRID_MAX_POINTS_PER_CELL = len(SAMPLE_GRID_CENTER_OFFSETS)
# The one fixed center-sampled grid transforms one position in each cell.
SAMPLE_GRID_MAX_TRANSFORMED_POSITIONS = (
    SAMPLE_GRID_MAX_DIMENSION
    * SAMPLE_GRID_MAX_DIMENSION
    * SAMPLE_GRID_MAX_POINTS_PER_CELL
)
SourcePosition = tuple[int, int]


def sample_grid_policy_parameters() -> tuple[int, ...]:
    """Return fixed limits and positions affecting every sample-grid read.

    Returns:
        Dimension, block, decoded-work, transformation, and center-location
        parameters encoded for stable cache identities.
    """
    return (
        SAMPLE_GRID_MAX_DIMENSION,
        SAMPLE_GRID_MAX_SOURCE_BLOCK_READS,
        SAMPLE_GRID_MAX_DECODED_SOURCE_BYTES,
        SAMPLE_GRID_MAX_TRANSFORMED_POSITIONS,
        *(
            round(value * 1000)
            for offset in SAMPLE_GRID_CENTER_OFFSETS
            for value in offset
        ),
    )


@dataclass(frozen=True)
class SampleGridPlan:
    """Immutable source sampling plan that satisfies the native-block budget.

    Attributes:
        width: Number of sample-grid cells across the source raster.
        height: Number of sample-grid cells down the source raster.
        cell_positions: Row-major source positions inspected for every cell.
        block_indexes: Unique native band-one blocks in row-major order.
        decoded_source_bytes: Conservative band-plus-validity decoded bytes in
            those block windows.
        points_per_cell: Maximum configured positions for each sample-grid cell.
    """

    width: int
    height: int
    cell_positions: tuple[tuple[SourcePosition, ...], ...]
    block_indexes: tuple[SourceBlockIndex, ...]
    decoded_source_bytes: int
    points_per_cell: int


def _odd_dimension(limit: int) -> int:
    """Return the greatest positive odd integer no larger than ``limit``.

    Args:
        limit: Positive dimension ceiling.

    Returns:
        Greatest positive odd integer within the ceiling.
    """
    return limit if limit % 2 == 1 else max(1, limit - 1)


def _sample_grid_dimensions(
    source_width: int,
    source_height: int,
    maximum_dimension: int,
) -> tuple[int, int]:
    """Fit an odd, aspect-preserving grid inside one dimension ceiling.

    Odd dimensions ensure the source raster's central region is represented.

    Args:
        source_width: Positive source width in pixels.
        source_height: Positive source height in pixels.
        maximum_dimension: Positive maximum grid edge.

    Returns:
        Sample-grid height and width.
    """
    if source_width >= source_height:
        width = _odd_dimension(min(source_width, maximum_dimension))
        proportional_height = max(
            1,
            round(width * source_height / source_width),
        )
        height = _odd_dimension(min(source_height, proportional_height))
        return height, width
    height = _odd_dimension(min(source_height, maximum_dimension))
    proportional_width = max(
        1,
        round(height * source_width / source_height),
    )
    width = _odd_dimension(min(source_width, proportional_width))
    return height, width


def _position_in_cell(
    start: int,
    stop: int,
    fraction: float,
) -> int:
    """Select one deterministic source index inside a half-open cell range.

    Args:
        start: Inclusive source index.
        stop: Exclusive source index greater than ``start``.
        fraction: Fixed position from zero through one inside the range.

    Returns:
        Source index from ``start`` through ``stop - 1``.
    """
    return min(stop - 1, start + math.floor((stop - start) * fraction))


def _cell_positions(
    source_width: int,
    source_height: int,
    sample_grid_width: int,
    sample_grid_height: int,
) -> tuple[tuple[SourcePosition, ...], ...]:
    """Map every sample-grid cell to its deterministic source center.

    Args:
        source_width: Positive source width in pixels.
        source_height: Positive source height in pixels.
        sample_grid_width: Positive sample-grid width in cells.
        sample_grid_height: Positive sample-grid height in cells.

    Returns:
        One row-major center source position for every sample-grid cell.
    """
    row_fraction, column_fraction = SAMPLE_GRID_CENTER_OFFSETS[0]
    cells: list[tuple[SourcePosition, ...]] = []
    for sample_grid_row in range(sample_grid_height):
        row_start = math.floor(sample_grid_row * source_height / sample_grid_height)
        row_stop = max(
            row_start + 1,
            math.floor((sample_grid_row + 1) * source_height / sample_grid_height),
        )
        for sample_grid_column in range(sample_grid_width):
            column_start = math.floor(
                sample_grid_column * source_width / sample_grid_width
            )
            column_stop = max(
                column_start + 1,
                math.floor((sample_grid_column + 1) * source_width / sample_grid_width),
            )
            cells.append(((
                _position_in_cell(row_start, row_stop, row_fraction),
                _position_in_cell(
                    column_start,
                    column_stop,
                    column_fraction,
                ),
            ),))
    return tuple(cells)


def _source_window_cell_positions(
    source_window: Window,
    sample_grid_width: int,
    sample_grid_height: int,
) -> tuple[tuple[SourcePosition, ...], ...]:
    """Map a sample grid to centers inside one integral source window.

    Args:
        source_window: Positive integral source-pixel window.
        sample_grid_width: Positive sample-grid width in cells.
        sample_grid_height: Positive sample-grid height in cells.

    Returns:
        Row-major absolute source positions for every grid cell.
    """
    row_offset = int(source_window.row_off)
    column_offset = int(source_window.col_off)
    local_positions = _cell_positions(
        int(source_window.width),
        int(source_window.height),
        sample_grid_width,
        sample_grid_height,
    )
    return tuple(
        tuple(
            (row + row_offset, column + column_offset)
            for row, column in cell
        )
        for cell in local_positions
    )


def _projected_sample_grid_dimensions(
    maximum_dimension: int,
    projected_bounds: tuple[float, float, float, float],
) -> tuple[int, int]:
    """Fit the selected maximum edge to a projected map rectangle's aspect.

    Args:
        maximum_dimension: Positive server-owned grid edge resolution.
        projected_bounds: Ordered finite EPSG:3857 map rectangle.

    Returns:
        Positive height and width whose longest edge equals the selected
        resolution and whose shorter edge follows the rectangle aspect ratio.
    """
    dimension = _odd_dimension(maximum_dimension)
    west, south, east, north = projected_bounds
    projected_width = east - west
    projected_height = north - south
    if projected_width >= projected_height:
        return (
            max(1, round(dimension * projected_height / projected_width)),
            dimension,
        )
    return (
        dimension,
        max(1, round(dimension * projected_width / projected_height)),
    )


def _projected_cell_positions(
    dataset: rasterio.io.DatasetReader,
    projected_bounds: tuple[float, float, float, float],
    sample_grid_width: int,
    sample_grid_height: int,
) -> tuple[tuple[SourcePosition, ...], ...]:
    """Transform map-cell centers into honest source-pixel positions.

    Positions outside a rotated/skewed raster remain absent instead of being
    clamped to an edge pixel.

    Args:
        dataset: Open source with a valid CRS and invertible affine transform.
        projected_bounds: Ordered EPSG:3857 sampling rectangle.
        sample_grid_width: Positive sample-grid width in map-aligned cells.
        sample_grid_height: Positive sample-grid height in map-aligned cells.

    Returns:
        One row-major source position for every map cell; cells outside the
        raster contain an empty tuple.

    Raises:
        ValueError: If transformation yields a non-finite position or the
            source affine transform is not invertible.
        rasterio.errors.RasterioError: If CRS transformation fails.
    """
    west, south, east, north = projected_bounds
    cell_width = (east - west) / sample_grid_width
    cell_height = (north - south) / sample_grid_height
    row_fraction, column_fraction = SAMPLE_GRID_CENTER_OFFSETS[0]
    projected_x: list[float] = []
    projected_y: list[float] = []
    for sample_grid_row in range(sample_grid_height):
        cell_north = north - sample_grid_row * cell_height
        for sample_grid_column in range(sample_grid_width):
            cell_west = west + sample_grid_column * cell_width
            projected_x.append(cell_west + column_fraction * cell_width)
            projected_y.append(cell_north - row_fraction * cell_height)

    source_x, source_y = warp_transform(
        "EPSG:3857",
        dataset.crs,
        projected_x,
        projected_y,
    )
    try:
        inverse_transform = ~dataset.transform
    except TransformNotInvertibleError:
        raise ValueError("Sampled raster affine transform is not invertible") from None
    transformed_positions: list[SourcePosition | None] = []
    for x, y in zip(source_x, source_y, strict=True):
        if not math.isfinite(x) or not math.isfinite(y):
            raise ValueError("Sampled raster position transformation is non-finite")
        column_position, row_position = inverse_transform * (x, y)
        if not math.isfinite(column_position) or not math.isfinite(row_position):
            raise ValueError("Sampled raster pixel transformation is non-finite")
        row = math.floor(row_position)
        column = math.floor(column_position)
        transformed_positions.append(
            (row, column)
            if 0 <= row < dataset.height and 0 <= column < dataset.width
            else None
        )

    cells: list[tuple[SourcePosition, ...]] = []
    for position in transformed_positions:
        if position is None:
            cells.append(())
        else:
            cells.append((position,))
    return tuple(cells)


def _block_index(
    position: SourcePosition,
    block_shape: tuple[int, int],
) -> SourceBlockIndex:
    """Return the native block containing one source position.

    Args:
        position: Source row and column.
        block_shape: Native block height and width.

    Returns:
        Native block row and column indexes.
    """
    row, column = position
    block_height, block_width = block_shape
    return row // block_height, column // block_width


def _plan_for_dimension(
    dataset: rasterio.io.DatasetReader,
    maximum_dimension: int,
    projected_bounds: tuple[float, float, float, float] | None,
) -> SampleGridPlan:
    """Build one candidate plan and calculate its exact native-block cost.

    Args:
        dataset: Open one-band source raster.
        maximum_dimension: Maximum sample-grid edge for this candidate.
        projected_bounds: Optional EPSG:3857 map rectangle. ``None`` retains
            the direct source-grid planner used by lower-level callers.

    Returns:
        Candidate plan with unique block indexes and decoded-byte cost.

    Raises:
        ValueError: If a projected position is invalid or the source affine
            transform is not invertible.
        rasterio.errors.RasterioError: If CRS transformation fails.
    """
    if projected_bounds is None:
        sample_grid_height, sample_grid_width = _sample_grid_dimensions(
            dataset.width,
            dataset.height,
            maximum_dimension,
        )
        positions = _cell_positions(
            dataset.width,
            dataset.height,
            sample_grid_width,
            sample_grid_height,
        )
    else:
        sample_grid_height, sample_grid_width = _projected_sample_grid_dimensions(
            maximum_dimension,
            projected_bounds,
        )
        positions = _projected_cell_positions(
            dataset,
            projected_bounds,
            sample_grid_width,
            sample_grid_height,
        )
    block_shape = tuple(int(value) for value in dataset.block_shapes[0])
    block_indexes = tuple(sorted({
        _block_index(position, block_shape)
        for cell in positions
        for position in cell
    }))
    decoded_source_bytes = decoded_source_bytes_for_blocks(
        dataset,
        block_indexes,
    )
    return SampleGridPlan(
        width=sample_grid_width,
        height=sample_grid_height,
        cell_positions=positions,
        block_indexes=block_indexes,
        decoded_source_bytes=decoded_source_bytes,
        points_per_cell=SAMPLE_GRID_MAX_POINTS_PER_CELL,
    )


def plan_source_window_sample_grid(
    dataset: rasterio.io.DatasetReader,
    source_window: Window,
) -> SampleGridPlan:
    """Plan a fixed center grid inside one bounded source-pixel window.

    This is the rendering-independent sibling of the projected map-grid
    planner. It uses the same native-block and decoded-work ceilings while
    retaining source-window aspect ratio.

    Args:
        dataset: Open structurally authorized one-band raster.
        source_window: Positive integral window wholly inside the source.

    Returns:
        Fixed longest-edge grid and its exact native-block work proof.

    Raises:
        ValueError: If the source/window contract is invalid or the fixed grid
            exceeds a source-work limit.
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
    if not all(math.isfinite(value) and value.is_integer() for value in numeric_window):
        raise ValueError("Raster analysis source window must be integral")
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
        raise ValueError("Raster analysis source window is outside the source")

    sample_height, sample_width = _sample_grid_dimensions(
        width,
        height,
        min(SAMPLE_GRID_MAX_DIMENSION, max(width, height)),
    )
    positions = _source_window_cell_positions(
        source_window,
        sample_width,
        sample_height,
    )
    return plan_sample_grid_for_source_positions(
        dataset,
        sample_width,
        sample_height,
        positions,
    )


def plan_sample_grid(
    dataset: rasterio.io.DatasetReader,
    projected_bounds: tuple[float, float, float, float] | None = None,
) -> SampleGridPlan:
    """Plan the fixed 127-longest-edge center grid before source reads.

    Args:
        dataset: Open structurally authorized one-band raster.
        projected_bounds: Optional ordered EPSG:3857 target rectangle.

    Returns:
        Fixed longest-edge grid whose unique native blocks and total
        decoded work stay within the fixed public limits.

    Raises:
        ValueError: If the raster violates the sample-grid contract or the fixed grid
            exceeds a source-work limit.
        rasterio.errors.RasterioError: If CRS transformation fails.
    """
    require_bounded_source_structure(dataset)
    if projected_bounds is not None and not (
        all(math.isfinite(value) for value in projected_bounds)
        and projected_bounds[0] < projected_bounds[2]
        and projected_bounds[1] < projected_bounds[3]
    ):
        raise ValueError("Sampled raster projected bounds are invalid")

    dimension = _odd_dimension(
        SAMPLE_GRID_MAX_DIMENSION
        if projected_bounds is not None
        else min(SAMPLE_GRID_MAX_DIMENSION, max(dataset.width, dataset.height))
    )
    plan = _plan_for_dimension(dataset, dimension, projected_bounds)
    block_count = len(plan.block_indexes)
    if block_count > SAMPLE_GRID_MAX_SOURCE_BLOCK_READS:
        raise ValueError(
            f"The selected {plan.width} by {plan.height} sample grid requires "
            f"{block_count} native source blocks; the fixed limit is "
            f"{SAMPLE_GRID_MAX_SOURCE_BLOCK_READS}. Zoom farther into the "
            "raster."
        )
    if plan.decoded_source_bytes > SAMPLE_GRID_MAX_DECODED_SOURCE_BYTES:
        raise ValueError(
            f"The selected {plan.width} by {plan.height} sample grid requires "
            f"{plan.decoded_source_bytes} decoded source bytes; the fixed "
            f"limit is {SAMPLE_GRID_MAX_DECODED_SOURCE_BYTES}. Zoom farther "
            "into the raster."
        )
    return plan


def _finite_block_value(
    block: numpy.ma.MaskedArray,
    row: int,
    column: int,
) -> float | None:
    """Return one honest finite value from an already-read native block.

    Args:
        block: Masked native block pixels.
        row: Zero-based row inside ``block``.
        column: Zero-based column inside ``block``.

    Returns:
        Finite float, or ``None`` for masked/non-finite data.
    """
    value = block[row, column]
    if numpy.ma.is_masked(value):
        return None
    finite_value = float(value)
    return finite_value if math.isfinite(finite_value) else None


def plan_sample_grid_for_source_positions(
    dataset: rasterio.io.DatasetReader,
    width: int,
    height: int,
    cell_positions: tuple[tuple[SourcePosition, ...], ...],
) -> SampleGridPlan:
    """Admit an explicit bounded grid of source-pixel positions.

    The caller owns the spatial meaning of the positions. This neutral
    boundary validates only grid shape, source containment, native-block work,
    and decoded-byte limits before any source read occurs.

    Args:
        dataset: Open structurally authorized one-band raster.
        width: Positive output-grid width no larger than the fixed limit.
        height: Positive output-grid height no larger than the fixed limit.
        cell_positions: Row-major source positions, with an empty tuple for a
            cell outside the source.

    Returns:
        Admitted immutable sample-grid plan.

    Raises:
        ValueError: If shape, positions, or source-work limits are invalid.
    """
    require_bounded_source_structure(dataset)
    if (
        not isinstance(width, int)
        or isinstance(width, bool)
        or not isinstance(height, int)
        or isinstance(height, bool)
        or width < 1
        or height < 1
        or width > SAMPLE_GRID_MAX_DIMENSION
        or height > SAMPLE_GRID_MAX_DIMENSION
        or len(cell_positions) != width * height
    ):
        raise ValueError("Raster sample-grid dimensions are invalid")
    for cell in cell_positions:
        if len(cell) > SAMPLE_GRID_MAX_POINTS_PER_CELL:
            raise ValueError("Raster sample-grid cell exceeds its point limit")
        for row, column in cell:
            if (
                not isinstance(row, int)
                or isinstance(row, bool)
                or not isinstance(column, int)
                or isinstance(column, bool)
                or row < 0
                or row >= dataset.height
                or column < 0
                or column >= dataset.width
            ):
                raise ValueError("Raster sample-grid position is outside the source")

    block_shape = tuple(int(value) for value in dataset.block_shapes[0])
    block_indexes = tuple(sorted({
        _block_index(position, block_shape)
        for cell in cell_positions
        for position in cell
    }))
    decoded_source_bytes = decoded_source_bytes_for_blocks(
        dataset,
        block_indexes,
    )
    if len(block_indexes) > SAMPLE_GRID_MAX_SOURCE_BLOCK_READS:
        raise ValueError(
            "The raster analysis sample grid exceeds the native source-block "
            "limit"
        )
    if decoded_source_bytes > SAMPLE_GRID_MAX_DECODED_SOURCE_BYTES:
        raise ValueError(
            "The raster analysis sample grid exceeds the decoded source-work "
            "limit"
        )
    return SampleGridPlan(
        width=width,
        height=height,
        cell_positions=cell_positions,
        block_indexes=block_indexes,
        decoded_source_bytes=decoded_source_bytes,
        points_per_cell=SAMPLE_GRID_MAX_POINTS_PER_CELL,
    )


def read_planned_sample_grid(
    dataset: rasterio.io.DatasetReader,
    plan: SampleGridPlan,
    cancellation_requested: RasterReadCancellationCheck | None,
) -> numpy.ma.MaskedArray:
    """Read one owned plan a native block at a time.

    The planner owns structural validation and work admission. This reader
    checks cancellation around every native-block read and never opens or
    closes the dataset.

    Args:
        dataset: Open source used to build ``plan``.
        plan: Admitted immutable sample-grid plan.
        cancellation_requested: Optional thread-safe obsolescence predicate.

    Returns:
        Masked sample-grid values.

    Raises:
        RasterReadCancelled: If every request waiter disconnects.
        rasterio.errors.RasterioError: If a bounded native-block read fails.
    """
    require_active_raster_read(cancellation_requested)
    block_shape = tuple(int(value) for value in dataset.block_shapes[0])
    positions_by_block: dict[SourceBlockIndex, set[SourcePosition]] = {}
    for position in {
        position
        for cell in plan.cell_positions
        for position in cell
    }:
        positions_by_block.setdefault(
            _block_index(position, block_shape),
            set(),
        ).add(position)

    sampled_values: dict[SourcePosition, float | None] = {}
    for block_row, block_column in plan.block_indexes:
        require_active_raster_read(cancellation_requested)
        window = dataset.block_window(1, block_row, block_column)
        block = read_native_raster_block(dataset, window)
        require_active_raster_read(cancellation_requested)
        row_offset = int(window.row_off)
        column_offset = int(window.col_off)
        for row, column in sorted(positions_by_block[(block_row, block_column)]):
            sampled_values[(row, column)] = _finite_block_value(
                block,
                row - row_offset,
                column - column_offset,
            )

    values = numpy.zeros((plan.height, plan.width), dtype=numpy.float64)
    mask = numpy.ones(values.shape, dtype=bool)
    for cell_index, positions in enumerate(plan.cell_positions):
        if not positions:
            continue
        selected = sampled_values[positions[0]]
        if selected is None:
            continue
        sample_grid_row, sample_grid_column = divmod(cell_index, plan.width)
        values[sample_grid_row, sample_grid_column] = selected
        mask[sample_grid_row, sample_grid_column] = False
    return numpy.ma.array(values, mask=mask)


def read_sample_grid(
    dataset: rasterio.io.DatasetReader,
    projected_bounds: tuple[float, float, float, float] | None = None,
    cancellation_requested: RasterReadCancellationCheck | None = None,
) -> tuple[numpy.ma.MaskedArray, SampleGridPlan]:
    """Read a projected or whole-source fixed center grid within work bounds.

    Args:
        dataset: Open structurally authorized one-band raster.
        projected_bounds: Optional EPSG:3857 target rectangle.
        cancellation_requested: Optional thread-safe obsolescence predicate.

    Returns:
        Masked sample-grid values and the exact bounded plan that produced them.

    Raises:
        ValueError: If planning cannot satisfy the fixed source-read contract.
        RasterReadCancelled: If every request waiter disconnects.
        rasterio.errors.RasterioError: If a bounded native-block read fails.
    """
    plan = plan_sample_grid(dataset, projected_bounds)
    return (
        read_planned_sample_grid(dataset, plan, cancellation_requested),
        plan,
    )


def read_source_window_sample_grid(
    dataset: rasterio.io.DatasetReader,
    source_window: Window,
    cancellation_requested: RasterReadCancellationCheck | None = None,
) -> tuple[numpy.ma.MaskedArray, SampleGridPlan]:
    """Read a fixed center grid from one bounded source-pixel window.

    Args:
        dataset: Open structurally authorized one-band raster.
        source_window: Positive integral source window wholly inside the raster.
        cancellation_requested: Optional thread-safe obsolescence predicate.

    Returns:
        Masked source-aligned sample values and their admitted work plan.

    Raises:
        ValueError: If planning cannot satisfy the fixed source-read contract.
        RasterReadCancelled: If every request waiter disconnects.
        rasterio.errors.RasterioError: If a bounded native-block read fails.
    """
    plan = plan_source_window_sample_grid(dataset, source_window)
    return (
        read_planned_sample_grid(dataset, plan, cancellation_requested),
        plan,
    )
