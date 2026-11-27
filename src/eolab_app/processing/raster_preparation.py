"""Prepare temporary rasters on one common grid for a Processing calculation."""

from collections.abc import Iterator, Mapping
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from math import ceil, floor, isclose, isfinite, radians, tau
from pathlib import Path
from tempfile import TemporaryDirectory
import time
from xml.etree import ElementTree

from affine import Affine
import numpy as np
from numpy.typing import NDArray
from pyproj import Transformer
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import array_bounds
from rasterio.warp import transform
from rasterio.windows import Window

from eolab_app.bounded_vector import (
    PolygonRasterizer,
    native_polygon_features,
    polygon_features,
)
from eolab_app.catalog_selection import ResolvedCatalogSelection
from eolab_app.processing.aggregate_models import RasterAggregateLimits
from eolab_app.processing.artifacts import write_progress
from eolab_app.processing.raster_mask import temporary_polygon_mask
from eolab_app.raster.bounded_window import (
    geographic_grid_wkt_in_degrees,
    grid_boundary_projection,
    project_geographic_polygons,
    project_polygons_to_crs,
    project_polygons_to_output_grid,
)
from eolab_app.raster.geotiff_crs import GeoTiffReader
from eolab_app.sampling_box import Wgs84SamplingBox, tessellate_sampling_box


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


def read_preparation_polygons(
    selection: ResolvedCatalogSelection,
    crs: CRS,
    *,
    pixel_size: tuple[float, float] | None = None,
) -> tuple[dict[str, object], ...]:
    """Read selected polygons from the original vector in the calculation CRS.

    Args:
        selection: Authorized original vector and exact feature predicate.
        crs: Output CRS independent of raster coverage.
        pixel_size: Positive X/Y sizes for projecting native edges to cell
            accuracy. Omit to use the existing WGS84 polygon stream.
    Returns:
        Projected polygons to use within this calculation.
    Raises:
        ValueError: If no polygons match or coordinates cannot be projected.
        SelectionUnavailableError: If the original vector cannot be read.
    """

    if pixel_size is not None:
        with native_polygon_features(selection, limits=None) as (source_crs, features):
            polygons = tuple(
                projected
                for geometry in features
                for projected in project_polygons_to_output_grid(
                    source_crs, crs, (geometry,), pixel_size
                )
            )
    else:
        with polygon_features(selection, limits=None) as features:
            polygons = tuple(
                projected
                for geometry in features
                for projected in project_polygons_to_crs(
                    "EPSG:4326", crs, (geometry,), None
                )
            )
    if not polygons:
        raise ValueError("The vector selection contains no polygons.")
    return polygons


def project_preparation_box(
    box: Wgs84SamplingBox,
    crs: CRS,
    pixel_size: tuple[float, float],
    *,
    seam_aware: bool = False,
) -> dict[str, object]:
    """Project a geodesic sampling box at the output grid's pixel accuracy.

    Args:
        box: Captured geographic center and box dimensions.
        crs: Output coordinate system.
        pixel_size: Positive output X/Y cell sizes in the output CRS.
        seam_aware: Split geographic seams and reject cuts in projected grids.
    Returns:
        A polygon or antimeridian-split multipolygon in the output CRS.
    Raises:
        ValueError: If the box cannot be projected.
    """

    project_boundary = (
        grid_boundary_projection("EPSG:4326", crs) if seam_aware else None
    )

    def project_pixels(
        positions: tuple[tuple[float, float], ...],
    ) -> tuple[tuple[float, float], ...]:
        """Return output-grid pixel positions for edge refinement."""
        if project_boundary is None:
            x, y = transform(
                "EPSG:4326",
                crs,
                [point[0] for point in positions],
                [point[1] for point in positions],
            )
            projected = zip(x, y, strict=True)
        else:
            projected = project_boundary(positions)
        return tuple((a / pixel_size[0], b / pixel_size[1]) for a, b in projected)

    ring = tessellate_sampling_box(
        box, project_pixels, check_continuity=seam_aware and crs.is_projected
    )
    if seam_aware and crs.is_geographic:
        return project_geographic_polygons(
            "EPSG:4326", crs, ({"type": "Polygon", "coordinates": [ring]},)
        )[0]
    x, y = transform(
        "EPSG:4326", crs, [point[0] for point in ring], [point[1] for point in ring]
    )
    return {"type": "Polygon", "coordinates": [tuple(zip(x, y, strict=True))]}


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
    ElementTree.SubElement(root, "SRS").text = source.crs.to_wkt(version="WKT2_2019")
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


