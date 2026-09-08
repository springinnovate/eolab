"""Shared source checks and native-area planning for clip and aggregate kernels."""

import math
from pathlib import Path
from typing import Any

from eolab_app.processing.models import ProcessingError
from eolab_app.raster.bounded_window import (
    NoRasterBoundsOverlapError,
    selected_raster_area_for_wgs84_bounds,
    selected_raster_area_for_wgs84_polygons,
)
from eolab_app.raster.models import SelectedRasterArea
from eolab_app.raster.source_contract import (
    decoded_source_bytes_for_blocks,
    source_block_indexes_for_window,
    require_signed_raster_dependencies,
    require_raster_analysis_georeferencing,
    require_bounded_source_structure,
)
from eolab_app.raster.source_identity import RasterSourceIdentity


def require_signature(path: Path, signature: tuple[int, ...]) -> None:
    """Fence both kernels to the complete catalog-approved source signature.

    Args:
        path: Authorized mounted source.
        signature: Expected inode, size, mtime, and ctime tuple.

    Raises:
        ProcessingError: If the source is missing or changed.
    """
    try:
        current = tuple(RasterSourceIdentity.read(path).to_catalog())
    except OSError:
        current = ()
    if current != signature:
        raise ProcessingError(
            "source_changed",
            "The raster changed; scan it again and create a new processing plan.",
            409,
        )


def require_source(dataset: Any, path: Path) -> None:
    """Preserve the signed single-band GeoTIFF input policy for both operations.

    Args:
        dataset: Open catalog-authorized dataset.
        path: Catalog-authorized source path.

    Raises:
        ProcessingError: For unsupported input structure or unsigned dependencies.
    """
    try:
        require_signed_raster_dependencies(dataset, path)
        require_raster_analysis_georeferencing(dataset)
        require_bounded_source_structure(dataset)
        if dataset.driver != "GTiff":
            raise ValueError("GeoTIFF required")
    except ValueError as error:
        raise ProcessingError("unsupported_source", str(error)) from error


def select_area(
    dataset: Any, kind: str, bounds: Any, geometries: Any, max_coordinates: int
) -> SelectedRasterArea:
    """Project an already-validated bounds/AOI value through neutral mechanisms.

    Args:
        dataset: Validated open native raster.
        kind: Explicit bounds or aoi variant.
        bounds: Canonical WGS84 rectangle.
        geometries: Immutable AOI polygons.
        max_coordinates: Transformation budget.

    Returns:
        Native window and projected geometry for operation-owned inclusion rules.
    """
    try:
        if kind == "bounds":
            return selected_raster_area_for_wgs84_bounds(dataset, bounds)
        return selected_raster_area_for_wgs84_polygons(
            dataset, geometries, max_coordinates
        )
    except NoRasterBoundsOverlapError as error:
        raise ProcessingError(
            "no_overlap", "The selected area does not overlap this raster."
        ) from error
    except (ValueError, TypeError, OverflowError) as error:
        raise ProcessingError(
            "invalid_area",
            "The selected area cannot be projected within the processing geometry limit.",
        ) from error


def native_work(
    dataset: Any, window: Any, max_blocks: int, max_decoded_bytes: int
) -> tuple[int, int]:
    """Bound block-index allocation and total decoded source work before reading.

    Args:
        dataset: Validated native dataset.
        window: Integral requested source window.
        max_blocks: Maximum number of intersecting blocks.
        max_decoded_bytes: Maximum decoded bytes across those blocks.

    Returns:
        Native block count and decoded byte count.

    Raises:
        ProcessingError: If the conservative block estimate or decoded byte
            count exceeds its limit, with both amounts in the public detail.
    """
    bh, bw = dataset.block_shapes[0]
    # Include one boundary block per axis to bound index allocation before
    # constructing the tuple. This is an admission estimate, not an exact count.
    estimated_blocks = (math.ceil(window.width / bw) + 1) * (
        math.ceil(window.height / bh) + 1
    )
    if estimated_blocks > max_blocks:
        raise ProcessingError(
            "source_work_too_large",
            f"The selected area's conservative estimate is {estimated_blocks:,} "
            f"native blocks; the limit is {max_blocks:,} "
            f"({estimated_blocks - max_blocks:,} over the limit). "
            f"Choose a smaller area with an estimate of {max_blocks:,} blocks or fewer.",
            413,
        )
    blocks = source_block_indexes_for_window(window, dataset.block_shapes[0])
    decoded = decoded_source_bytes_for_blocks(dataset, blocks)
    if decoded > max_decoded_bytes:
        raise ProcessingError(
            "source_work_too_large",
            f"The selected area requires {decoded:,} decoded bytes for source "
            f"values and validity masks; the limit is {max_decoded_bytes:,} bytes "
            f"({decoded - max_decoded_bytes:,} bytes over). Choose a smaller area "
            f"requiring at most {max_decoded_bytes:,} decoded bytes.",
            413,
        )
    return len(blocks), decoded
