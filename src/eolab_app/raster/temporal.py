"""Read native cells from admitted ERA5 observations without loading a cube."""

import math
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from types import TracebackType
from typing import Self

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


@dataclass(frozen=True)
class TemporalObservation:
    """Identify an admitted variable observation and its physical time support.

    Attributes:
        root: Authorized archive directory that confines every source read.
        array_path: Monthly variable array inside that archive.
        time_index: Observation position in the monthly time coordinate.
        time: UTC observation label used by public selections.
        reference_time: UTC forecast origin recorded by the producer.
        interval_start: Beginning of the observation's physical support.
        interval_end: End of its support; equals start for an instant.
    """

    root: Path
    array_path: Path
    time_index: int
    time: datetime
    reference_time: datetime
    interval_start: datetime
    interval_end: datetime


class _ConfinedStore(LocalStore):
    """Read Zarr keys only when their resolved files stay in the archive."""

    def __init__(self, array_path: Path, archive_root: Path) -> None:
        """Open a read-only store inside an already authorized archive.

        Args:
            array_path: Monthly variable array to read.
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
    """Expose one ERA5 observation to the ordinary native raster readers.

    The virtual grid rotates the producer's longitude columns by 720 cells,
    giving cell centers from -180 to 179.75 degrees without resampling. Its
    logical blocks never cross a physical chunk boundary after the rotation.
    Source work includes the complete monthly temporal chunk needed by Zarr.
    """

    count: int = 1
    width: int = 1440
    height: int = 721
    dtypes: tuple[str, ...] = ("float32",)
    mask_flag_enums: tuple[list[MaskFlags], ...] = ([MaskFlags.nodata],)
    nodata: float = float("nan")
    nodatavals: tuple[float, ...] = (nodata,)
    transform: Affine = Affine(0.25, 0, -180.125, 0, -0.25, 90.125)
    crs: CRS = CRS.from_epsg(4326)
    bounds: BoundingBox = BoundingBox(-180.125, -90.125, 179.875, 90.125)

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
        _, height, width = self._array.chunks
        self.block_shapes = ((height, math.gcd(width, 720)),)

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
        """Return monthly chunk bytes plus the returned values and validity."""
        return math.prod(self._array.chunks) * self._array.dtype.itemsize + math.prod(
            self.block_shapes[0]
        ) * (self._array.dtype.itemsize + 1)

    def native_work_for_blocks(
        self, block_indexes: tuple[tuple[int, int], ...]
    ) -> tuple[int, int]:
        """Charge every logical block for its full monthly chunk decode.

        Adjacent logical blocks can touch the same physical chunk, but no cache
        hit is assumed. Reading both blocks therefore counts both decodes.

        Args:
            block_indexes: Logical row and column indexes to read separately.

        Returns:
            Physical chunk read count and cumulative decoded bytes.
        """
        return len(block_indexes), len(block_indexes) * self.maximum_decoded_block_bytes

    def index(self, x: float, y: float) -> tuple[int, int]:
        """Return the native row and column containing a geographic point.

        Args:
            x: Longitude in degrees; equivalent turns address the same cell.
            y: Latitude in degrees.

        Returns:
            Integer row and column, with an out-of-range row beyond the poles.
        """
        longitude = (x + 180.125) % 360 - 180.125
        column, row = ~self.transform * (longitude, y)
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
    ) -> NDArray[numpy.float32] | numpy.ma.MaskedArray:
        """Read a caller-admitted native window at the selected observation.

        Args:
            band: The established single band, 1.
            window: Integral window within the virtual raster.
            masked: Whether to mask nonfinite cells in the returned values.

        Returns:
            Two-dimensional native values in west-to-east column order.

        Raises:
            ValueError: If a shard is corrupt or escapes the archive.
            OSError: If the actual source read fails.
        """
        rows, columns = window.toslices()
        start = (columns.start + 720) % self.width
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
        return numpy.ma.masked_invalid(values, copy=False) if masked else values


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
