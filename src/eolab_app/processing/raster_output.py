"""Prepare and verify floating-point GeoTIFFs for Processing publication."""

import hashlib
import math
from pathlib import Path
from uuid import uuid4

import numpy as np
from pyproj import CRS as ProjCRS
import rasterio
from rasterio.crs import CRS
from rasterio.shutil import copy as copy_raster

from eolab_app.processing.artifact_manifest import ProducedFile
from eolab_app.processing.model_result_contracts import RasterResultGrid
from eolab_app.processing.models import ProcessingError


def _encode_geotiff_prime_meridian(crs: str) -> tuple[str, str] | None:
    """Encode the grid's longitude origin and axis order for the GeoTIFF driver.

    A registered CRS has an EPSG key. For custom non-degree grids, GDAL's
    numeric keys and WKT1 citation can each change the meridian's units.
    Measure that conversion with a one-pixel in-memory TIFF from the installed
    driver. Adjust only the number sent to the encoder. The completed file
    must still match the original CRS in full.

    Args:
        crs: CRS of the planned grid, as WKT or an authority code.

    Returns:
        GeoKey flavor and encoder WKT, or None to use the ordinary COG driver.

    Raises:
        pyproj.exceptions.CRSError: If PROJ cannot read the grid's CRS.
        OSError: If GDAL cannot encode the longitude origin.
    """
    definition = ProjCRS.from_user_input(crs)
    if (
        not definition.is_geographic
        or math.isclose(definition.axis_info[0].unit_conversion_factor, math.radians(1))
        or definition.prime_meridian.longitude == 0
    ):
        return None
    document = definition.to_json_dict()
    if document.get("id", {}).get("authority") == "EPSG":
        return None
    from osgeo import gdal, osr

    # Numeric geographic keys decode latitude first. An ESRI citation decodes
    # longitude first. Preserve the axis order of the admitted grid.
    flavor = "STANDARD" if definition.axis_info[0].direction == "north" else "ESRI_PE"
    header = f"/vsimem/{uuid4().hex}.tif"
    with gdal.ExceptionMgr(), osr.ExceptionMgr():
        try:
            driver = gdal.GetDriverByName("GTiff")
            with driver.Create(
                header,
                1,
                1,
                1,
                gdal.GDT_Byte,
                options=[f"GEOTIFF_KEYS_FLAVOR={flavor}"],
            ) as sample:
                sample.SetSpatialRef(osr.SpatialReference(wkt=definition.to_wkt()))
            with gdal.Open(header) as sample:
                stored_wkt = sample.GetSpatialRef().ExportToWkt(["FORMAT=WKT2_2019"])
        except RuntimeError as error:
            raise OSError(
                "Could not encode the output GeoTIFF longitude origin"
            ) from error
        finally:
            gdal.Unlink(header)
    meridian = definition.prime_meridian
    longitude_radians = meridian.longitude * meridian.unit_conversion_factor
    decoded = ProjCRS.from_wkt(stored_wkt).prime_meridian
    stored_radians = decoded.longitude * decoded.unit_conversion_factor
    if math.isclose(longitude_radians, stored_radians):
        return flavor, definition.to_wkt()
    if stored_radians == 0:
        raise OSError("GDAL discarded the output GeoTIFF longitude origin")
    geographic = document.get("source_crs", document)
    # A numeric PROJJSON longitude is in degrees. Undo the observed angular
    # scale before passing it to this writer; never use it to transform pixels.
    geographic["datum"]["prime_meridian"]["longitude"] = math.degrees(
        longitude_radians
    ) * (longitude_radians / stored_radians)
    return flavor, ProjCRS.from_json_dict(document).to_wkt()


def write_float64_cog(
    stage: Path,
    destination: Path,
    grid: RasterResultGrid,
    valid_pixels: int,
    unit: str | None,
    *,
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
        unit: Expected band unit, or None for an unlabelled band.
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
    custom_meridian = _encode_geotiff_prime_meridian(grid.crs)
    if custom_meridian is not None:
        from osgeo import gdal, osr

        flavor, encoded_crs = custom_meridian
        # The COG driver does not forward GEOTIFF_KEYS_FLAVOR. Its underlying
        # GTiff driver creates the same ordered tile layout with COPY_SRC_OVERVIEWS.
        levels = []
        factor = 1
        while max(grid.width, grid.height) > block_size * factor:
            factor *= 2
            levels.append(factor)
        try:
            with (
                gdal.ExceptionMgr(),
                osr.ExceptionMgr(),
                gdal.Open(str(stage), gdal.GA_Update) as raster,
            ):
                if levels:
                    raster.BuildOverviews("NEAREST", levels)
                raster.SetSpatialRef(osr.SpatialReference(wkt=encoded_crs))
                with gdal.GetDriverByName("GTiff").CreateCopy(
                    str(destination),
                    raster,
                    options=[
                        f"GEOTIFF_KEYS_FLAVOR={flavor}",
                        "TILED=YES",
                        f"BLOCKXSIZE={block_size}",
                        f"BLOCKYSIZE={block_size}",
                        "COPY_SRC_OVERVIEWS=YES",
                        "PREDICTOR=3",
                        "COMPRESS=DEFLATE",
                        "NUM_THREADS=2",
                        "BIGTIFF=IF_SAFER",
                    ],
                ):
                    pass
        except RuntimeError as error:
            raise OSError(f"Could not write {destination.name}") from error
    else:
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
        )
    with rasterio.Env(OSR_WKT_FORMAT="WKT2_2019"), rasterio.open(destination) as result:
        if (
            result.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") != "COG"
            or result.width != grid.width
            or result.height != grid.height
            or result.count != 1
            or result.dtypes != ("float64",)
            or result.crs != CRS.from_wkt(grid.crs)
            or tuple(result.transform)[:6] != grid.transform
            or result.nodata is None
            or not math.isnan(result.nodata)
            or result.units != (unit,)
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
