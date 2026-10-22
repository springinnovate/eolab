"""Exercise native time-stack window reads through real Zarr stores."""

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy
import pytest
import zarr
from affine import Affine
from rasterio.crs import CRS
from rasterio.windows import Window
from zarr.abc.store import ByteRequest
from zarr.codecs import ZstdCodec
from zarr.core.buffer import Buffer, BufferPrototype

from eolab_app.raster.read_cancellation import RasterReadCancelled
from eolab_app.raster.temporal import (
    TemporalObservation,
    TemporalRasterDataset,
    iter_temporal_windows,
)


@pytest.fixture
def observation(tmp_path: Path) -> TemporalObservation:
    """Create three sparse observations using the producer's native codecs.

    Args:
        tmp_path: Isolated archive directory.

    Returns:
        First observation with populated north-pole rows and NaN elsewhere.
    """
    path = tmp_path / "2000/01/era5.zarr/temperature"
    array = zarr.create_array(
        path,
        shape=(3, 721, 1440),
        chunks=(3, 32, 32),
        shards=(3, 64, 64),
        dtype="float32",
        fill_value=numpy.nan,
        compressors=[ZstdCodec(level=3, checksum=True)],
    )
    for time_index in range(3):
        array[time_index, :2, :] = (
            numpy.arange(1440, dtype="float32")[None, :] + time_index * 2000
        )
    time = datetime(2000, 1, 1, tzinfo=timezone.utc)
    return TemporalObservation(
        root=tmp_path,
        array_path=path,
        time_index=0,
        time=time,
        reference_time=time,
        interval_start=time,
        interval_end=time,
        transform=Affine(0.25, 0, -180.125, 0, -0.25, 90.125),
        crs=CRS.from_epsg(4326),
        nodata=numpy.nan,
        column_offset=720,
        cyclic_x=True,
    )


def test_read_rotates_native_cells_without_resampling(
    observation: TemporalObservation,
) -> None:
    """Preserve source values across the producer's zero-longitude seam.

    Args:
        observation: Real sharded fixture.
    """
    with TemporalRasterDataset(observation) as dataset:
        actual = dataset.read(1, window=Window(718, 0, 4, 2))
        numpy.testing.assert_array_equal(actual, [[1438, 1439, 0, 1]] * 2)
        assert dataset.index(-180, 90) == (0, 0)
        assert dataset.index(180, 90) == (0, 0)
        assert dataset.index(0, 90) == (0, 720)
        assert dataset.overviews(1) == []
        assert dataset.block_window(1, 22, 89) == Window(1424, 704, 16, 17)
        assert dataset.maximum_decoded_block_bytes == 3 * 32 * 32 * 4 + 32 * 16 * 5
        assert dataset.native_work_for_blocks(((0, 44), (0, 45))) == (
            2,
            2 * dataset.maximum_decoded_block_bytes,
        )


