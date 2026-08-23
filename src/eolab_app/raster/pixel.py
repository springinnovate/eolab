"""Synchronous Rasterio boundary for bounded pixel reads."""

import math
from pathlib import Path

import numpy
import rasterio
from rasterio.warp import transform
from rasterio.windows import Window

from eolab_app.raster.detail_preview import _require_signed_geotiff_dependencies
from eolab_app.raster.detail_proxy import (
    _read_native_block,
    _require_source_contract,
)
from eolab_app.raster.models import RasterPixel


def read_raster_pixel(
    source_path: Path,
    longitude: float,
    latitude: float,
) -> RasterPixel:
    """Read one band-1 pixel at a WGS 84 position.

    Args:
        source_path: Authorized mounted GeoTIFF.
        longitude: WGS 84 longitude.
        latitude: WGS 84 latitude.

    Returns:
        Sample value and source cell, or an out-of-bounds response.

    Raises:
        OSError: If the source cannot be read.
        rasterio.errors.RasterioError: If GDAL cannot open or sample it.
        ValueError: If its coordinate reference system cannot transform the
            requested position.
    """
    with rasterio.open(source_path) as dataset:
        x_coordinates, y_coordinates = transform(
            "EPSG:4326",
            dataset.crs,
            [longitude],
            [latitude],
        )
        if not all(
            math.isfinite(coordinate)
            for coordinate in (x_coordinates[0], y_coordinates[0])
        ):
            return RasterPixel(
                longitude=longitude,
                latitude=latitude,
                row=None,
                column=None,
                inBounds=False,
                value=None,
            )
        row, column = dataset.index(x_coordinates[0], y_coordinates[0])
        if not (0 <= row < dataset.height and 0 <= column < dataset.width):
            return RasterPixel(
                longitude=longitude,
                latitude=latitude,
                row=None,
                column=None,
                inBounds=False,
                value=None,
            )

        sample = dataset.read(
            1,
            window=Window(column, row, 1, 1),
            masked=True,
        )
        value = None if sample.count() == 0 else float(sample[0, 0])
        if value is not None and not math.isfinite(value):
            value = None
        return RasterPixel(
            longitude=longitude,
            latitude=latitude,
            row=row,
            column=column,
            inBounds=True,
            value=value,
        )


def read_raster_detail_pixel(
    source_path: Path,
    longitude: float,
    latitude: float,
) -> RasterPixel:
    """Read one detail-only band-1 pixel under the signed source contract.

    The reader opens the authorized GeoTIFF once, transforms one WGS 84
    position, and reads the containing native block exactly once. Validity is
    derived only from embedded nodata metadata, matching adaptive previews and
    preventing unsigned mask sidecars from influencing the response.

    Args:
        source_path: Authorized mounted overview-limited GeoTIFF.
        longitude: WGS 84 longitude.
        latitude: WGS 84 latitude.

    Returns:
        Honest source cell and value, including nodata or out-of-bounds state.

    Raises:
        OSError: If the source cannot be read.
        rasterio.errors.RasterioError: If GDAL cannot open, transform, or read
            the raster.
        ValueError: If signed dependencies, band/validity structure, or CRS
            metadata violate the detail-only contract.
    """
    with rasterio.open(source_path) as dataset:
        _require_signed_geotiff_dependencies(dataset, source_path)
        _require_source_contract(dataset)
        x_coordinates, y_coordinates = transform(
            "EPSG:4326",
            dataset.crs,
            [longitude],
            [latitude],
        )
        if not all(
            math.isfinite(coordinate)
            for coordinate in (x_coordinates[0], y_coordinates[0])
        ):
            return RasterPixel(
                longitude=longitude,
                latitude=latitude,
                row=None,
                column=None,
                inBounds=False,
                value=None,
            )
        row, column = dataset.index(x_coordinates[0], y_coordinates[0])
        if not (0 <= row < dataset.height and 0 <= column < dataset.width):
            return RasterPixel(
                longitude=longitude,
                latitude=latitude,
                row=None,
                column=None,
                inBounds=False,
                value=None,
            )

        block_height, block_width = dataset.block_shapes[0]
        block_row = row // block_height
        block_column = column // block_width
        block_window = dataset.block_window(1, block_row, block_column)
        block = _read_native_block(dataset, block_window)
        observed = block[
            row - int(block_window.row_off),
            column - int(block_window.col_off),
        ]
        value = None if numpy.ma.is_masked(observed) else float(observed)
        if value is not None and not math.isfinite(value):
            value = None
        return RasterPixel(
            longitude=longitude,
            latitude=latitude,
            row=row,
            column=column,
            inBounds=True,
            value=value,
        )
