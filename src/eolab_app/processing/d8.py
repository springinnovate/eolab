"""Read elevations and build D8 flow graphs for Processing calculations."""

from typing import TYPE_CHECKING

import numpy
from numpy.typing import NDArray
from rasterio.transform import Affine

from eolab_app.raster.reader import RasterDataset
from eolab_app.raster.source_contract import read_native_raster_block

if TYPE_CHECKING:
    from pyflwdir import FlwdirRaster


def read_d8_elevations(
    dataset: RasterDataset,
) -> NDArray[numpy.float32 | numpy.float64]:
    """Read native elevation values on the DEM grid, with missing cells set to NaN.

    Args:
        dataset: Open, validated single-band DEM with its original validity mask.

    Returns:
        An elevation array in the source's vertical units. Use Float32 when the
        native storage type fits and Float64 for wider types.

    Raises:
        rasterio.errors.RasterioError: If a native elevation or mask read fails.
    """
    dtype = numpy.result_type(dataset.dtypes[0], numpy.float32)
    elevations = numpy.empty((dataset.height, dataset.width), dtype=dtype)
    for _, window in dataset.block_windows(1):
        values = read_native_raster_block(dataset, window)
        elevations[window.toslices()] = values.astype(dtype, copy=False).filled(
            numpy.nan
        )
    return elevations


def build_d8_flow_graph(
    elevations: NDArray[numpy.float32 | numpy.float64],
    transform: Affine,
    *,
    latlon: bool,
) -> "FlwdirRaster":
    """Build a PyFlwDir D8 graph for tracing and terrain analysis on the DEM grid.

    Depressions fill to their spill elevation. Raster edges and the edges of
    missing cells can drain out of the grid.

    Args:
        elevations: Native elevation array with NaN in missing cells.
        transform: Pixel-to-map transform of the elevation array.
        latlon: True for longitude and latitude in degrees. PyFlwDir assumes
            metres for distance and area calculations on a projected grid.

    Returns:
        A flow graph aligned to the elevation array, usable with that array for
        height above drainage and floodplain calculations.

    Raises:
        ValueError: If PyFlwDir cannot construct a flow graph for the elevations.
    """
    from pyflwdir import from_dem

    return from_dem(
        elevations,
        nodata=numpy.nan,
        max_depth=-1.0,
        transform=transform,
        latlon=latlon,
        outlets="edge",
    )
