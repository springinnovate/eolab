"""Prepare and verify floating-point GeoTIFFs for Processing publication."""

import hashlib
from itertools import batched
import math
from pathlib import Path
import re

import numpy as np
from pyproj import CRS as ProjCRS
import rasterio
from rasterio.crs import CRS
from rasterio.shutil import copy as copy_raster
from tifffile import TiffFile
from tifffile.geodb import GeoKeys

from eolab_app.processing.artifact_manifest import ProducedFile
from eolab_app.processing.model_result_contracts import RasterResultGrid
from eolab_app.processing.models import ProcessingError


def _copy_reference_crs_keys(reference: Path, destination: Path, crs: ProjCRS) -> None:
    """Preserve a matched grid's geographic or projected CRS in the GDAL-created COG.

    GeoTIFF stores its CRS in a key directory with separate doubles and text.
    Only these three TIFF tags describe the CRS. Pixel registration belongs to
    the new raster and remains PixelIsArea. GDAL can misread numeric meridians
    in non-degree units, so include its projection citation for those grids too.

    Args:
        reference: Original authorized GeoTIFF whose grid the user matched.
        destination: Attempt-owned COG with its final affine and pixel data.
        crs: Planned CRS, with the source angular units and any vertical datum.

    Raises:
        ValueError: If the source GeoKeys cannot be interpreted.
        OSError: If metadata cannot be read or written.
        ProcessingError: If the numeric longitude fails independent readback.
    """
    with TiffFile(reference) as source:
        tags = source.pages[0].tags
        directory = tags.valueof(34735)
        doubles = list(tags.valueof(34736, ()))
        citation = tags.valueof(34737, "")
        decoded = source.pages[0].geotiff_tags
    count = directory[3]
    end = 4 + 4 * count
    entries = {
        key: (tag, size, offset)
        for key, tag, size, offset in batched(directory[4:end], 4)
    }
    entries[GeoKeys.GTRasterTypeGeoKey] = (0, 1, 1)  # PixelIsArea
    meridian = crs.prime_meridian
    grid_unit = crs.geodetic_crs.axis_info[0].unit_conversion_factor
    geographic_code = entries.get(GeoKeys.GeographicTypeGeoKey, (0, 1, 32767))[2]
    longitude = None
    if meridian.longitude != 0 and geographic_code != crs.geodetic_crs.to_epsg(
        min_confidence=100
    ):
        # A projection citation can override the registered geographic code.
        entries[GeoKeys.GeographicTypeGeoKey] = (0, 1, 32767)
        longitude = meridian.longitude * meridian.unit_conversion_factor / grid_unit
        key = GeoKeys.GeogPrimeMeridianLongGeoKey
        if key in entries:
            doubles[entries[key][2]] = longitude
        else:
            entries[key] = (34736, 1, len(doubles))
            doubles.append(longitude)
        entries[GeoKeys.GeogPrimeMeridianGeoKey] = (0, 1, 32767)
        has_projection_citation = decoded.get(
            "GTModelTypeGeoKey"
        ) == 32767 and decoded.get("PCSCitationGeoKey", "").startswith(
            ("ESRI PE String = GEOGCS[", "ESRI PE String = PROJCS[")
        )
        # GeoTools takes the meridian from a registered datum. A custom
        # datum in degrees already round-trips through both native readers.
        if not has_projection_citation and (
            not math.isclose(grid_unit, math.radians(1))
            or decoded.get("GeogGeodeticDatumGeoKey") != 32767
        ):
            # GeoTools reads the horizontal WKT1 in raster x/y order. GDAL's
            # horizontal dialect retains TOWGS84. The ESRI vertical suffix
            # preserves the height CRS for GDAL readers of the same file.
            horizontal = crs.sub_crs_list[0] if crs.is_compound else crs
            wkt = horizontal.to_wkt(version="WKT1_GDAL", output_axis_rule=False)
            if crs.is_compound:
                wkt += "," + crs.sub_crs_list[1].to_wkt(version="WKT1_ESRI")
            # PROJ emits PRIMEM in degrees. The citation readers interpret its
            # number in the geographic angular unit. Edit only the emitted token.
            wkt = re.sub(
                r'(\bPRIMEM\["(?:[^"]|"")*",)[^,\]]+',
                lambda match: match[1] + repr(longitude),
                wkt,
                count=1,
            )
            encoded = ("ESRI PE String = " + wkt + "|").encode("utf-8")
            citation = citation.encode("utf-8")
            entries[GeoKeys.GTModelTypeGeoKey] = (0, 1, 32767)
            entries[GeoKeys.PCSCitationGeoKey] = (34737, len(encoded), len(citation))
            citation += encoded
    # SHORT arrays can follow the entries inside the directory itself.
    shift = 4 * (len(entries) - count)
    keys = [*directory[:3], len(entries)]
    for key, (tag, size, offset) in sorted(entries.items()):
        keys.extend((key, tag, size, offset + shift if tag == 34735 else offset))
    keys.extend(directory[end:])
    with TiffFile(destination, mode="r+") as output:
        tags = output.pages[0].tags
        tags[34735].overwrite(keys)
        if doubles:
            tags[34736].overwrite(doubles)
        if citation:
            tags[34737].overwrite(citation)
    if longitude is not None:
        with TiffFile(destination) as output:
            stored = output.pages[0].geotiff_tags.get("GeogPrimeMeridianLongGeoKey")
        if stored != longitude:
            raise ProcessingError(
                "invalid_output",
                "The GeoTIFF did not preserve the grid's longitude origin.",
                500,
            )


