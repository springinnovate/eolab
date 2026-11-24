"""Neutral conversion of raster extents to geographic longitude coverage."""

import math

from pyproj import CRS as ProjCRS, Transformer
from pyproj.exceptions import ProjError
from rasterio.crs import CRS
from rasterio.warp import transform_bounds


def covers_full_longitude_turn(crs: CRS, grid_width: float) -> bool:
    """Return whether a geographic grid covers one complete longitude cycle.

    Args:
        crs: Native raster CRS defining its angular units.
        grid_width: Distance between the western and eastern pixel edges in that CRS.

    Returns:
        True for a complete turn, such as 360 degrees or 400 grads.
    """
    return crs.is_geographic and math.isclose(
        grid_width * crs.units_factor[1], math.tau
    )


def transform_bounds_to_wgs84(
    source_crs: CRS,
    source_bounds: tuple[float, float, float, float],
    *,
    densify_points: int = 21,
) -> tuple[float, float, float, float]:
    """Transform an extent without prematurely wrapping its longitudes.

    Args:
        source_crs: Coordinate reference system of the source extent.
        source_bounds: Left, bottom, right and top in source coordinates.
        densify_points: Intermediate samples per boundary edge.

    Returns:
        West, south, east and north in degrees. PROJ's unwrapped longitude
        output is preserved, including values outside [-180, 180]. Nonfinite
        output is retained so a caller can apply its projection fallback.
        Some projections can still report a date-line crossing as east < west.
        Geographic and Mercator/equidistant cylindrical systems use PROJ's
        +over control. Other projections retain GDAL's domain handling: +over
        can admit invalid outer corners for non-cylindrical world projections.
        For geographic grids that reach a native pole, include its valid
        edge before transforming. If the datum shift moves that pole, retain
        a conservative full-longitude envelope for the polar strip.

    Raises:
        ValueError: If PROJ cannot construct or execute the transformation.
        rasterio.errors.RasterioError: If GDAL cannot transform the extent.
    """
    try:
        crs = ProjCRS(source_crs)
        operation = crs.coordinate_operation
        cylindrical = operation is not None and operation.method_name in {
            "Popular Visualisation Pseudo Mercator",
            "Mercator (variant A)",
            "Mercator (variant B)",
            "Equidistant Cylindrical",
            "Equidistant Cylindrical (Spherical)",
        }
        if not (crs.is_geographic or cylindrical):
            return transform_bounds(
                source_crs,
                "EPSG:4326",
                *source_bounds,
                densify_pts=densify_points,
            )
        transformer = Transformer.from_crs(
            source_crs, "EPSG:4326", always_xy=True, force_over=True
        )
        west, south, east, north = source_bounds
        polar_edges = []
        if crs.is_geographic:
            pole = math.pi / (2 * source_crs.units_factor[1])
            # GeoTIFF angular units can put 100 grads a few ulps below a pole.
            low, high = round(south / pole, 14), round(north / pole, 14)
            if low <= -1 < high:
                south = -pole
                polar_edges.append((south, -90.0))
            if low < 1 <= high:
                north = pole
                polar_edges.append((north, 90.0))
        bounds = transformer.transform_bounds(
            west, south, east, north, densify_pts=densify_points
        )
        if not polar_edges or not all(map(math.isfinite, bounds)):
            return bounds
        left, bottom, right, top = bounds
        for native_lat, wgs84_lat in polar_edges:
            pole_latitude = transformer.transform(west, native_lat)[1]
            if not math.isclose(pole_latitude, wgs84_lat, rel_tol=0, abs_tol=1e-12):
                # A shifted pole can swing through longitudes missed by the sampled edges.
                left, right = -180.0, 180.0
            if wgs84_lat < 0:
                bottom = wgs84_lat
            else:
                top = wgs84_lat
        return left, bottom, right, top
    except ProjError as error:
        raise ValueError("Raster bounds could not be transformed to WGS 84") from error


def normalize_wgs84_bounds(
    bounds: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    """Represent geographic coverage as one finite, non-wrapping envelope.

    Args:
        bounds: Transformed west, south, east and north, before longitude
            normalization. East < west denotes a library-reported crossing.

    Returns:
        A canonical envelope containing the longitude interval. Full-world
        intervals and date-line crossings use [-180, 180] because one
        non-wrapping box cannot represent two separated longitude intervals.
        Latitude pixel-edge overshoot is clipped to [-90, 90].

    Raises:
        ValueError: If the extent is nonfinite, empty or has no valid latitude.
    """
    if not all(math.isfinite(value) for value in bounds):
        raise ValueError("Raster WGS 84 bounds must be finite")
    west, south, east, north = bounds
    span = east - west
    if span == 0:
        raise ValueError("Raster WGS 84 bounds must have positive width")
    if span < 0 or span >= 360:
        west, east = -180.0, 180.0
    elif -180.0 - 1e-8 <= west < 180.0 and -180.0 < east <= 180.0 + 1e-8:
        # Computing a pixel edge can carry a regional grid just past the meridian.
        west, east = max(-180.0, west), min(180.0, east)
    else:
        west = (west + 180.0) % 360.0 - 180.0
        east = west + span
        if east > 180.0:
            west, east = -180.0, 180.0
    south, north = max(-90.0, south), min(90.0, north)
    if south >= north:
        raise ValueError("Raster WGS 84 bounds must have positive height")
    return west, south, east, north