def _write_periodic_longitude_vrt(
    source: rasterio.io.DatasetReader, masked_path: Path, period: float
) -> Path:
    """Repeat a full-period geographic source on a continuous pixel lattice.

    The virtual copies reference the original values and alpha band. GDAL can
    read across either seam before computing bilinear or aggregate samples.
    Rows may have a longitude shear; preserve it while repeating columns whose
    full width returns to the same longitude and latitude.

    Args:
        source: Original raster whose columns cover one full longitude period.
        masked_path: Attempt-owned VRT exposing the numeric band and its alpha.
        period: A full turn in the source CRS's angular units.

    Returns:
        Path to the periodic virtual source on the same pixel lattice.

    Raises:
        OSError: If the virtual grid cannot be written in the attempt directory.
    """
    affine = source.transform
    left, _, right, _ = source.bounds
    center_period = floor((left + right) / (2 * period) + 0.5)
    longitude_origin = affine.c - center_period * period - source.width * affine.a
    virtual_transform = Affine(
        affine.a, affine.b, longitude_origin, 0, affine.e, affine.f
    )
    root = ElementTree.Element(
        "VRTDataset",
        rasterXSize=str(3 * source.width),
        rasterYSize=str(source.height),
    )
    ElementTree.SubElement(root, "SRS").text = source.crs.to_wkt(version="WKT2_2019")
    ElementTree.SubElement(root, "GeoTransform").text = ",".join(
        str(value) for value in virtual_transform.to_gdal()
    )
    dimensions = {"yOff": "0", "xSize": str(source.width), "ySize": str(source.height)}
    for number, dtype in ((1, "Float64"), (2, "Byte")):
        band = ElementTree.SubElement(
            root, "VRTRasterBand", band=str(number), dataType=dtype
        )
        if number == 1:
            ElementTree.SubElement(band, "NoDataValue").text = "nan"
        else:
            ElementTree.SubElement(band, "ColorInterp").text = "Alpha"
        for copy in range(3):
            reference = ElementTree.SubElement(band, "SimpleSource")
            ElementTree.SubElement(
                reference, "SourceFilename", relativeToVRT="1"
            ).text = masked_path.name
            ElementTree.SubElement(reference, "SourceBand").text = str(number)
            ElementTree.SubElement(reference, "SrcRect", xOff="0", **dimensions)
            ElementTree.SubElement(
                reference, "DstRect", xOff=str(copy * source.width), **dimensions
            )
    wrapped_path = masked_path.with_name(f"{masked_path.stem}-wrapped.vrt")
    ElementTree.ElementTree(root).write(wrapped_path)
    return wrapped_path


def _write_warped_vrt(
    source: rasterio.io.DatasetReader,
    masked_path: Path,
    grid: RasterGrid,
    resampling: Resampling,
    *,
    periodic_longitude: bool,
) -> Path:
    """Create a lazy GDAL warp with exact coordinates and source validity.

    Use one dataset-aware transformer for every source and resampling method.
    GDAL handles geographic longitude wrapping, rotated grids and alpha masks.
    Sample the interior of periodic views when estimating source windows:
    sampling only their perimeter can miss valid pixels near longitude cuts.
    Its grid-sampled horizontal scale keeps repeated longitude periods from
    being mistaken for a coarser source resolution when choosing the kernel.
    Center interpolated and aggregate periodic views on the output so scale
    probes and cell footprints have continuous neighbors across the seam.
    If the output envelope's midpoint is in a projection gap, retain the
    periodic source's own center; a valid multipart area need not include it.
    GDAL skips automatic centering for sources wider
    than one period, so set its native CENTER_LONG option in the serialized warp.
    Convert non-degree geographic coordinates to degrees in a virtual source
    because the native longitude-centering operation requires those units.
    Preserve both coordinate systems, including their prime meridian units,
    when GDAL serializes the reprojection transformer as WKT1.

    Args:
        source: Open virtual source supplying its CRS and affine transform.
        masked_path: Virtual source with the original values and validity band.
        grid: Output grid in its original CRS and pixel coordinates.
        resampling: GDAL method for reading samples from the source.
        periodic_longitude: The source is a virtual full-period raster with
            repeated columns on both sides for seam neighbors.

    Returns:
        A VRT in the attempt directory with the requested output transform.

    Raises:
        RasterioError: If GDAL cannot create the virtual warp.
        OSError: If the periodic transformer options cannot be written.
    """
    from osgeo import gdal

    path = masked_path.with_name(f"{masked_path.stem}-warped.vrt")
    warp_source_path = masked_path
    sample_periodic_scale = periodic_longitude and resampling == Resampling.bilinear
    center_periodic_longitudes = periodic_longitude and resampling != Resampling.nearest
    warp_options = ["UNIFIED_SRC_NODATA=NO"]
    if periodic_longitude:
        warp_options.append("SAMPLE_GRID=YES")
    if sample_periodic_scale:
        warp_options.append("XSCALE=FROM_GRID_SAMPLING")
    try:
        with gdal.ExceptionMgr(), gdal.config_option("OSR_WKT_FORMAT", "WKT2_2019"):
            degree = radians(1)
            source_wkt = source.crs.to_wkt(version="WKT2_2019")
            target_wkt = grid.crs.to_wkt(version="WKT2_2019")
            to_degrees = (
                source.crs.units_factor[1] / degree if source.crs.is_geographic else 1
            )
            if not isclose(to_degrees, 1, rel_tol=0, abs_tol=1e-12):
                # The native longitude-centering transformer expects degrees.
                # Change only the coordinate units of the virtual source.
                degree_path = masked_path.with_name(f"{masked_path.stem}-degrees.vrt")
                source_wkt = geographic_grid_wkt_in_degrees(source_wkt)
                with gdal.Translate(
                    str(degree_path),
                    str(masked_path),
                    format="VRT",
                    outputSRS=source_wkt,
                    outputGeotransform=[
                        value * to_degrees for value in source.transform.to_gdal()
                    ],
                ):
                    pass
                warp_source_path = degree_path
            with gdal.Warp(
                str(path),
                str(warp_source_path),
                format="VRT",
                outputBounds=array_bounds(grid.height, grid.width, grid.transform),
                xRes=grid.transform.a,
                yRes=-grid.transform.e,
                dstSRS=target_wkt,
                resampleAlg=int(resampling),
                srcAlpha=True,
                srcNodata=np.nan,
                dstNodata=np.nan,
                outputType=gdal.GDT_Float64,
                errorThreshold=0,
                warpOptions=warp_options,
            ):
                pass
            tree = ElementTree.parse(path)
            reprojection = tree.find(".//ReprojectionTransformer")
            if reprojection is None:
                if center_periodic_longitudes:
                    raise RuntimeError("GDAL omitted the periodic source transformer")
                return path
            for tag, wkt in (("SourceSRS", source_wkt), ("TargetSRS", target_wkt)):
                node = reprojection.find(tag)
                if node is not None:
                    node.text = wkt
            if center_periodic_longitudes:
                center_x, center_y = grid.transform * (grid.width / 2, grid.height / 2)
                longitude, _ = Transformer.from_crs(
                    target_wkt,
                    source.crs.to_wkt(version="WKT2_2019"),
                    always_xy=True,
                ).transform(center_x, center_y)
                if not isfinite(longitude):
                    longitude, _ = source.transform * (
                        source.width / 2,
                        source.height / 2,
                    )
                options = reprojection.find("Options")
                if options is None:
                    options = ElementTree.SubElement(reprojection, "Options")
                center_option = options.find("Option[@key='CENTER_LONG']")
                if center_option is None:
                    center_option = ElementTree.SubElement(
                        options, "Option", key="CENTER_LONG"
                    )
                center_option.text = str(longitude * to_degrees)
            tree.write(path)
    except RuntimeError as error:
        raise rasterio.errors.RasterioError(
            "Could not create the aligned raster warp"
        ) from error
    return path


