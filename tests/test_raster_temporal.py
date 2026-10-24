"""Read temporal GeoTIFFs through native window and cancellation contracts."""

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy
import pytest
import rasterio
from affine import Affine
from rasterio.crs import CRS
from rasterio.windows import Window

from eolab_app.raster.read_cancellation import RasterReadCancelled
from eolab_app.raster.temporal import (
    TemporalObservation,
    TemporalRasterDataset,
    iter_temporal_windows,
)


@pytest.fixture
def observation(tmp_path: Path) -> TemporalObservation:
    """Write three global observations in their published longitude order.

    Args:
        tmp_path: Isolated archive directory.

    Returns:
        First observation with populated polar rows and NoData elsewhere.
    """
    transform = Affine(0.25, 0, -180.125, 0, -0.25, 90.125)
    for index in range(3):
        values = numpy.full((721, 1440), numpy.nan, dtype="float32")
        values[:2] = numpy.arange(1440)[None, :] + index * 2000
        with rasterio.open(
            tmp_path / f"temperature_{index}.tif",
            "w",
            driver="GTiff",
            height=721,
            width=1440,
            count=1,
            dtype="float32",
            crs="EPSG:4326",
            transform=transform,
            nodata=numpy.nan,
            tiled=True,
            blockxsize=32,
            blockysize=32,
            compress="deflate",
        ) as target:
            target.write(values, 1)
    time = datetime(2000, 1, 1, tzinfo=timezone.utc)
    return TemporalObservation(
        root=tmp_path,
        path=tmp_path / "temperature_0.tif",
        time=time,
        reference_time=time,
        interval_start=time,
        interval_end=time,
        transform=transform,
        crs=CRS.from_epsg(4326),
        nodata=numpy.nan,
        cyclic_x=True,
    )


def test_read_preserves_published_column_order(
    observation: TemporalObservation,
) -> None:
    """Read published values unchanged and wrap equivalent point longitudes.

    Args:
        observation: Global GeoTIFF with distinct column values.
    """
    with TemporalRasterDataset(observation) as dataset:
        numpy.testing.assert_array_equal(
            dataset.read(1, window=Window(718, 0, 4, 2)), [[718, 719, 720, 721]] * 2
        )
        assert dataset.index(-180, 90) == dataset.index(180, 90) == (0, 0)
        assert dataset.index(0, 90) == (0, 720)
        assert dataset.maximum_decoded_block_bytes == 32 * 32 * 5
        assert dataset.read(1, window=Window(0, 50, 1, 1), masked=True).mask.all()


@pytest.mark.parametrize("missing", [True, False])
def test_unreadable_observation_reports_native_failure(
    observation: TemporalObservation, missing: bool
) -> None:
    """Expose missing and corrupt TIFFs as actual source-read failures.

    Args:
        observation: Published observation to make unreadable.
        missing: Whether to remove the file or replace it with invalid bytes.
    """
    if missing:
        observation.path.unlink()
    else:
        observation.path.write_bytes(b"invalid TIFF")
    with pytest.raises(rasterio.errors.RasterioError):
        with TemporalRasterDataset(observation):
            pass


def test_interval_iterator_keeps_time_support_and_native_values(
    observation: TemporalObservation,
) -> None:
    """Stream selected observations and blocks with their exact interval metadata.

    Args:
        observation: First global observation.
    """
    later = observation.time + timedelta(hours=2)
    second = replace(
        observation,
        path=observation.root / "temperature_2.tif",
        time=later,
        reference_time=observation.time,
        interval_start=later - timedelta(hours=1),
        interval_end=later,
    )
    blocks = list(iter_temporal_windows((observation, second), Window(734, 0, 4, 1)))
    assert [item[0] for item in blocks] == [observation, observation, second, second]
    assert [item[1] for item in blocks[:2]] == [
        Window(734, 0, 2, 1),
        Window(736, 0, 2, 1),
    ]
    numpy.testing.assert_array_equal(blocks[0][2], [[734, 735]])
    numpy.testing.assert_array_equal(blocks[3][2], [[4736, 4737]])