def write_float64_cog(
    stage: Path,
    destination: Path,
    grid: RasterResultGrid,
    valid_pixels: int,
    unit: str | None,
    *,
    reference: Path | None = None,
    output_name: str,
    description: str,
) -> ProducedFile:
    """Convert a completed one-band TIFF and verify its grid and valid-cell count.

    Preserve a custom longitude origin in the COG's own GeoTIFF metadata.

    Args:
        stage: Completed attempt-owned Float64 TIFF with NaN NoData.
        destination: COG path in the same attempt.
        grid: Expected dimensions, CRS WKT, and affine transform.
        valid_pixels: Expected number of valid pixels at the base resolution.
        unit: Expected band unit, or None when the value's unit is unspecified.
            Compound grids explicitly label this as unknown so the vertical
            coordinate unit cannot be mistaken for the unit of the formula.
        reference: Authorized GeoTIFF when matching an existing raster grid.
        output_name: Recipe output name associated with the destination.
        description: File description for output-integrity errors, such as
            "The temporal result".
    Returns:
        Complete file metadata and checksum. The staging TIFF is removed.
    Raises:
        ProcessingError: If the completed COG does not match its expected metadata.
        OSError: If file conversion, verification, or cleanup fails.
    """
    block_size = 512
    definition = ProjCRS.from_user_input(grid.crs)
    band_unit = unit
    if definition.is_compound and unit is None:
        # GDAL otherwise labels the formula values with the vertical axis unit.
        band_unit = "unknown"
        with rasterio.open(stage, "r+") as staged:
            staged.set_band_unit(1, band_unit)
    copy_keys = (
        reference is not None
        and (definition.to_json_dict().get("id", {}).get("authority") != "EPSG")
        and (
            definition.is_geographic
            or (definition.is_projected and definition.prime_meridian.longitude != 0)
        )
    )
    copy_raster(
        stage,
        destination,
        driver="COG",
        BLOCKSIZE=block_size,
        PREDICTOR="YES",
        OVERVIEW_RESAMPLING="NEAREST",
        COMPRESS="DEFLATE",
        NUM_THREADS="2",
        BIGTIFF="IF_SAFER",
        GEOTIFF_VERSION="1.0" if copy_keys else "AUTO",
    )
    if reference is not None and copy_keys:
        _copy_reference_crs_keys(reference, destination, definition)
    with rasterio.Env(OSR_WKT_FORMAT="WKT2_2019"), rasterio.open(destination) as result:
        if (
            result.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") != "COG"
            or result.width != grid.width
            or result.height != grid.height
            or result.count != 1
            or result.dtypes != ("float64",)
            or not (
                result.crs == CRS.from_wkt(grid.crs)
                or (
                    copy_keys
                    and result.crs
                    and ProjCRS.from_wkt(result.crs.to_wkt(version="WKT2_2019")).equals(
                        definition, ignore_axis_order=True
                    )
                )
            )
            or tuple(result.transform)[:6] != grid.transform
            or result.nodata is None
            or not math.isnan(result.nodata)
            or result.units != (band_unit,)
            or (max(result.shape) > block_size and not result.overviews(1))
        ):
            raise ProcessingError(
                "invalid_output", f"{description} failed grid/COG validation.", 500
            )
        actual_valid = sum(
            int(np.count_nonzero(result.read_masks(1, window=window)))
            for _, window in result.block_windows(1)
        )
        if actual_valid != valid_pixels:
            raise ProcessingError(
                "invalid_output", f"{description} failed validity-mask validation.", 500
            )
    with destination.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    stage.unlink()
    return ProducedFile(
        name=output_name,
        storage_name=destination.name,
        filename=destination.name,
        media_type="image/tiff",
        size=destination.stat().st_size,
        sha256=digest,
    )
