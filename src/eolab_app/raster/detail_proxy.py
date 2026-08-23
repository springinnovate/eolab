"""Provably bounded native-block sampling for map-aligned raster proxies."""

import math
from dataclasses import dataclass
from typing import Literal

import numpy
import rasterio
from affine import TransformNotInvertibleError
from rasterio.enums import MaskFlags
from rasterio.warp import transform as warp_transform
from rasterio.windows import Window

from eolab_app.raster.models import RasterDetailPreviewDensity


DETAIL_PROXY_MAX_DIMENSION = 127
DETAIL_PROXY_DENSITY_MAXIMUM_DIMENSIONS: dict[
    RasterDetailPreviewDensity,
    int,
] = {
    "coarse": 31,
    "medium": 63,
    "fine": DETAIL_PROXY_MAX_DIMENSION,
}
# One exact center-sample grid can require one distinct native block per cell.
# The independent decoded-work ceiling below remains the controlling bound for
# large blocks and prevents this count from authorizing unbounded source work.
DETAIL_PROXY_MAX_SOURCE_BLOCK_READS = (
    DETAIL_PROXY_MAX_DIMENSION * DETAIL_PROXY_MAX_DIMENSION
)
# The reader streams one structurally bounded native block at a time. This
# cumulative-work ceiling is 9 GiB and is not a simultaneous-memory allocation.
# It accommodates all 16,129 center samples for common 256-by-256 float64
# blocks while retaining an explicit byte bound for larger native blocks and
# representative sampling.
DETAIL_PROXY_MAX_DECODED_SOURCE_BYTES = 9 * 1024 * 1024 * 1024
DETAIL_PATCH_MAX_DECODED_SOURCE_BYTES = 64 * 1024 * 1024
DETAIL_PROXY_CENTER_OFFSETS = ((0.5, 0.5),)
DETAIL_PROXY_REPRESENTATIVE_OFFSETS = (
    (0.5, 0.5),
    (0.25, 0.25),
    (0.75, 0.25),
    (0.25, 0.75),
    (0.75, 0.75),
)
DETAIL_PROXY_MAX_POINTS_PER_CELL = len(DETAIL_PROXY_REPRESENTATIVE_OFFSETS)
# One exact fine grid with the representative policy transforms at most five
# positions in each of 127 by 127 cells.
DETAIL_PROXY_MAX_TRANSFORMED_POSITIONS = (
    DETAIL_PROXY_MAX_DIMENSION
    * DETAIL_PROXY_MAX_DIMENSION
    * DETAIL_PROXY_MAX_POINTS_PER_CELL
)
DetailProxyMode = Literal["centerSample", "representativeSample"]
SourcePosition = tuple[int, int]
SourceBlockIndex = tuple[int, int]


def detail_proxy_maximum_dimension(
    density: RasterDetailPreviewDensity,
) -> int:
    """Return the server-owned exact grid edge for one density profile.

    Args:
        density: Validated coarse, medium, or fine profile.

    Returns:
        Fixed exact grid edge for the selected profile.

    Raises:
        ValueError: If a caller bypasses request validation with an unknown
            density value.
    """
    try:
        return DETAIL_PROXY_DENSITY_MAXIMUM_DIMENSIONS[density]
    except KeyError:
        raise ValueError(f"Unsupported sampled raster density: {density}") from None


def _require_source_contract(
    dataset: rasterio.io.DatasetReader,
) -> None:
    """Require one non-empty band with independently bounded validity.

    The proxy reads only band-one native blocks and derives a validity array
    from the signed band's nodata value. Alpha and per-dataset masks are
    rejected because their native block structure is not owned by this
    sampling contract.

    Args:
        dataset: Open candidate raster dataset.

    Returns:
        None when the source satisfies the bounded sampling contract.

    Raises:
        ValueError: If band, block, or validity structure is unsupported.
    """
    if dataset.count != 1 or dataset.width < 1 or dataset.height < 1:
        raise ValueError("Sampled raster proxy requires one non-empty band")
    if not dataset.block_shapes or len(dataset.block_shapes[0]) != 2:
        raise ValueError("Sampled raster proxy requires native block metadata")
    mask_flags = set(dataset.mask_flag_enums[0])
    if not mask_flags.issubset({MaskFlags.all_valid, MaskFlags.nodata}):
        raise ValueError(
            "Sampled raster preview does not support alpha or per-dataset "
            "validity masks"
        )


