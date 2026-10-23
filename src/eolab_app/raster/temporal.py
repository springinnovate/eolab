"""Read native windows from admitted Zarr time stacks without loading a cube."""

import math
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from types import TracebackType
from typing import Literal, Self

import numpy
import zarr
from affine import Affine
from numpy.typing import NDArray
from rasterio.coords import BoundingBox
from rasterio.crs import CRS
from rasterio.enums import MaskFlags
from rasterio.windows import Window
from zarr.abc.store import ByteRequest
from zarr.core.buffer import Buffer, BufferPrototype
from zarr.storage import LocalStore

from eolab_app.raster.read_cancellation import (
    RasterReadCancellationCheck,
    require_active_raster_read,
)
from eolab_app.raster.source_contract import mask_invalid_raster_values


@dataclass(frozen=True)
class TemporalObservation:
    """Identify an admitted variable observation and its physical time support.

    Attributes:
        root: Authorized archive directory that confines every source read.
        array_path: Numeric Zarr v3 array with axes ordered as time, row, column.
        time_index: Selected position along the array's time axis.
        time: UTC observation label used by public selections.
        reference_time: UTC forecast origin, or None for non-forecast observations.
        interval_start: Beginning of the observation's physical support.
        interval_end: End of its support; equals start for an instant.
        transform: Affine mapping output column/row edges to source CRS coordinates.
        crs: Coordinate reference system of that grid.
        nodata: Invalid cell value, or None when every finite value is valid.
            Zarr's storage fill value is not necessarily NoData.
        column_offset: Source column exposed as output column zero; subsequent
            columns wrap at the array width. It is in [0, width); zero preserves
            source column order.
        cyclic_x: Whether point coordinates repeat across the grid's full width.
            False leaves points outside regional grids out of bounds.
    """

    root: Path
    array_path: Path
    time_index: int
    time: datetime
    reference_time: datetime | None
    interval_start: datetime
    interval_end: datetime
    transform: Affine
    crs: CRS
    nodata: float | int | None
    column_offset: int = 0
    cyclic_x: bool = False


@dataclass(frozen=True)
class ResolvedTemporalInterval:
    """Describe available observations and their admitted variable metadata.

    Attributes:
        observations: Available observations in increasing label order, retaining
            original interval bounds. Missing observations remain absent.
        unit: Unit of the stored values, unchanged from Catalog admission.
        time_support: Whether values describe an instant, a mean rate over an
            interval, or an accumulation over an interval. Calculations use this
            distinction to interpret the values without guessing from names.
    """

    observations: tuple[TemporalObservation, ...]
    unit: str
    time_support: Literal["instantaneous", "mean_rate", "accumulation"]


class _ConfinedStore(LocalStore):
    """Read Zarr keys only when their resolved files stay in the archive."""

    def __init__(self, array_path: Path, archive_root: Path) -> None:
        """Open a read-only store inside an already authorized archive.

        Args:
            array_path: Variable array to read.
            archive_root: Resolved archive directory retained by source access.
        """
        super().__init__(array_path, read_only=True)
        self._archive_root = archive_root

    def _confine_key(self, key: str) -> None:
        """Reject a source key that resolves outside its authorized archive.

        Args:
            key: Metadata or chunk key requested by Zarr.

        Raises:
            ValueError: If a source member escapes through a path or symlink.
        """
        if not (self.root / key).resolve().is_relative_to(self._archive_root):
            raise ValueError("Temporal source member is outside its archive")

    def get_sync(
        self,
        key: str,
        *,
        prototype: BufferPrototype | None = None,
        byte_range: ByteRequest | None = None,
    ) -> Buffer | None:
        """Read one confined metadata file or byte range from a shard.

        Args:
            key: Store-relative source member.
            prototype: Zarr's requested buffer implementation.
            byte_range: Requested portion, or None for the complete member.

        Returns:
            Source bytes, or None for a missing key under Zarr's fill contract.

        Raises:
            ValueError: If the member escapes the archive.
            OSError: If the actual read fails.
        """
        self._confine_key(key)
        return super().get_sync(key, prototype=prototype, byte_range=byte_range)

    async def get(
        self,
        key: str,
        prototype: BufferPrototype | None = None,
        byte_range: ByteRequest | None = None,
    ) -> Buffer | None:
        """Read a confined member through Zarr's asynchronous metadata path.

        Args:
            key: Store-relative source member.
            prototype: Zarr's requested buffer implementation.
            byte_range: Requested portion, or None for the complete member.

        Returns:
            Source bytes, or None for a missing key under Zarr's fill contract.

        Raises:
            ValueError: If the member escapes the archive.
            OSError: If the actual read fails.
        """
        self._confine_key(key)
        return await super().get(key, prototype=prototype, byte_range=byte_range)


