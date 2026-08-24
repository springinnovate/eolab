"""Structural eligibility policy for raster visualization."""

import math
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import rasterio

from eolab_app.raster.catalog_metadata import RASTER_ASSET_METADATA_KEY
from eolab_app.raster.catalog_contract import (
    COG_MEDIA_TYPE,
    GEOTIFF_MEDIA_TYPE,
    GEOTIFF_MEDIA_TYPES,
    MOUNTED_GEOTIFF_COLLECTION_ID,
    MOUNTED_GEOTIFF_ITEM_ID_PATTERN,
)


RENDERING_METADATA_KEY = RASTER_ASSET_METADATA_KEY
RENDERING_POLICY = "raster-v3"
DIRECT_RENDERING_MAX_BYTES = 64 * 1024 * 1024
OVERVIEW_RENDERING_MAX_BYTES = 64 * 1024 * 1024
OVERVIEW_RENDERING_MAX_DIMENSION = 8192
RENDERING_MAX_BLOCK_EDGE = 1024
DETAIL_ONLY_PREVIEW_REASON_CODES = frozenset({
    "internal_overviews_required",
    "incomplete_overview_pyramid",
    "coarsest_overview_dimension_exceeded",
    "coarsest_overview_decoded_size_exceeded",
})
SUPPORTED_RENDERING_DATA_TYPES = frozenset(
    {"uint8", "uint16", "int16", "int32", "float32", "float64"}
)
RASTER_DATA_TYPE_BYTES = {
    "int8": 1,
    "uint8": 1,
    "float16": 2,
    "int16": 2,
    "uint16": 2,
    "complex_int16": 4,
    "float32": 4,
    "int32": 4,
    "uint32": 4,
    "complex64": 8,
    "float64": 8,
    "int64": 8,
    "uint64": 8,
    "complex128": 16,
}


def _has_complete_overview_pyramid(
    raster_width: int,
    factors: Sequence[int],
) -> bool:
    """Return whether Rasterio factors can describe every half-size level.

    Rasterio reports each factor as the rounded ratio of the base raster width
    to the actual overview width. Reconstructing possible floor- or
    ceiling-halved widths preserves that rounding behavior without treating the
    lossy reported factors as exact ratios.

    Args:
        raster_width: Base raster width in pixels.
        factors: Rasterio-reported overview factors in pyramid order.

    Returns:
        Whether every factor can represent the next approximately halved
        integer overview width.
    """
    possible_widths = {raster_width}
    for factor in factors:
        next_widths = {
            overview_width
            for previous_width in possible_widths
            for overview_width in {
                previous_width // 2,
                math.ceil(previous_width / 2),
            }
            if 0 < overview_width < previous_width
            and round(raster_width / overview_width) == factor
        }
        if not next_widths:
            return False
        possible_widths = next_widths
    return bool(factors)


def assess_raster_renderability(
    dataset: rasterio.io.DatasetReader,
) -> dict[str, Any]:
    """Assess a raster's structural eligibility under the raster-v3 policy.

    The assessment reads only dataset structure and overview metadata. It does
    not sample or decode raster pixels.

    Args:
        dataset: Open raster dataset.

    Returns:
        Versioned structural rendering metadata for the STAC data Asset.
    """
    data_types = tuple(dataset.dtypes)
    bytes_per_pixel = sum(
        RASTER_DATA_TYPE_BYTES[data_type] for data_type in data_types
    )
    estimated_uncompressed_bytes = (
        dataset.width * dataset.height * bytes_per_pixel
    )
    block_shapes = [list(block_shape) for block_shape in dataset.block_shapes]
    overview_factors = [
        dataset.overviews(band_index) for band_index in dataset.indexes
    ]
    has_overviews = any(overview_factors)
    external_overviews = any(
        str(dataset_file).lower().endswith((".ovr", ".aux", ".rrd"))
        for dataset_file in dataset.files
    )
    if not has_overviews:
        overview_storage = "none"
    elif external_overviews:
        overview_storage = "external"
    else:
        overview_storage = "internal"
    compression = (
        dataset.compression.value
        if dataset.compression is not None
        else None
    )

    bounded_blocks = all(
        max(block_height, block_width) <= RENDERING_MAX_BLOCK_EDGE
        for block_height, block_width in block_shapes
    )

    if dataset.count != 1:
        eligible = False
        reason_code = "unsupported_band_count"
        reason = (
            "Visualization unavailable: the current raster style supports "
            "one-band rasters."
        )
    elif data_types[0] not in SUPPORTED_RENDERING_DATA_TYPES:
        eligible = False
        reason_code = "unsupported_pixel_type"
        reason = (
            "Visualization unavailable: the current rendering path does not "
            f"support {data_types[0]} pixels."
        )
    elif estimated_uncompressed_bytes <= DIRECT_RENDERING_MAX_BYTES:
        eligible = True
        reason_code = None
        reason = None
    elif not bounded_blocks:
        eligible = False
        reason_code = "blocks_too_large"
        reason = (
            "Visualization unavailable: this raster needs smaller internal "
            "blocks."
        )
    elif overview_storage != "internal":
        eligible = False
        reason_code = "internal_overviews_required"
        reason = (
            "Visualization unavailable: this raster needs an internal "
            "overview pyramid."
        )
    else:
        factors = overview_factors[0]
        complete_overview_pyramid = _has_complete_overview_pyramid(
            dataset.width,
            factors,
        )
        if not complete_overview_pyramid:
            eligible = False
            reason_code = "incomplete_overview_pyramid"
            reason = (
                "Visualization unavailable: this raster needs an internal "
                "overview pyramid beginning at 2x without skipped levels."
            )
        else:
            coarsest_factor = factors[-1]
            coarsest_width = math.ceil(dataset.width / coarsest_factor)
            coarsest_height = math.ceil(dataset.height / coarsest_factor)
            coarsest_bytes = (
                coarsest_width * coarsest_height * bytes_per_pixel
            )
            if (
                max(coarsest_width, coarsest_height)
                > OVERVIEW_RENDERING_MAX_DIMENSION
            ):
                eligible = False
                reason_code = "coarsest_overview_dimension_exceeded"
                reason = (
                    "Visualization unavailable: the coarsest internal "
                    "overview is wider or taller than "
                    f"{OVERVIEW_RENDERING_MAX_DIMENSION} pixels."
                )
            elif coarsest_bytes > OVERVIEW_RENDERING_MAX_BYTES:
                eligible = False
                reason_code = "coarsest_overview_decoded_size_exceeded"
                reason = (
                    "Visualization unavailable: the coarsest internal "
                    "overview exceeds "
                    f"{OVERVIEW_RENDERING_MAX_BYTES // (1024 * 1024)} MiB "
                    "of decoded pixel data."
                )
            else:
                eligible = True
                reason_code = None
                reason = None

    rendering_metadata = {
        "policy": RENDERING_POLICY,
        "eligible": eligible,
        "bounded_blocks": bounded_blocks,
        "block_shapes": block_shapes,
        "overview_factors": overview_factors,
        "overview_storage": overview_storage,
        "compression": compression,
        "estimated_uncompressed_bytes": estimated_uncompressed_bytes,
    }
    if reason is not None:
        rendering_metadata["reason_code"] = reason_code
        rendering_metadata["reason"] = reason
    return rendering_metadata