def _read_native_block(
    dataset: rasterio.io.DatasetReader,
    window: Window,
) -> numpy.ma.MaskedArray:
    """Read one exact band block and derive validity without mask I/O.

    Args:
        dataset: Open source whose validity contract is established.
        window: Exact integral native band-one block window.

    Returns:
        Source values masked only by the signed band's nodata metadata.

    Raises:
        rasterio.errors.RasterioError: If the bounded band read fails.
    """
    values = dataset.read(1, window=window, masked=False)
    nodata = dataset.nodatavals[0]
    if nodata is None:
        mask = numpy.zeros(values.shape, dtype=bool)
    elif math.isnan(float(nodata)):
        mask = numpy.isnan(values)
    else:
        mask = values == nodata
    return numpy.ma.array(values, mask=mask)


@dataclass(frozen=True)
class DetailProxyPlan:
    """Immutable source sampling plan that satisfies the native-block budget.

    Attributes:
        width: Number of proxy cells across the source raster.
        height: Number of proxy cells down the source raster.
        cell_positions: Row-major source positions inspected for every cell.
        block_indexes: Unique native band-one blocks in row-major order.
        decoded_source_bytes: Conservative band-plus-validity decoded bytes in
            those block windows.
        points_per_cell: Maximum configured positions for each proxy cell.
    """

    width: int
    height: int
    cell_positions: tuple[tuple[SourcePosition, ...], ...]
    block_indexes: tuple[SourceBlockIndex, ...]
    decoded_source_bytes: int
    points_per_cell: int


@dataclass(frozen=True)
class BoundedWindowSamples:
    """Native-block-coalesced source windows under the shared decode budget.

    Attributes:
        samples: Accepted windows paired with reconstructed masked values.
        block_indexes: Unique native blocks read exactly once.
        decoded_source_bytes: Conservative band-plus-validity decoded bytes.
    """

    samples: tuple[tuple[Window, numpy.ma.MaskedArray], ...]
    block_indexes: tuple[SourceBlockIndex, ...]
    decoded_source_bytes: int


def _odd_dimension(limit: int) -> int:
    """Return the greatest positive odd integer no larger than ``limit``.

    Args:
        limit: Positive dimension ceiling.

    Returns:
        Greatest positive odd integer within the ceiling.
    """
    return limit if limit % 2 == 1 else max(1, limit - 1)


def _proxy_dimensions(
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
        Proxy height and width.
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
    proxy_width: int,
    proxy_height: int,
    offsets: tuple[tuple[float, float], ...],
) -> tuple[tuple[SourcePosition, ...], ...]:
    """Map every proxy cell to a fixed set of unique source positions.

    Args:
        source_width: Positive source width in pixels.
        source_height: Positive source height in pixels.
        proxy_width: Positive proxy width in cells.
        proxy_height: Positive proxy height in cells.
        offsets: Column/row fractions sampled inside every proxy cell.

    Returns:
        Row-major source positions for every proxy cell.
    """
    cells: list[tuple[SourcePosition, ...]] = []
    for proxy_row in range(proxy_height):
        row_start = math.floor(proxy_row * source_height / proxy_height)
        row_stop = max(
            row_start + 1,
            math.floor((proxy_row + 1) * source_height / proxy_height),
        )
        for proxy_column in range(proxy_width):
            column_start = math.floor(
                proxy_column * source_width / proxy_width
            )
            column_stop = max(
                column_start + 1,
                math.floor((proxy_column + 1) * source_width / proxy_width),
            )
            positions: list[SourcePosition] = []
            for column_fraction, row_fraction in offsets:
                position = (
                    _position_in_cell(row_start, row_stop, row_fraction),
                    _position_in_cell(
                        column_start,
                        column_stop,
                        column_fraction,
                    ),
                )
                if position not in positions:
                    positions.append(position)
            cells.append(tuple(positions))
    return tuple(cells)


def _projected_proxy_dimensions(
    maximum_dimension: int,
) -> tuple[int, int]:
    """Return the exact square grid selected for a projected map rectangle.

    Args:
        maximum_dimension: Positive server-owned grid edge resolution.

    Returns:
        Equal proxy height and width at the selected resolution.
    """
    dimension = _odd_dimension(maximum_dimension)
    return dimension, dimension


