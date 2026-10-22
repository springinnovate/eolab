"""Exercise native ERA5 window reads through real sharded Zarr stores."""

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy
import pytest
import zarr
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
    return TemporalObservation(tmp_path, path, 0, time, time, time, time)


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
