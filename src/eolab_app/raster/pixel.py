"""Synchronous Rasterio boundary for bounded pixel reads."""

import math
from pathlib import Path

import rasterio
from rasterio.warp import transform
from rasterio.windows import Window

from eolab_app.raster.models import RasterPixel
from eolab_app.raster.source_contract import (
    read_native_raster_window,
    require_pixel_source_structure,
    require_raster_analysis_georeferencing,
    require_signed_raster_dependencies,
)

def read_raster_pixel(
    source_path: Path,
    longitude: float,
    latitude: float,
) -> RasterPixel:
    """Read one band-1 pixel at a WGS 84 position.

    Args:
        source_path: Authorized original GeoTIFF, retained by the caller.
        longitude: WGS 84 longitude.
        latitude: WGS 84 latitude.

    Returns:
        Sample value and source cell, or an out-of-bounds response.

    Raises:
        OSError: If the source cannot be read.
        rasterio.errors.RasterioError: If GDAL cannot open or sample it.
        ValueError: If its structure, file dependencies or georeferencing cannot
            support a bounded band-one pixel read.
    """
    with (
        rasterio.Env(GDAL_CACHEMAX=32 * 1024**2),
        rasterio.open(source_path, driver="GTiff") as dataset,
    ):
        require_signed_raster_dependencies(dataset, source_path)
        require_raster_analysis_georeferencing(dataset)
        require_pixel_source_structure(dataset)
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

        sample = read_native_raster_window(dataset, Window(column, row, 1, 1))
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