def _projected_cell_positions(
    dataset: rasterio.io.DatasetReader,
    projected_bounds: tuple[float, float, float, float],
    proxy_width: int,
    proxy_height: int,
    offsets: tuple[tuple[float, float], ...],
) -> tuple[tuple[SourcePosition, ...], ...]:
    """Transform fixed map-cell probes into honest source-pixel positions.

    Positions outside a rotated/skewed raster remain absent instead of being
    clamped to an edge pixel. Duplicate positions inside a cell are removed
    while preserving the configured probe order.

    Args:
        dataset: Open source with a valid CRS and invertible affine transform.
        projected_bounds: Ordered EPSG:3857 sampling rectangle.
        proxy_width: Positive proxy width in map-aligned cells.
        proxy_height: Positive proxy height in map-aligned cells.
        offsets: Column/row fractions sampled inside every proxy cell.

    Returns:
        Row-major source positions for every map cell; cells outside the
        raster contain an empty tuple.

    Raises:
        ValueError: If transformation yields a non-finite position or the
            source affine transform is not invertible.
        rasterio.errors.RasterioError: If CRS transformation fails.
    """
    west, south, east, north = projected_bounds
    cell_width = (east - west) / proxy_width
    cell_height = (north - south) / proxy_height
    projected_x: list[float] = []
    projected_y: list[float] = []
    for proxy_row in range(proxy_height):
        cell_north = north - proxy_row * cell_height
        for proxy_column in range(proxy_width):
            cell_west = west + proxy_column * cell_width
            for column_fraction, row_fraction in offsets:
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

    points_per_cell = len(offsets)
    cells: list[tuple[SourcePosition, ...]] = []
    for cell_index in range(proxy_width * proxy_height):
        positions: list[SourcePosition] = []
        start = cell_index * points_per_cell
        for position in transformed_positions[start:start + points_per_cell]:
            if position is not None and position not in positions:
                positions.append(position)
        cells.append(tuple(positions))
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


def _decoded_bytes_for_blocks(
    dataset: rasterio.io.DatasetReader,
    block_indexes: tuple[SourceBlockIndex, ...],
) -> int:
    """Estimate decoded band-one and validity bytes for native blocks.

    The extra byte per pixel conservatively accounts for the in-memory
    validity array derived from nodata in addition to the band-one data type.

    Args:
        dataset: Open one-band raster with native block metadata.
        block_indexes: Unique native block row/column indexes.

    Returns:
        Conservative decoded byte total for the supplied blocks.
    """
    bytes_per_pixel = numpy.dtype(dataset.dtypes[0]).itemsize + 1
    return sum(
        int(window.width) * int(window.height) * bytes_per_pixel
        for window in (
            dataset.block_window(1, block_row, block_column)
            for block_row, block_column in block_indexes
        )
    )