class TemporalRasterDataset:
    """Expose one admitted Zarr observation to the native raster readers.

    Arrays have time, row and column axes and a regular affine spatial grid.
    Admission supplies georeferencing, validity and optional column rotation;
    shape, dtype and chunks come from the array. Values retain their native dtype
    without resampling or scale/offset conversion. Logical blocks stay within
    physical chunks, including when columns wrap. Each read charges the full
    temporal chunk that Zarr must decode for the selected observation.
    """

    count: int = 1

    def __init__(self, observation: TemporalObservation) -> None:
        """Open the selected array read-only without loading its pixel values.

        Args:
            observation: Source and time index established by source access.

        Raises:
            ValueError: If native Zarr metadata or source confinement fails.
            OSError: If source metadata cannot be read.
        """
        self._observation = observation
        self._store = _ConfinedStore(observation.array_path, observation.root)
        self._array = zarr.open_array(self._store, mode="r", zarr_format=3)
        _, self.height, self.width = self._array.shape
        self.dtypes = (self._array.dtype.name,)
        self.transform = observation.transform
        self.cyclic_x = observation.cyclic_x
        self._column_offset = observation.column_offset
        self._column_view_prepared = False
        self.crs = observation.crs
        self.nodata = observation.nodata
        self.nodatavals = (self.nodata,)
        self.mask_flag_enums = (
            [MaskFlags.all_valid if self.nodata is None else MaskFlags.nodata],
        )
        self._update_grid_metadata()

    def _update_grid_metadata(self) -> None:
        """Update the view bounds and logical blocks after a column rotation."""
        corners = [
            self.transform * (column, row)
            for column, row in (
                (0, 0),
                (self.width, 0),
                (0, self.height),
                (self.width, self.height),
            )
        ]
        x, y = zip(*corners)
        self.bounds = BoundingBox(min(x), min(y), max(x), max(y))
        height, width = self._array.chunks[1:]
        if self._column_offset:
            width = math.gcd(width, self._column_offset, self.width)
        self.block_shapes = ((height, width),)

    def prepare_column_view(self, first_column: int) -> None:
        """Choose this read handle's column origin before making window plans.

        Rotate a cyclic grid by an integer number of columns without resampling
        or repeating source cells. The first selection owns the view; later
        polygon masks use that same affine and block grid.

        Args:
            first_column: Column in the original view that will become column
                zero. It may lie outside the original period.
        """
        if self._column_view_prepared:
            return
        self._column_view_prepared = True
        self.transform = self.transform * Affine.translation(first_column, 0)
        self._column_offset = (self._column_offset + first_column) % self.width
        self._update_grid_metadata()

    def __enter__(self) -> Self:
        """Return the open observation for a scoped native read."""
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        """Close the store after a read, including when native I/O fails.

        Args:
            exc_type: Active exception type, if the read failed.
            exc_value: Active exception, if any.
            traceback: Active exception traceback, if any.
        """
        self._store.close()

    @property
    def maximum_decoded_block_bytes(self) -> int:
        """Return temporal chunk bytes plus the returned values and validity."""
        return math.prod(self._array.chunks) * self._array.dtype.itemsize + math.prod(
            self.block_shapes[0]
        ) * (self._array.dtype.itemsize + 1)

    def native_work_for_blocks(
        self, block_indexes: tuple[tuple[int, int], ...]
    ) -> tuple[int, int]:
        """Charge every logical block for its full temporal chunk decode.

        Adjacent logical blocks can touch the same physical chunk, but no cache
        hit is assumed. Reading both blocks therefore counts both decodes.

        Args:
            block_indexes: Logical row and column indexes to read separately.

        Returns:
            Physical chunk read count and cumulative decoded bytes.
        """
        return len(block_indexes), len(block_indexes) * self.maximum_decoded_block_bytes

    def index(self, x: float, y: float) -> tuple[int, int]:
        """Return the native row and column containing a point in the source CRS.

        Args:
            x: Horizontal coordinate in the source CRS.
            y: Vertical coordinate in the source CRS.

        Returns:
            Integer row and column. Only cyclic grids wrap columns; other
            coordinates outside the grid retain out-of-range indexes.
        """
        column, row = ~self.transform * (x, y)
        if self.cyclic_x:
            column %= self.width
        return math.floor(row), math.floor(column)

    def block_window(self, band: int, row: int, column: int) -> Window:
        """Return one logical block clipped at the source grid edges.

        Args:
            band: The established single band, 1.
            row: Logical block row.
            column: Logical block column.

        Returns:
            Integral source window wholly inside the virtual raster.
        """
        height, width = self.block_shapes[0]
        y, x = row * height, column * width
        return Window(x, y, min(width, self.width - x), min(height, self.height - y))

    def overviews(self, band: int) -> list[int]:
        """Return no overviews; temporal reads always use original cells.

        Args:
            band: The established single band, 1.

        Returns:
            Empty list, so shared sampling plans select native blocks.
        """
        return []

    def read(
        self, band: int, *, window: Window, masked: bool = False
    ) -> NDArray[numpy.generic] | numpy.ma.MaskedArray:
        """Read a caller-admitted native window at the selected observation.

        Args:
            band: The established single band, 1.
            window: Integral window within the virtual raster.
            masked: Whether to mask nonfinite and declared NoData cells.

        Returns:
            Two-dimensional native values in the admitted output grid order.

        Raises:
            ValueError: If a shard is corrupt or escapes the archive.
            OSError: If the actual source read fails.
        """
        rows, columns = window.toslices()
        start = (columns.start + self._column_offset) % self.width
        stop = start + columns.stop - columns.start
        try:
            values = self._array[
                self._observation.time_index, rows, start : min(stop, self.width)
            ]
            if stop > self.width:
                values = numpy.concatenate(
                    (
                        values,
                        self._array[
                            self._observation.time_index, rows, : stop - self.width
                        ],
                    ),
                    axis=1,
                )
        except RuntimeError as error:
            raise OSError("A temporal data chunk could not be decoded.") from error
        return mask_invalid_raster_values(values, self.nodata) if masked else values