@contextmanager
def open_warped_raster(
    path: Path, resampling: Resampling, grid: RasterGrid, vrt_path: Path
) -> Iterator[tuple[rasterio.io.DatasetReader, rasterio.io.DatasetReader]]:
    """Open the original metadata and a lazy, validity-aware warp on a common grid.

    Args:
        path: Authorized original single-band raster.
        resampling: GDAL method for sampling original pixels.
        grid: Destination grid independent of source coverage.
        vrt_path: Private file in a caller-owned temporary directory.

    Yields:
        Original source for band metadata and aligned GDAL view for window reads.
        The caller removes the VRT files after the readers have closed.

    Raises:
        RasterioError: If the source or warp cannot be opened.
        OSError: If a virtual source cannot be written.
    """
    with rasterio.Env(OSR_WKT_FORMAT="WKT2_2019"), GeoTiffReader(path) as source:
        _write_masked_source_vrt(source, vrt_path)
        axes = source.transform
        periodic_longitude = False
        if source.crs.is_geographic and axes.d == 0:
            period = tau / source.crs.units_factor[1]
            span = abs(axes.a) * source.width
            if isclose(span, period, rel_tol=0, abs_tol=abs(axes.a) * 1e-6):
                periodic_longitude = True
                vrt_path = _write_periodic_longitude_vrt(source, vrt_path, period)
        with rasterio.open(vrt_path) as masked_source:
            warped_path = _write_warped_vrt(
                masked_source,
                vrt_path,
                grid,
                resampling,
                periodic_longitude=periodic_longitude,
            )
        with rasterio.open(warped_path) as warped:
            yield source, warped


def read_warped_tile(
    raster: rasterio.io.DatasetReader,
    window: Window,
    inside: NDArray[np.bool_] | None,
) -> NDArray[np.float64]:
    """Return aligned Float64 samples with NaN for invalid or excluded cells.

    Args:
        raster: Open GDAL warp produced by open_warped_raster.
        window: Tile on the destination grid.
        inside: Optional Boolean tile with True for included destination cells.

    Returns:
        Stored band values after resampling and applying the destination mask.

    Raises:
        RasterioError: If a native read or warp fails.
    """
    values = raster.read(1, window=window)
    values[~np.isfinite(values)] = np.nan
    if inside is not None:
        values[~inside] = np.nan
    return values


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
            with open_warped_raster(path, resampling, grid, vrt_path) as (
                source,
                warped,
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
                        inside = (
                            None
                            if polygon_mask is None
                            else polygon_mask.read(1, window=window) != 0
                        )
                        destination.write(
                            read_warped_tile(warped, window, inside), 1, window=window
                        )
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