def _plan_for_dimension(
    dataset: rasterio.io.DatasetReader,
    maximum_dimension: int,
    offsets: tuple[tuple[float, float], ...],
    projected_bounds: tuple[float, float, float, float] | None,
) -> DetailProxyPlan:
    """Build one candidate plan and calculate its exact native-block cost.

    Args:
        dataset: Open one-band source raster.
        maximum_dimension: Maximum proxy edge for this candidate.
        offsets: Fixed probe pattern used inside each proxy cell.
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
        proxy_height, proxy_width = _proxy_dimensions(
            dataset.width,
            dataset.height,
            maximum_dimension,
        )
        positions = _cell_positions(
            dataset.width,
            dataset.height,
            proxy_width,
            proxy_height,
            offsets,
        )
    else:
        proxy_height, proxy_width = _projected_proxy_dimensions(
            maximum_dimension,
        )
        positions = _projected_cell_positions(
            dataset,
            projected_bounds,
            proxy_width,
            proxy_height,
            offsets,
        )
    block_shape = tuple(int(value) for value in dataset.block_shapes[0])
    block_indexes = tuple(sorted({
        _block_index(position, block_shape)
        for cell in positions
        for position in cell
    }))
    decoded_source_bytes = _decoded_bytes_for_blocks(
        dataset,
        block_indexes,
    )
    return DetailProxyPlan(
        width=proxy_width,
        height=proxy_height,
        cell_positions=positions,
        block_indexes=block_indexes,
        decoded_source_bytes=decoded_source_bytes,
        points_per_cell=len(offsets),
    )


def plan_detail_proxy(
    dataset: rasterio.io.DatasetReader,
    mode: DetailProxyMode,
    maximum_dimension: int | None = None,
    projected_bounds: tuple[float, float, float, float] | None = None,
) -> DetailProxyPlan:
    """Plan the exact selected grid or reject it before any source read.

    Args:
        dataset: Open structurally authorized one-band raster.
        mode: Center-per-cell or representative-per-cell sampling policy.
        maximum_dimension: Optional positive exact grid edge no larger than
            the public maximum; defaults to that maximum for direct callers.
        projected_bounds: Optional ordered EPSG:3857 target rectangle.

    Returns:
        Exact selected grid whose unique native blocks and total decoded work
        stay within the fixed public limits.

    Raises:
        ValueError: If the raster or mode violates the proxy contract, or the
            exact selected grid exceeds a fixed source-work limit.
        rasterio.errors.RasterioError: If CRS transformation fails.
    """
    _require_source_contract(dataset)
    offsets = {
        "centerSample": DETAIL_PROXY_CENTER_OFFSETS,
        "representativeSample": DETAIL_PROXY_REPRESENTATIVE_OFFSETS,
    }.get(mode)
    if offsets is None:
        raise ValueError(f"Unsupported sampled raster proxy mode: {mode}")
    requested_maximum = (
        DETAIL_PROXY_MAX_DIMENSION
        if maximum_dimension is None
        else maximum_dimension
    )
    if not 1 <= requested_maximum <= DETAIL_PROXY_MAX_DIMENSION:
        raise ValueError("Sampled raster proxy dimension is outside fixed limits")
    if projected_bounds is not None and not (
        all(math.isfinite(value) for value in projected_bounds)
        and projected_bounds[0] < projected_bounds[2]
        and projected_bounds[1] < projected_bounds[3]
    ):
        raise ValueError("Sampled raster projected bounds are invalid")

    dimension = _odd_dimension(
        requested_maximum
        if projected_bounds is not None
        else min(requested_maximum, max(dataset.width, dataset.height))
    )
    plan = _plan_for_dimension(dataset, dimension, offsets, projected_bounds)
    block_count = len(plan.block_indexes)
    if block_count > DETAIL_PROXY_MAX_SOURCE_BLOCK_READS:
        raise ValueError(
            f"The selected {plan.width} by {plan.height} sample grid requires "
            f"{block_count} native source blocks; the fixed limit is "
            f"{DETAIL_PROXY_MAX_SOURCE_BLOCK_READS}. Choose a lower exact "
            "density or zoom farther into the raster."
        )
    if plan.decoded_source_bytes > DETAIL_PROXY_MAX_DECODED_SOURCE_BYTES:
        raise ValueError(
            f"The selected {plan.width} by {plan.height} sample grid requires "
            f"{plan.decoded_source_bytes} decoded source bytes; the fixed "
            f"limit is {DETAIL_PROXY_MAX_DECODED_SOURCE_BYTES}. Choose a "
            "lower exact density or zoom farther into the raster."
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


def _block_indexes_for_window(
    window: Window,
    block_shape: tuple[int, int],
) -> tuple[SourceBlockIndex, ...]:
    """Return every native block intersecting one integral source window.

    Args:
        window: Positive integral source window inside the raster.
        block_shape: Native block height and width.

    Returns:
        Intersecting native block indexes in row-major order.
    """
    block_height, block_width = block_shape
    row_start = int(window.row_off) // block_height
    row_stop = (int(window.row_off + window.height) - 1) // block_height
    column_start = int(window.col_off) // block_width
    column_stop = (int(window.col_off + window.width) - 1) // block_width
    return tuple(
        (block_row, block_column)
        for block_row in range(row_start, row_stop + 1)
        for block_column in range(column_start, column_stop + 1)
    )


def read_bounded_candidate_windows(
    dataset: rasterio.io.DatasetReader,
    windows: list[Window],
) -> BoundedWindowSamples:
    """Read a deterministic candidate subset through unique native blocks.

    Candidate windows are considered in caller order. A candidate is retained
    when the union of native blocks still satisfies both fixed source limits;
    candidates that would exceed either patch ceiling are skipped. Every
    accepted window is reconstructed from the shared native blocks, each read
    exactly once without resampling.

    Args:
        dataset: Open structurally authorized one-band raster.
        windows: Non-empty deterministic integral candidate windows.

    Returns:
        Accepted masked windows plus exact block and decoded-byte work.

    Raises:
        ValueError: If no candidate fits the native-block limits.
        rasterio.errors.RasterioError: If a bounded native-block read fails.
    """
    _require_source_contract(dataset)
    block_shape = tuple(int(value) for value in dataset.block_shapes[0])
    accepted: list[Window] = []
    accepted_blocks: set[SourceBlockIndex] = set()
    decoded_source_bytes = 0
    for window in windows:
        proposed_blocks = accepted_blocks | set(
            _block_indexes_for_window(window, block_shape)
        )
        proposed_indexes = tuple(sorted(proposed_blocks))
        proposed_bytes = _decoded_bytes_for_blocks(dataset, proposed_indexes)
        if (
            len(proposed_indexes) > DETAIL_PROXY_MAX_SOURCE_BLOCK_READS
            or proposed_bytes > DETAIL_PATCH_MAX_DECODED_SOURCE_BYTES
        ):
            continue
        accepted.append(window)
        accepted_blocks = proposed_blocks
        decoded_source_bytes = proposed_bytes
    if not accepted:
        raise ValueError("No detail-patch candidate fits source-read limits")

    block_indexes = tuple(sorted(accepted_blocks))
    blocks: dict[SourceBlockIndex, tuple[Window, numpy.ma.MaskedArray]] = {}
    for block_index in block_indexes:
        block_window = dataset.block_window(1, *block_index)
        blocks[block_index] = (
            block_window,
            _read_native_block(dataset, block_window),
        )

    samples: list[tuple[Window, numpy.ma.MaskedArray]] = []
    for window in accepted:
        sample = numpy.ma.masked_all(
            (int(window.height), int(window.width)),
            dtype=numpy.dtype(dataset.dtypes[0]),
        )
        window_row_start = int(window.row_off)
        window_column_start = int(window.col_off)
        window_row_stop = window_row_start + int(window.height)
        window_column_stop = window_column_start + int(window.width)
        for block_index in _block_indexes_for_window(window, block_shape):
            block_window, block = blocks[block_index]
            block_row_start = int(block_window.row_off)
            block_column_start = int(block_window.col_off)
            row_start = max(window_row_start, block_row_start)
            column_start = max(window_column_start, block_column_start)
            row_stop = min(
                window_row_stop,
                block_row_start + int(block_window.height),
            )
            column_stop = min(
                window_column_stop,
                block_column_start + int(block_window.width),
            )
            sample[
                row_start - window_row_start:row_stop - window_row_start,
                column_start - window_column_start:column_stop - window_column_start,
            ] = block[
                row_start - block_row_start:row_stop - block_row_start,
                column_start - block_column_start:column_stop - block_column_start,
            ]
        samples.append((window, sample))
    return BoundedWindowSamples(
        samples=tuple(samples),
        block_indexes=block_indexes,
        decoded_source_bytes=decoded_source_bytes,
    )


def read_detail_proxy(
    dataset: rasterio.io.DatasetReader,
    mode: DetailProxyMode,
    maximum_dimension: int | None = None,
    projected_bounds: tuple[float, float, float, float] | None = None,
) -> tuple[numpy.ma.MaskedArray, DetailProxyPlan]:
    """Read each planned native block once and build a numeric proxy raster.

    Representative cells choose the lower median observed finite value after
    ordering by value, source row, and source column. No averaging invents a
    source value. Nodata-only cells remain masked.

    Args:
        dataset: Open structurally authorized one-band raster.
        mode: Center-per-cell or representative-per-cell sampling policy.
        maximum_dimension: Optional fixed target-grid edge. Projected preview
            grids use it exactly on both axes.
        projected_bounds: Optional EPSG:3857 target rectangle.

    Returns:
        Masked proxy values and the exact bounded plan that produced them.

    Raises:
        ValueError: If planning cannot satisfy the fixed source-read contract.
        rasterio.errors.RasterioError: If a bounded native-block read fails.
    """
    plan = plan_detail_proxy(
        dataset,
        mode,
        maximum_dimension,
        projected_bounds,
    )
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
        window = dataset.block_window(1, block_row, block_column)
        block = _read_native_block(dataset, window)
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
        candidates = sorted(
            (
                (value, row, column)
                for row, column in positions
                if (value := sampled_values[(row, column)]) is not None
            ),
            key=lambda candidate: candidate,
        )
        if not candidates:
            continue
        selected = candidates[(len(candidates) - 1) // 2][0]
        proxy_row, proxy_column = divmod(cell_index, plan.width)
        values[proxy_row, proxy_column] = selected
        mask[proxy_row, proxy_column] = False
    return numpy.ma.array(values, mask=mask), plan
