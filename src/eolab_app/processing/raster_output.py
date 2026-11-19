"""Prepare and verify floating-point GeoTIFFs for Processing publication."""

import hashlib
import math
from pathlib import Path

import numpy as np
import rasterio
from rasterio.shutil import copy as copy_raster

from eolab_app.processing.artifact_manifest import ProducedFile
from eolab_app.processing.model_result_contracts import RasterResultGrid
from eolab_app.processing.models import ProcessingError


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
    copy_raster(
        stage,
        destination,
        driver="COG",
        COMPRESS="DEFLATE",
        BLOCKSIZE=512,
        PREDICTOR="YES",
        OVERVIEW_RESAMPLING="NEAREST",
        NUM_THREADS="2",
        BIGTIFF="IF_SAFER",
    )
    with rasterio.open(destination) as result:
        if (
            result.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") != "COG"
            or result.width != grid.width
            or result.height != grid.height
            or result.count != 1
            or result.dtypes != ("float64",)
            or result.crs is None
            or result.crs.to_wkt() != grid.crs
            or tuple(result.transform)[:6] != grid.transform
            or result.nodata is None
            or not math.isnan(result.nodata)
            or result.units != (unit,)
            or (max(result.shape) > 512 and not result.overviews(1))
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
