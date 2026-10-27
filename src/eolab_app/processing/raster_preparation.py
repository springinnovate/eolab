"""Prepare temporary rasters on one common grid for a Processing calculation."""

from collections.abc import Iterator, Mapping
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from math import ceil, floor
from pathlib import Path
from tempfile import TemporaryDirectory
import time
from xml.etree import ElementTree

from affine import Affine
import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT
from rasterio.windows import Window

from eolab_app.bounded_vector import PolygonRasterizer
from eolab_app.processing.aggregate_models import RasterAggregateLimits
from eolab_app.processing.artifacts import write_progress
from eolab_app.processing.raster_mask import temporary_polygon_mask


@dataclass(frozen=True)
class RasterGrid:
    """Common north-up pixel grid for all inputs to a calculation.

    Attributes:
        crs: Coordinate system shared by the rasters and projected AOI.
        transform: Pixel-to-coordinate affine transform, including grid origin.
        width: Number of columns covering the AOI.
        height: Number of rows covering the AOI.
    """

    crs: CRS
    transform: Affine
    width: int
    height: int


def calculate_raster_grid(
    bounds: tuple[float, float, float, float],
    crs: CRS,
    pixel_size: tuple[float, float],
    origin: tuple[float, float],
) -> RasterGrid:
    """Snap an AOI's bounds outward onto the requested north-up grid.

    Args:
        bounds: Nonempty AOI bounds (left, bottom, right, top), already in crs.
        crs: Validated target coordinate system.
        pixel_size: Positive X/Y cell sizes in target CRS units.
        origin: A grid intersection in target CRS units. Supply an existing
            north-up raster's origin to retain its alignment, or (0, 0) for a
            custom grid. Bounds snap outward to whole pixel offsets from it;
            offsets are rounded to eight decimal places first to absorb
            floating-point noise at an existing pixel boundary.

    Returns:
        One grid covering the entire AOI, independent of source coverage.
    """
    left, bottom, right, top = bounds
    x_size, y_size = pixel_size
    x_origin, y_origin = origin
    first_column = floor(round((left - x_origin) / x_size, 8))
    last_column = ceil(round((right - x_origin) / x_size, 8))
    first_row = floor(round((y_origin - top) / y_size, 8))
    last_row = ceil(round((y_origin - bottom) / y_size, 8))
    return RasterGrid(
        crs=crs,
        transform=Affine(
            x_size,
            0,
            x_origin + first_column * x_size,
            0,
            -y_size,
            y_origin - first_row * y_size,
        ),
        width=last_column - first_column,
        height=last_row - first_row,
    )


def _write_masked_source_vrt(source: rasterio.io.DatasetReader, path: Path) -> None:
    """Exclude masks, NoData and nonfinite source values before interpolation.

    GDAL can otherwise ignore an embedded mask when the same band declares
    NoData. An alpha band preserves that mask. Chained VRT sources normalize
    declared NoData and both infinities to NaN, keeping all invalid pixels out
    of interpolation. These VRTs reference original pixels and masks; they copy
    no data and remain inside the preparation directory. Reference the input as
    one source, including when it is itself a mosaic VRT with multiple sources.

    Args:
        source: Authorized single-band source with admitted validity semantics.
        path: Private VRT filename inside the preparation directory.

    Raises:
        RasterioError: If the source metadata cannot be copied.
        OSError: If the temporary VRT cannot be written.
    """
    root = ElementTree.Element(
        "VRTDataset", rasterXSize=str(source.width), rasterYSize=str(source.height)
    )
    tree = ElementTree.ElementTree(root)
    ElementTree.SubElement(root, "SRS").text = source.crs.to_wkt()
    ElementTree.SubElement(root, "GeoTransform").text = ",".join(
        str(value) for value in source.transform.to_gdal()
    )
    band = ElementTree.SubElement(root, "VRTRasterBand", dataType="Float64", band="1")
    ElementTree.SubElement(band, "NoDataValue").text = "nan"
    pixels = ElementTree.SubElement(band, "SimpleSource")
    ElementTree.SubElement(pixels, "SourceFilename", relativeToVRT="0").text = (
        source.name
    )
    ElementTree.SubElement(pixels, "SourceBand").text = "1"
    if source.nodata is not None:
        pixels.tag = "ComplexSource"
        ElementTree.SubElement(pixels, "NODATA").text = str(source.nodata)
    # Each ComplexSource excludes one value; chaining also removes undeclared
    # infinities before they can contaminate neighboring interpolated pixels.
    for index, value in enumerate(("inf", "-inf")):
        stage_path = path.with_name(f"{path.stem}-nodata-{index}.vrt")
        tree.write(stage_path)
        pixels.clear()
        pixels.tag = "ComplexSource"
        ElementTree.SubElement(pixels, "SourceFilename", relativeToVRT="0").text = str(
            stage_path
        )
        ElementTree.SubElement(pixels, "SourceBand").text = "1"
        ElementTree.SubElement(pixels, "NODATA").text = value
    alpha = ElementTree.SubElement(
        tree.getroot(), "VRTRasterBand", dataType="Byte", band="2"
    )
    ElementTree.SubElement(alpha, "ColorInterp").text = "Alpha"
    reference = ElementTree.SubElement(alpha, "SimpleSource")
    ElementTree.SubElement(reference, "SourceFilename", relativeToVRT="0").text = (
        source.name
    )
    ElementTree.SubElement(reference, "SourceBand").text = "mask,1"
    tree.write(path)


