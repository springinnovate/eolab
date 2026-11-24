"""Read GeoTIFF grid coordinates with the angular units declared in the file."""

import math

from pyproj import CRS as ProjCRS
from rasterio.crs import CRS
from rasterio.io import DatasetReader


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
        crs = super().read_crs()
        if self.driver != "GTiff" or not crs or not crs.is_geographic:
            return crs
        radians_per_unit = crs.units_factor[1]
        if math.isclose(radians_per_unit, math.radians(1)):
            return crs
        from tifffile import TiffFile

        with TiffFile(self.name) as source:
            keys = source.pages[0].geotiff_tags or {}
        longitude = keys.get("GeogPrimeMeridianLongGeoKey")
        if (
            longitude is None
            or keys.get("GeographicTypeGeoKey") != 32767
            or (
                keys.get("GTModelTypeGeoKey") == 32767
                and keys.get("PCSCitationGeoKey", "").startswith("ESRI PE String = ")
            )
        ):
            return crs
        definition = ProjCRS.from_wkt(crs.to_wkt(version="WKT2_2019"))
        meridian = definition.prime_meridian
        radians = longitude * radians_per_unit
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
