"""Open an authorized file or selected observation for the ordinary raster readers."""

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import TypeAlias

import rasterio

from eolab_app.raster.geotiff_crs import GeoTiffReader
from eolab_app.raster.temporal import TemporalObservation, TemporalRasterDataset

RasterData: TypeAlias = Path | TemporalObservation
RasterDataset: TypeAlias = rasterio.io.DatasetReader | TemporalRasterDataset


@contextmanager
def open_raster_data(source: RasterData) -> Iterator[RasterDataset]:
    """Open original cells with their CRS, including the prime meridian's angular unit.

    Args:
        source: Confined GeoTIFF path or a selected, admitted temporal observation.

    Yields:
        Original cells through the two-dimensional interface used by raster readers.

    Raises:
        OSError: If the source cannot be opened.
        ValueError: If native metadata is unsupported.
        rasterio.errors.RasterioError: If the GeoTIFF cannot be opened.
    """
    if isinstance(source, TemporalObservation):
        with TemporalRasterDataset(source) as dataset:
            yield dataset
    else:
        with rasterio.Env(OSR_WKT_FORMAT="WKT2_2019"), GeoTiffReader(source) as dataset:
            yield dataset
