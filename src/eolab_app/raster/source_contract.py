"""Rendering-neutral contracts for bounded scanner-signed raster reads."""

import math
from pathlib import Path
from typing import TypeAlias

import numpy
import rasterio
from affine import TransformNotInvertibleError
from rasterio.enums import MaskFlags
from rasterio.windows import Window


# Exact reads already admit no more than 64 MiB of cumulative decoded source
# work. Applying that established ceiling to each streamed native block bounds
# the reader's largest one-at-a-time value-plus-validity allocation without
# rejecting safe long, narrow strips solely because one edge is long.
BOUNDED_RASTER_MAX_NATIVE_BLOCK_DECODED_BYTES = 64 * 1024 * 1024
SUPPORTED_RASTER_ANALYSIS_DATA_TYPES = frozenset(
    {"uint8", "uint16", "int16", "int32", "float32", "float64"}
)
SourceBlockIndex: TypeAlias = tuple[int, int]


def require_signed_raster_dependencies(
    dataset: rasterio.io.DatasetReader,
    source_path: Path,
) -> None:
    """Reject GDAL sidecars outside the authorized source signature.

    Args:
        dataset: Open raster whose GDAL dependencies are known.
        source_path: Scanner-authorized GeoTIFF signed by the catalog.

    Returns:
        None when GDAL reports only the signed GeoTIFF dependency.

    Raises:
        ValueError: If an external mask, overview, or auxiliary metadata file
            could influence analysis or georeferencing.
    """
    signed_source = source_path.resolve(strict=False)
    dependencies = {
        Path(dataset_file).resolve(strict=False)
        for dataset_file in dataset.files
    }
    if dependencies != {signed_source}:
        raise ValueError(
            "Bounded raster reads require validity and georeferencing metadata "
            "embedded in the signed GeoTIFF; external GDAL sidecars are "
            "unsupported"
        )


def require_raster_analysis_georeferencing(
    dataset: rasterio.io.DatasetReader,
) -> None:
    """Require a declared CRS and finite, safely invertible source affine.

    Args:
        dataset: Open raster at the statistics reader boundary.

    Returns:
        None when source coordinates can be transformed safely.

    Raises:
        ValueError: If the CRS is absent or the affine is non-finite or cannot
            be inverted to finite coefficients.
    """
    if dataset.crs is None:
        raise ValueError("Bounded raster reads require a valid source CRS")
    source_transform = dataset.transform
    if not all(
        math.isfinite(float(value))
        for value in tuple(source_transform)[:6]
    ):
        raise ValueError("Bounded raster reads require a finite source transform")
    try:
        inverse_transform = ~source_transform
    except TransformNotInvertibleError:
        raise ValueError(
            "Bounded raster reads require an invertible source transform"
        ) from None
    if not all(
        math.isfinite(float(value))
        for value in tuple(inverse_transform)[:6]
    ):
        raise ValueError(
            "Bounded raster reads require a safely invertible source transform"
        )


def require_bounded_source_structure(
    dataset: rasterio.io.DatasetReader,
) -> None:
    """Require one band with byte-bounded blocks and signed validity metadata.

    Args:
        dataset: Open candidate raster dataset.

    Returns:
        None when each native band-one block has a supported structure and a
        conservatively bounded decoded value-plus-validity allocation.

    Raises:
        ValueError: If band, datatype, block, or validity structure is
            unsupported.
    """
    if dataset.count != 1 or dataset.width < 1 or dataset.height < 1:
        raise ValueError("Bounded raster reads require one non-empty band")
    if not dataset.block_shapes or len(dataset.block_shapes[0]) != 2:
        raise ValueError("Bounded raster reads require native block metadata")
    if dataset.dtypes[0] not in SUPPORTED_RASTER_ANALYSIS_DATA_TYPES:
        raise ValueError(
            "Bounded raster reads do not support "
            f"{dataset.dtypes[0]} band values"
        )
    block_height, block_width = (
        int(value) for value in dataset.block_shapes[0]
    )
    if block_height < 1 or block_width < 1:
        raise ValueError("Bounded raster reads require positive native blocks")
    decoded_block_bytes = (
        block_height
        * block_width
        * (numpy.dtype(dataset.dtypes[0]).itemsize + 1)
    )
    if decoded_block_bytes > BOUNDED_RASTER_MAX_NATIVE_BLOCK_DECODED_BYTES:
        raise ValueError(
            "Bounded raster reads require each native block to decode to no "
            f"more than {BOUNDED_RASTER_MAX_NATIVE_BLOCK_DECODED_BYTES} "
            f"bytes; this layout requires {decoded_block_bytes} bytes per "
            "block"
        )
    mask_flags = set(dataset.mask_flag_enums[0])
    if not mask_flags.issubset({MaskFlags.all_valid, MaskFlags.nodata}):
        raise ValueError(
            "Bounded raster reads do not support alpha or per-dataset "
            "validity masks"
        )


def read_native_raster_block(
    dataset: rasterio.io.DatasetReader,
    window: Window,
) -> numpy.ma.MaskedArray:
    """Read one exact band block and derive validity without mask I/O.

    Args:
        dataset: Open source whose validity contract is established.
        window: Exact integral native band-one block window.

    Returns:
        Source values masked only by the signed band's nodata metadata.

    Raises:
        rasterio.errors.RasterioError: If the bounded band read fails.
    """
    values = dataset.read(1, window=window, masked=False)
    nodata = dataset.nodatavals[0]
    if nodata is None:
        mask = numpy.zeros(values.shape, dtype=bool)
    elif math.isnan(float(nodata)):
        mask = numpy.isnan(values)
    else:
        mask = values == nodata
    return numpy.ma.array(values, mask=mask)


def decoded_source_bytes_for_blocks(
    dataset: rasterio.io.DatasetReader,
    block_indexes: tuple[SourceBlockIndex, ...],
) -> int:
    """Return conservative decoded band and validity bytes for blocks.

    Args:
        dataset: Open one-band raster with native block metadata.
        block_indexes: Unique native block row/column indexes.

    Returns:
        Conservative decoded byte total for the supplied blocks.
    """
    bytes_per_pixel = numpy.dtype(dataset.dtypes[0]).itemsize + 1
    return sum(
        int(window.width) * int(window.height) * bytes_per_pixel
        for window in (
            dataset.block_window(1, block_row, block_column)
            for block_row, block_column in block_indexes
        )
    )


def source_block_indexes_for_window(
    window: Window,
    block_shape: tuple[int, int],
) -> tuple[SourceBlockIndex, ...]:
    """Return all native blocks intersecting an integral source window.

    Args:
        window: Positive integral source window inside the raster.
        block_shape: Native block height and width.

    Returns:
        Intersecting native block indexes in row-major order.
    """
    block_height, block_width = block_shape
    row_start = int(window.row_off) // block_height
    row_stop = (int(window.row_off + window.height) - 1) // block_height
    column_start = int(window.col_off) // block_width
    column_stop = (int(window.col_off + window.width) - 1) // block_width
    return tuple(
        (block_row, block_column)
        for block_row in range(row_start, row_stop + 1)
        for block_column in range(column_start, column_stop + 1)
    )
