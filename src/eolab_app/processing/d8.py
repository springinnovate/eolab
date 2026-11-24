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
    """Read elevations for D8 ordering on the native grid, with missing cells as NaN.

    Args:
        dataset: Open, validated single-band DEM with its original validity mask.

    Returns:
        Stored values with the sign of the band scale applied. This preserves
        downhill ordering without applying a uniform offset or scale magnitude.
        Calculations that need physical heights must read calibrated elevations.

    Raises:
        rasterio.errors.RasterioError: If a native elevation or mask read fails.
    """
    dtype = numpy.result_type(dataset.dtypes[0], numpy.float32)
    reverse_order = dataset.scales[0] < 0
    elevations = numpy.empty((dataset.height, dataset.width), dtype=dtype)
    for _, window in dataset.block_windows(1):
        values = read_native_raster_block(dataset, window)
        block = elevations[window.toslices()]
        block[:] = values.astype(dtype, copy=False).filled(numpy.nan)
        if reverse_order:
            numpy.negative(block, out=block)
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
        elevations: Values ordered by physical elevation, with NaN in missing cells.
        transform: Pixel-to-map transform of the elevation array.
        latlon: True for longitude and latitude in degrees. PyFlwDir assumes
            metres for distance and area calculations on a projected grid.

    Returns:
        A flow graph aligned to the DEM. Use calibrated elevations with this
        graph for height above drainage and floodplain calculations.

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