def test_read_opens_only_requested_shard_ranges(
    observation: TemporalObservation, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Decode only one spatial chunk when a small window selects one time.

    Args:
        observation: Real sharded fixture.
        monkeypatch: Instrument native source reads without replacing decoding.
    """
    import zarr.storage._local as local

    reads: list[tuple[str, object]] = []
    original_get = local._get

    def record_read(
        path: Path, prototype: BufferPrototype, byte_range: ByteRequest | None
    ) -> Buffer:
        """Record one actual native read and return its unchanged bytes.

        Args:
            path: Source member opened by Zarr.
            prototype: Requested buffer implementation.
            byte_range: Selected shard bytes, or None for metadata.

        Returns:
            Bytes returned by the real local storage reader.
        """
        reads.append((path.relative_to(observation.array_path).as_posix(), byte_range))
        return original_get(path, prototype, byte_range)

    monkeypatch.setattr(local, "_get", record_read)
    with TemporalRasterDataset(observation) as dataset:
        assert [key for key, _ in reads] == ["zarr.json"]
        reads.clear()
        numpy.testing.assert_array_equal(
            dataset.read(1, window=Window(0, 0, 2, 1)), [[720, 721]]
        )
    assert {key for key, _ in reads} == {"c/0/0/11"}
    assert all(byte_range is not None for _, byte_range in reads)


def test_fill_values_and_corrupt_shards_keep_native_error_semantics(
    observation: TemporalObservation,
) -> None:
    """Return sparse NaN cells but expose corrupt-shard read failures.

    Args:
        observation: Real sharded fixture.
    """
    with TemporalRasterDataset(observation) as dataset:
        assert dataset.read(1, window=Window(0, 50, 1, 1), masked=True).mask.all()
        assert dataset.read(1, window=Window(0, 100, 1, 1), masked=True).mask.all()
    (observation.array_path / "c/0/0/11").write_bytes(b"bad")
    with TemporalRasterDataset(observation) as dataset:
        with pytest.raises(ValueError, match="truncated or corrupt"):
            dataset.read(1, window=Window(0, 0, 1, 1))


def test_source_members_cannot_escape_archive(
    observation: TemporalObservation, tmp_path: Path
) -> None:
    """Reject an array outside its authorized archive before reading metadata.

    Args:
        observation: Real sharded fixture.
        tmp_path: Isolated test directory.
    """
    with pytest.raises(ValueError, match="outside its archive"):
        TemporalRasterDataset(replace(observation, root=tmp_path / "other-archive"))


def test_shard_symlink_cannot_escape_archive(
    observation: TemporalObservation, tmp_path: Path
) -> None:
    """Confine the actual shard as well as the admitted array directory.

    Args:
        observation: Real sharded fixture.
        tmp_path: Isolated test directory.
    """
    shard = observation.array_path / "c/0/0/11"
    outside = tmp_path.parent / f"{tmp_path.name}-outside-shard"
    outside.write_bytes(shard.read_bytes())
    shard.unlink()
    try:
        shard.symlink_to(outside)
    except OSError:
        pytest.skip("Creating a symlink requires Windows developer privileges")
    with TemporalRasterDataset(observation) as dataset:
        with pytest.raises(ValueError, match="outside its archive"):
            dataset.read(1, window=Window(0, 0, 1, 1))


def test_interval_iterator_keeps_time_support_and_native_values(
    observation: TemporalObservation,
) -> None:
    """Stream selected observations and spatial blocks without reducing time.

    Args:
        observation: Real sharded fixture.
    """
    later = observation.time + timedelta(hours=2)
    second = replace(
        observation,
        time_index=2,
        time=later,
        reference_time=observation.time,
        interval_start=later - timedelta(hours=1),
        interval_end=later,
    )
    blocks = list(iter_temporal_windows((observation, second), Window(718, 0, 4, 1)))
    assert [item[0] for item in blocks] == [observation, observation, second, second]
    assert [item[1] for item in blocks[:2]] == [
        Window(718, 0, 2, 1),
        Window(720, 0, 2, 1),
    ]
    numpy.testing.assert_array_equal(blocks[0][2], [[1438, 1439]])
    numpy.testing.assert_array_equal(blocks[3][2], [[4000, 4001]])
    assert not blocks[1][2].mask.any()  # Zero is a valid native value.


def test_interval_iterator_preserves_budget_and_cancellation(
    observation: TemporalObservation,
) -> None:
    """Bound interactive work while allowing explicit unlimited calculations.

    Args:
        observation: Real sharded fixture.
    """
    with TemporalRasterDataset(observation) as dataset:
        limit = dataset.maximum_decoded_block_bytes
    blocks = iter_temporal_windows(
        (observation,), Window(718, 0, 4, 1), maximum_decoded_bytes=limit
    )
    next(blocks)
    with pytest.raises(ValueError, match="decoded-work limit"):
        next(blocks)
    with pytest.raises(RasterReadCancelled):
        next(iter_temporal_windows((observation,), Window(0, 0, 1, 1), lambda: True))


def test_corrupt_compressed_chunk_becomes_source_read_error(
    observation: TemporalObservation,
) -> None:
    """Translate decoder failures while keeping a valid shard index intact.

    Args:
        observation: Real sharded fixture containing compressed weather values.
    """
    shard = observation.array_path / "c/0/0/11"
    content = bytearray(shard.read_bytes())
    content[:4] = b"bad!"
    shard.write_bytes(content)
    with TemporalRasterDataset(observation) as dataset:
        with pytest.raises(OSError, match="chunk could not be decoded") as failure:
            dataset.read(1, window=Window(0, 0, 1, 1))
    assert isinstance(failure.value.__cause__, RuntimeError)


@pytest.mark.parametrize(
    ("dtype", "nodata", "row_step"),
    [("int16", -9999, -30), ("int16", None, -30), ("float64", -9999, 30)],
)
def test_read_uses_admitted_regional_grid_and_validity(
    tmp_path: Path, dtype: str, nodata: int | None, row_step: int
) -> None:
    """Read projected, non-forecast observations with native dtype and row order.

    Args:
        tmp_path: Isolated archive directory.
        dtype: Native numeric type, independent of the ERA5 fixture.
        nodata: Declared invalid value, distinct from the storage fill of zero.
        row_step: Positive or negative Y distance between successive source rows.
    """
    path = tmp_path / "measurements.zarr/annual_index"
    array = zarr.create_array(
        path, shape=(2, 5, 10), chunks=(2, 3, 4), dtype=dtype, fill_value=0
    )
    values = numpy.array([[0, 1, -9999, 3, 4]], dtype=dtype)
    if dtype == "float64":
        values[0, 3:] = [numpy.nan, numpy.inf]
    array[1, :1, :5] = values
    time = datetime(2023, 7, 15, tzinfo=timezone.utc)
    selected = TemporalObservation(
        root=tmp_path,
        array_path=path,
        time_index=1,
        time=time,
        reference_time=None,
        interval_start=time - timedelta(days=1),
        interval_end=time,
        transform=Affine(30, 0, 500000, 0, row_step, 4100000),
        crs=CRS.from_epsg(32632),
        nodata=nodata,
    )
    with TemporalRasterDataset(selected) as dataset:
        assert (dataset.width, dataset.height) == (10, 5)
        assert dataset.dtypes == (dtype,)
        assert dataset.crs == CRS.from_epsg(32632)
        assert dataset.bounds == (
            500000,
            min(4100000, 4100000 + 5 * row_step),
            500300,
            max(4100000, 4100000 + 5 * row_step),
        )
        assert dataset.index(500015, 4100000 + row_step / 2) == (0, 0)
        assert dataset.index(499985, 4100000 + row_step / 2) == (0, -1)
        assert dataset.index(500015, 4100000 + row_step * 5.5) == (5, 0)
        assert dataset.block_window(1, 1, 2) == Window(8, 3, 2, 2)
        itemsize = numpy.dtype(dtype).itemsize
        assert dataset.maximum_decoded_block_bytes == (
            2 * 3 * 4 * itemsize + 3 * 4 * (itemsize + 1)
        )
        actual = dataset.read(1, window=Window(0, 0, 5, 1), masked=True)
        numpy.testing.assert_array_equal(actual.data, values)
        numpy.testing.assert_array_equal(
            actual.mask,
            [
                [
                    False,
                    False,
                    nodata is not None,
                    dtype == "float64",
                    dtype == "float64",
                ]
            ],
        )
        # Missing Zarr chunks fill with zero, which is valid for this source.
        sparse = dataset.read(1, window=Window(8, 4, 2, 1), masked=True)
        numpy.testing.assert_array_equal(sparse, [[0, 0]])
        assert not sparse.mask.any()


def test_rotated_grid_keeps_blocks_inside_partial_edge_chunks(
    observation: TemporalObservation,
) -> None:
    """Preserve values and chunk costs when width is not a multiple of chunk size.

    Args:
        observation: Source identity and time metadata to use with a smaller grid.
    """
    path = observation.root / "small.zarr/index"
    array = zarr.create_array(
        path, shape=(2, 3, 10), chunks=(2, 2, 4), dtype="int16", fill_value=-9999
    )
    array[0, 0, :] = numpy.arange(10, dtype="int16")
    array[0, 0, 2] = -9999
    selected = replace(
        observation,
        array_path=path,
        transform=Affine(36, 0, -180, 0, -30, 90),
        column_offset=3,
        nodata=-9999,
        reference_time=None,
    )
    with TemporalRasterDataset(selected) as dataset:
        assert dataset.block_shapes == ((2, 1),)
        assert dataset.index(-162, 75) == dataset.index(198, 75) == (0, 0)
        assert dataset.maximum_decoded_block_bytes == 2 * 2 * 4 * 2 + 2 * 1 * 3
        assert dataset.native_work_for_blocks(((0, 6), (0, 7), (0, 8), (0, 9))) == (
            4,
            4 * dataset.maximum_decoded_block_bytes,
        )
        actual = dataset.read(1, window=Window(6, 0, 4, 1), masked=True)
        numpy.testing.assert_array_equal(actual.data, [[9, 0, 1, -9999]])
        numpy.testing.assert_array_equal(actual.mask, [[False, False, False, True]])
    blocks = list(iter_temporal_windows((selected,), Window(6, 0, 4, 1)))
    assert [block for _, block, _ in blocks] == [
        Window(column, 0, 1, 1) for column in range(6, 10)
    ]
    numpy.testing.assert_array_equal(
        numpy.ma.concatenate([values for _, _, values in blocks], axis=1).data,
        actual.data,
    )
