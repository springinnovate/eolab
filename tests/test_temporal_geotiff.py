"""Verify temporal publication preserves native cells and validity in GeoTIFFs."""

from dataclasses import replace
from pathlib import Path

import numpy
import pytest
import rasterio
import zarr
from affine import Affine
from rasterio.crs import CRS
from rasterio.enums import Compression, MaskFlags
from rasterio.warp import transform_bounds

from eolab_app.raster.temporal import TemporalObservation
from eolab_app.raster.temporal_geotiff import write_temporal_geotiff
from test_raster_temporal import observation


def test_write_selected_observation_preserves_rotated_native_cells(
    observation: TemporalObservation, tmp_path: Path
) -> None:
    """Publish exactly one native global frame without changing its Zarr source.

    Args:
        observation: Real sharded archive with three distinguishable observations.
        tmp_path: Isolated output directory.
    """
    source_files = {
        path.relative_to(observation.array_path): path.read_bytes()
        for path in observation.array_path.rglob("*")
        if path.is_file()
    }
    path = tmp_path / "selected.tif"
    bounds = write_temporal_geotiff(replace(observation, time_index=1), path)

    assert bounds == (-180, -90, 180, 90)
    with rasterio.open(path) as dataset:
        assert dataset.shape == (721, 1440)
        assert dataset.count == 1
        assert dataset.dtypes == ("float32",)
        assert dataset.transform == observation.transform
        assert dataset.crs == observation.crs
        assert numpy.isnan(dataset.nodata)
        assert dataset.block_shapes == [(256, 256)]
        assert dataset.compression == Compression.deflate
        assert dataset.mask_flag_enums == ([MaskFlags.per_dataset],)
        values = dataset.read(1, masked=True)
        expected = numpy.roll(numpy.arange(1440, dtype="float32"), -720) + 2000
        numpy.testing.assert_array_equal(values.data[:2], numpy.stack((expected,) * 2))
        assert not numpy.ma.getmaskarray(values)[:2].any()
        assert numpy.ma.getmaskarray(values)[2:].all()
        assert numpy.isnan(values.data[2:]).all()
    assert not path.with_suffix(".tif.msk").exists()
    assert source_files == {
        path.relative_to(observation.array_path): path.read_bytes()
        for path in observation.array_path.rglob("*")
        if path.is_file()
    }


@pytest.mark.parametrize("dtype,nodata", [("float64", None), ("int16", -9999)])
def test_write_projected_grid_preserves_dtype_nodata_and_internal_mask(
    observation: TemporalObservation,
    tmp_path: Path,
    dtype: str,
    nodata: int | None,
) -> None:
    """Retain regional grids, finite zeros and invalid cells without a mask sidecar.

    Args:
        observation: Base descriptor whose grid is replaced by a regional source.
        tmp_path: Isolated source and output directory.
        dtype: Native floating-point or integer storage type.
        nodata: Admitted invalid value, or None when all finite values are valid.
    """
    native = numpy.arange(50, dtype=dtype).reshape(5, 10)
    if nodata is None:
        native[0, 1:4] = [numpy.nan, numpy.inf, -numpy.inf]
    else:
        native[0, 1:4] = nodata
    array_path = tmp_path / "regional.zarr"
    zarr.create_array(
        array_path,
        data=numpy.stack((native, native + 100)),
        chunks=(2, 3, 4),
    )
    selected = replace(
        observation,
        array_path=array_path,
        transform=Affine(30, 0, 500000, 0, -30, 4100000),
        crs=CRS.from_epsg(32632),
        nodata=nodata,
        column_offset=0,
        cyclic_x=False,
    )
    path = tmp_path / "regional.tif"
    bounds = write_temporal_geotiff(selected, path)

    with rasterio.open(path) as dataset:
        assert dataset.shape == native.shape
        assert dataset.dtypes == (dtype,)
        assert dataset.nodata == nodata
        assert dataset.crs == selected.crs
        assert dataset.transform == selected.transform
        assert bounds == pytest.approx(
            transform_bounds(dataset.crs, "EPSG:4326", *dataset.bounds)
        )
        actual = dataset.read(1, masked=True)
        numpy.testing.assert_array_equal(actual.data, native)
        expected_mask = numpy.zeros(native.shape, dtype=bool)
        expected_mask[0, 1:4] = True
        numpy.testing.assert_array_equal(numpy.ma.getmaskarray(actual), expected_mask)
        assert actual[0, 0] == 0
        assert dataset.mask_flag_enums == ([MaskFlags.per_dataset],)
    assert not path.with_suffix(".tif.msk").exists()