def apply_reader_assessment(
    rendering_metadata: dict[str, Any],
    *,
    reader_contract: str,
    reader_compatible: bool,
    reader_reason_code: str | None,
) -> dict[str, Any]:
    """Add the deployed GeoServer reader decision to structural metadata.

    Args:
        rendering_metadata: Current-policy structural raster assessment.
        reader_contract: Stable identity of the deployed reader contract.
        reader_compatible: Whether that reader acquired the raster.
        reader_reason_code: Stable incompatibility classification, or ``None``
            for a compatible raster.

    Returns:
        A copied, complete rendering assessment suitable for persistence.

    Raises:
        ValueError: If the structural metadata or reader result violates the
            assessment contract.
    """
    if rendering_metadata.get("policy") != RENDERING_POLICY:
        raise ValueError("Reader assessment requires current structural metadata")
    if (
        not rendering_metadata.get("eligible")
        and rendering_metadata.get("reason_code")
        not in DETAIL_ONLY_PREVIEW_REASON_CODES
    ):
        raise ValueError(
            "Reader assessment requires full or detail-only structural "
            "eligibility"
        )
    if reader_compatible == (reader_reason_code is not None):
        raise ValueError("Reader compatibility and reason code are inconsistent")

    completed_metadata = dict(rendering_metadata)
    completed_metadata["reader_contract"] = reader_contract
    completed_metadata["reader_compatible"] = reader_compatible
    if reader_compatible:
        return completed_metadata

    completed_metadata.update({
        "eligible": False,
        "reason_code": reader_reason_code,
        "reason": (
            "Visualization unavailable: GeoServer cannot interpret this "
            "raster's coordinate-system metadata."
            if reader_reason_code == "geoserver_crs_metadata_incompatible"
            else "Visualization unavailable: GeoServer cannot acquire this raster."
        ),
    })
    return completed_metadata


def supports_detail_only_preview(rendering_metadata: dict[str, Any]) -> bool:
    """Return whether an assessment permits bounded detail-only previews.

    The structural rejection must be exclusively overview/scale related,
    native source blocks must be bounded, and the current deployed reader must
    have accepted the raster and its CRS.

    Args:
        rendering_metadata: Complete current-policy rendering assessment.

    Returns:
        Whether the raster may enter the separate detail-only preview path.
    """
    return (
        rendering_metadata.get("policy") == RENDERING_POLICY
        and rendering_metadata.get("eligible") is False
        and rendering_metadata.get("reason_code")
        in DETAIL_ONLY_PREVIEW_REASON_CODES
        and rendering_metadata.get("bounded_blocks") is True
        and rendering_metadata.get("reader_compatible") is True
    )


def inspect_raster_renderability(geotiff_path: Path) -> dict[str, Any]:
    """Inspect one GeoTIFF at the synchronous Rasterio boundary.

    Args:
        geotiff_path: Mounted GeoTIFF to inspect.

    Returns:
        Versioned eligibility metadata for the raster.

    Raises:
        OSError: If source metadata cannot be read.
        rasterio.errors.RasterioError: If GDAL cannot open the source.
    """
    with rasterio.open(geotiff_path) as dataset:
        return assess_raster_renderability(dataset)
