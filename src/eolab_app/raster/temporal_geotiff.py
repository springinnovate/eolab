"""Write selected temporal observations as GeoTIFFs for raster publication."""

from pathlib import Path

import numpy
import rasterio
import zarr

from eolab_app.raster.geographic_bounds import (
    normalize_wgs84_bounds,
    transform_bounds_to_wgs84,
)
from eolab_app.raster.temporal import (
    TemporalObservation,
    TemporalRasterDataset,
)


def write_temporal_geotiff(
    observation: TemporalObservation, path: Path
) -> tuple[float, float, float, float]:
    """Write one native observation and return its geographic publication bounds.

    Read one output tile at a time through the temporal reader, preserving the
    selected observation's native grid, dtype and NoData value. An internal mask
    also marks nonfinite cells invalid. The caller owns the output directory,
    execution limits and removal of partial or expired files. Run this writer in
    a fresh worker process; its four Zarr worker threads fit the publication worker's
    address-space budget.

    Args:
        observation: Admitted variable and time selection to publish.
        path: Destination GeoTIFF in a directory prepared by the caller.

    Returns:
        Canonical west, south, east and north bounds in WGS84 degrees.

    Raises:
        ValueError: If native metadata, decoding or geographic bounds are invalid.
        OSError: If source reads or output writes fail.
        rasterio.errors.RasterioError: If GDAL cannot create or write the GeoTIFF.
    """
    with (
        zarr.config.set({"threading.max_workers": 4}),
        TemporalRasterDataset(observation) as source,
    ):
        bounds = normalize_wgs84_bounds(
            transform_bounds_to_wgs84(source.crs, tuple(source.bounds))
        )
        with rasterio.Env(GDAL_TIFF_INTERNAL_MASK=True):
            with rasterio.open(
                path,
                "w",
                driver="GTiff",
                width=source.width,
                height=source.height,
                count=1,
                dtype=source.dtypes[0],
                crs=source.crs,
                transform=source.transform,
                nodata=source.nodata,
                tiled=True,
                blockxsize=256,
                blockysize=256,
                compress="DEFLATE",
            ) as destination:
                for _, window in destination.block_windows(1):
                    values = source.read(1, window=window, masked=True)
                    destination.write(values.data, 1, window=window)
                    destination.write_mask(
                        (~numpy.ma.getmaskarray(values)).astype("uint8") * 255,
                        window=window,
                    )
    return bounds
