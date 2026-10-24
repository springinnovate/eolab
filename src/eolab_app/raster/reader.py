"""Open an authorized file or selected observation for the ordinary raster readers."""

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import TypeAlias

import rasterio

from eolab_app.raster.temporal import TemporalObservation, TemporalRasterDataset

RasterData: TypeAlias = Path | TemporalObservation
RasterDataset: TypeAlias = rasterio.io.DatasetReader | TemporalRasterDataset


@contextmanager
def open_raster_data(source: RasterData) -> Iterator[RasterDataset]:
    """Open one authorized raster file or temporal observation without resampling it.

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
        with rasterio.open(source) as dataset:
            yield dataset