@contextmanager
def prepare_raster_stack(
    inputs: Mapping[str, tuple[Path, Resampling]],
    grid: RasterGrid,
    polygons: tuple[dict[str, object], ...] | PolygonRasterizer,
    directory: Path,
    limits: RasterAggregateLimits,
    *,
    all_touched: bool,
) -> Iterator[dict[str, Path]]:
    """Warp named inputs to temporary, AOI-masked GeoTIFFs on one shared grid.

    Run this inside the existing Processing native worker. Warping reads original
    source pixels directly into output tiles, without a preliminary clipped copy.
    Outputs use float64 and NaN NoData so interpolation retains fractional values
    and valid zero remains distinct from missing coverage. Scale, offset and unit
    metadata are retained with the raw values.

    Args:
        inputs: Nonempty mapping from input role/name to its authorized,
            admitted single-band raster path and requested resampling method.
            The caller retains source identities and settings for provenance.
        grid: Common grid from calculate_raster_grid; never reduced to source coverage.
        polygons: Exact AOI polygons already projected to grid.crs, or empty for
            the grid rectangle. A PolygonRasterizer must retain its polygons;
            its creator owns closing it.
        directory: Existing private attempt directory outside source mounts.
        limits: Existing Processing settings passed to polygon preparation.
        all_touched: Caller-selected polygon inclusion rule, applied to all inputs.

    Yields:
        Prepared files keyed by the original names, valid inside this context.
        Files and polygon masks are removed on normal or exceptional exit.
        After hard cancellation, the worker removes the attempt after native exit.

    Raises:
        RasterioError: If source reads, projection or output writes fail.
        ValueError: If GDAL rejects a resampling method or projected geometry.
        OSError: If temporary files or progress cannot be written or removed.
    """
    tile_side = 512
    total = len(inputs) * ceil(grid.width / tile_side) * ceil(grid.height / tile_side)
    completed = 0
    last_progress = 0.0
    write_progress(directory, "preparing_rasters", 0, total)
    with (
        TemporaryDirectory(prefix="aligned-", dir=directory) as temporary,
        ExitStack() as resources,
        rasterio.Env(GDAL_TIFF_INTERNAL_MASK=True),
    ):
        scratch = Path(temporary)
        outputs: dict[str, Path] = {}
        polygon_mask = None
        for index, (name, (path, resampling)) in enumerate(inputs.items()):
            output = scratch / f"input-{index}.tif"
            vrt_path = scratch / f"input-{index}.vrt"
            with rasterio.open(path) as source:
                _write_masked_source_vrt(source, vrt_path)
                with (
                    rasterio.open(vrt_path) as masked_source,
                    WarpedVRT(
                        masked_source,
                        crs=grid.crs,
                        transform=grid.transform,
                        width=grid.width,
                        height=grid.height,
                        resampling=resampling,
                        dtype="float64",
                        src_alpha=2,
                        src_nodata=np.nan,
                        nodata=np.nan,
                        UNIFIED_SRC_NODATA="NO",
                    ) as warped,
                ):
                    if index == 0:
                        polygon_mask = resources.enter_context(
                            temporary_polygon_mask(
                                warped,
                                Window(0, 0, grid.width, grid.height),
                                polygons,
                                scratch,
                                limits,
                                all_touched=all_touched,
                            )
                        )
                    with rasterio.open(
                        output,
                        "w",
                        driver="GTiff",
                        count=1,
                        dtype="float64",
                        crs=grid.crs,
                        transform=grid.transform,
                        width=grid.width,
                        height=grid.height,
                        nodata=np.nan,
                        tiled=True,
                        blockxsize=tile_side,
                        blockysize=tile_side,
                        compress="DEFLATE",
                        BIGTIFF="IF_SAFER",
                    ) as destination:
                        destination.scales = source.scales
                        destination.offsets = source.offsets
                        destination.units = source.units
                        destination.descriptions = source.descriptions
                        for _, window in destination.block_windows(1):
                            values = warped.read(1, window=window)
                            values[~np.isfinite(values)] = np.nan
                            if polygon_mask is not None:
                                values[polygon_mask.read(1, window=window) == 0] = (
                                    np.nan
                                )
                            destination.write(values, 1, window=window)
                            completed += 1
                            if time.monotonic() - last_progress > 0.5:
                                write_progress(
                                    directory,
                                    "preparing_rasters",
                                    completed,
                                    total,
                                )
                                last_progress = time.monotonic()
            outputs[name] = output
        write_progress(directory, "preparing_rasters", completed, total)
        yield outputs
