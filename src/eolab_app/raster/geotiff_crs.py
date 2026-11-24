"""Read GeoTIFF grid coordinates with the angular units declared in the file."""

import ctypes
from ctypes.util import find_library
from functools import cache
import math
import os

from pyproj import CRS as ProjCRS
from pyproj.crs.datum import PrimeMeridian
import rasterio
from rasterio.crs import CRS
from rasterio.io import DatasetReader
from tifffile.geodb import GeoKeys


@cache
def _geotiff_library() -> ctypes.CDLL:
    """Load the GDAL runtime's libgeotiff read-only GeoKey API.

    Returns:
        Library with the native handle and scalar argument types declared.

    Raises:
        OSError: If the installed geospatial runtime cannot load libgeotiff.
    """
    name = find_library("geotiff")
    if not name:
        raise OSError("The geospatial runtime could not locate libgeotiff")
    library = ctypes.CDLL(name)
    handle, integer, string = ctypes.c_void_p, ctypes.c_int, ctypes.c_char_p
    for symbol, result, arguments in (
        ("XTIFFFdOpen", handle, [integer, string, string]),
        ("XTIFFClose", None, [handle]),
        ("GTIFNew", handle, [handle]),
        ("GTIFFree", None, [handle]),
        (
            "GTIFKeyGetSHORT",
            integer,
            [handle, integer, ctypes.POINTER(ctypes.c_ushort), integer, integer],
        ),
        (
            "GTIFKeyGetDOUBLE",
            integer,
            [handle, integer, ctypes.POINTER(ctypes.c_double), integer, integer],
        ),
        ("GTIFKeyGetASCII", integer, [handle, integer, string, integer]),
    ):
        function = getattr(library, symbol)
        function.restype, function.argtypes = result, arguments
    return library


def _geokey_meridian_radians(path: str, radians_per_unit: float) -> float | None:
    """Read the Greenwich longitude of a custom geographic CRS from its GeoKeys.

    Args:
        path: Local GeoTIFF opened by GDAL.
        radians_per_unit: Radians per angular unit of the geodetic base.
    Returns:
        Longitude in radians from the registered meridian or numeric longitude.
        None leaves GDAL's registered CRS or explicit projection citation in force.
    Raises:
        OSError: If the native TIFF reader cannot open the file.
    """
    library = _geotiff_library()
    # Python opens Unicode paths. XTIFFClose owns the descriptor after a successful open.
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_BINARY", 0))
    tiff = library.XTIFFFdOpen(descriptor, os.fsencode(path), b"rO")
    if not tiff:
        os.close(descriptor)
        raise OSError("Could not open the GeoTIFF coordinate metadata")
    try:
        keys = library.GTIFNew(tiff)
        if not keys:
            return None
        try:
            code = ctypes.c_ushort()
            library.GTIFKeyGetSHORT(
                keys, GeoKeys.GeographicTypeGeoKey, ctypes.byref(code), 0, 1
            )
            if code.value != 32767:
                return None
            if (
                library.GTIFKeyGetSHORT(
                    keys, GeoKeys.GTModelTypeGeoKey, ctypes.byref(code), 0, 1
                )
                and code.value == 32767
            ):
                prefix = b"ESRI PE String = "
                citation = ctypes.create_string_buffer(len(prefix) + 1)
                library.GTIFKeyGetASCII(
                    keys, GeoKeys.PCSCitationGeoKey, citation, len(citation)
                )
                if citation.value == prefix:
                    return None
            if (
                library.GTIFKeyGetSHORT(
                    keys, GeoKeys.GeogPrimeMeridianGeoKey, ctypes.byref(code), 0, 1
                )
                and 1024 <= code.value < 32767
            ):
                meridian = PrimeMeridian.from_epsg(code.value)
                return meridian.longitude * meridian.unit_conversion_factor
            longitude = ctypes.c_double()
            if library.GTIFKeyGetDOUBLE(
                keys, GeoKeys.GeogPrimeMeridianLongGeoKey, ctypes.byref(longitude), 0, 1
            ):
                return longitude.value * radians_per_unit
            return None
        finally:
            library.GTIFFree(keys)
    finally:
        library.XTIFFClose(tiff)


class GeoTiffReader(DatasetReader):
    """Read original pixels and interpret user-defined longitude origins in GeoTIFF units."""

    def read_crs(self) -> CRS | None:
        """Read the native CRS and honor a numeric longitude relative to Greenwich.

        GDAL reads a complete ESRI projection citation directly. For numeric-only
        geographic keys, GeoTIFF specifies the prime meridian in the grid's
        angular unit. Keep the rest of GDAL's definition, including any vertical
        coordinate system and datum transformation.

        Returns:
            The source CRS, or None when the file has no georeferencing.

        Raises:
            ValueError: If the native geographic metadata cannot be interpreted.
            OSError: If the file's GeoKeys cannot be read.
        """
        with rasterio.Env(OSR_WKT_FORMAT="WKT2_2019"):
            crs = super().read_crs()
        if (
            self.driver != "GTiff"
            or not crs
            or not (crs.is_geographic or crs.is_projected)
        ):
            return crs
        if crs.is_geographic and math.isclose(crs.units_factor[1], math.radians(1)):
            return crs
        definition = ProjCRS.from_wkt(crs.to_wkt(version="WKT2_2019"))
        radians_per_unit = definition.geodetic_crs.axis_info[0].unit_conversion_factor
        if math.isclose(radians_per_unit, math.radians(1)):
            return crs
        radians = _geokey_meridian_radians(self.name, radians_per_unit)
        if radians is None:
            return crs
        meridian = definition.prime_meridian
        if math.isclose(
            meridian.longitude * meridian.unit_conversion_factor, radians, rel_tol=1e-13
        ):
            return crs
        document = definition.to_json_dict()
        horizontal = document
        horizontal = horizontal.get("source_crs", horizontal)
        if "components" in horizontal:
            horizontal = horizontal["components"][0]
        horizontal = horizontal.get("source_crs", horizontal)
        horizontal = horizontal.get("base_crs", horizontal)
        datum = horizontal.get("datum") or horizontal["datum_ensemble"]
        datum.setdefault("prime_meridian", {"name": meridian.name})["longitude"] = (
            math.degrees(radians)
        )
        return CRS.from_wkt(ProjCRS.from_json_dict(document).to_wkt())