def test_interval_iterator_preserves_budget_and_cancellation(
    observation: TemporalObservation,
) -> None:
    """Bound interactive work and honor cancellation between native TIFF reads.

    Args:
        observation: First global observation.
    """
    with TemporalRasterDataset(observation) as dataset:
        limit = dataset.maximum_decoded_block_bytes
    blocks = iter_temporal_windows(
        (observation,), Window(734, 0, 4, 1), maximum_decoded_bytes=limit
    )
    next(blocks)
    with pytest.raises(ValueError, match="decoded-work limit"):
        next(blocks)
    with pytest.raises(RasterReadCancelled):
        next(iter_temporal_windows((observation,), Window(0, 0, 1, 1), lambda: True))
    assert len(list(iter_temporal_windows((observation,), Window(734, 0, 4, 1)))) == 2


@pytest.mark.parametrize(
    "dtype,nodata,row_step",
    [
        ("int16", -9999, -30),
        ("int16", None, -30),
        ("float64", -9999, 30),
    ],
)
def test_read_uses_admitted_regional_grid_and_validity(
    tmp_path: Path, dtype: str, nodata: int | None, row_step: int
) -> None:
    """Preserve projected grids, numeric precision, row order and validity.

    Args:
        tmp_path: Isolated archive directory.
        dtype: Original numeric data type.
        nodata: Explicit invalid value, or None.
        row_step: Signed distance between consecutive rows.
    """
    path = tmp_path / "annual_index.tif"
    transform = Affine(30, 0, 500000, 0, row_step, 4100000)
    values = numpy.zeros((5, 10), dtype=dtype)
    values[0, :5] = [0, 1, -9999, 3, 4]
    if dtype == "float64":
        values[0, 3:5] = [numpy.nan, numpy.inf]
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=5,
        width=10,
        count=1,
        dtype=dtype,
        crs="EPSG:32632",
        transform=transform,
        nodata=nodata,
    ) as target:
        target.write(values, 1)
    time = datetime(2023, 7, 15, tzinfo=timezone.utc)
    selected = TemporalObservation(
        root=tmp_path,
        path=path,
        time=time,
        reference_time=None,
        interval_start=time - timedelta(days=1),
        interval_end=time,
        transform=transform,
        crs=CRS.from_epsg(32632),
        nodata=nodata,
    )
    with TemporalRasterDataset(selected) as dataset:
        assert dataset.dtypes == (dtype,)
        assert dataset.index(499985, 4100000 + row_step / 2) == (0, -1)
        actual = dataset.read(1, window=Window(0, 0, 5, 1), masked=True)
        numpy.testing.assert_array_equal(actual.data, values[:1, :5])
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
        assert not dataset.read(1, window=Window(8, 4, 2, 1), masked=True).mask.any()


def test_cyclic_view_preserves_embedded_mask_and_edge_cells(
    observation: TemporalObservation,
) -> None:
    """Rotate data and embedded validity together across a partial edge block.

    Args:
        observation: Source time metadata reused for a small global TIFF.
    """
    path = observation.root / "small.tif"
    transform = Affine(36, 0, -180, 0, -30, 90)
    with rasterio.Env(GDAL_TIFF_INTERNAL_MASK=True):
        with rasterio.open(
            path,
            "w",
            driver="GTiff",
            height=3,
            width=10,
            count=1,
            dtype="int16",
            crs="EPSG:4326",
            transform=transform,
            tiled=True,
            blockxsize=16,
            blockysize=16,
        ) as target:
            target.write(numpy.tile(numpy.arange(10, dtype="int16"), (3, 1)), 1)
            mask = numpy.full((3, 10), 255, dtype="uint8")
            mask[:, 2] = 0
            target.write_mask(mask)
    selected = replace(observation, path=path, transform=transform, nodata=None)
    with TemporalRasterDataset(selected) as dataset:
        dataset.prepare_column_view(3)
        actual = dataset.read(1, window=Window(6, 0, 4, 1), masked=True)
        numpy.testing.assert_array_equal(actual.data, [[9, 0, 1, 2]])
        numpy.testing.assert_array_equal(actual.mask, [[False, False, False, True]])