def iter_temporal_windows(
    observations: tuple[TemporalObservation, ...],
    window: Window,
    cancellation_requested: RasterReadCancellationCheck | None = None,
    maximum_decoded_bytes: int | None = None,
) -> Iterator[tuple[TemporalObservation, Window, numpy.ma.MaskedArray]]:
    """Yield native window blocks for selected observations in their given order.

    Callers select exact available observations before entering this reader.
    Each yielded array contains one observation and one spatial block. No
    temporal reduction, resampling or whole-cube allocation occurs.

    Args:
        observations: Admitted observations in the caller's desired order.
        window: Integral virtual-grid window inside the source.
        cancellation_requested: Optional cancellation check between native reads.
        maximum_decoded_bytes: Optional cumulative decoded-work limit. Processing
            passes None to attempt the requested work without a work ceiling.

    Yields:
        Observation metadata, clipped source window and masked native values.

    Raises:
        ValueError: If native decoding fails or the requested read exceeds its budget.
        OSError: If the actual source read fails.
        RasterReadCancelled: If the caller cancels between native reads.
    """
    decoded_bytes = 0
    for observation in observations:
        require_active_raster_read(cancellation_requested)
        with TemporalRasterDataset(observation) as dataset:
            height, width = dataset.block_shapes[0]
            row_start = int(window.row_off) // height
            row_stop = math.ceil((window.row_off + window.height) / height)
            column_start = int(window.col_off) // width
            column_stop = math.ceil((window.col_off + window.width) / width)
            for row in range(row_start, row_stop):
                for column in range(column_start, column_stop):
                    require_active_raster_read(cancellation_requested)
                    decoded_bytes += dataset.maximum_decoded_block_bytes
                    if (
                        maximum_decoded_bytes is not None
                        and decoded_bytes > maximum_decoded_bytes
                    ):
                        raise ValueError("Temporal read exceeds its decoded-work limit")
                    block = dataset.block_window(1, row, column).intersection(window)
                    values = dataset.read(1, window=block, masked=True)
                    require_active_raster_read(cancellation_requested)
                    yield observation, block, values
