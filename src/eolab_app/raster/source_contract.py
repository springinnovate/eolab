"""Rendering-neutral contracts for bounded scanner-signed raster reads."""

import math
from pathlib import Path
from typing import TypeAlias

import numpy
from numpy.typing import NDArray
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
RASTER_VALIDITY_POLICY = "finite-unmasked-non-nodata-v1"


def internal_mask_block_shape(
    dataset: rasterio.io.DatasetReader,
) -> tuple[int, int] | None:
    """Inspect the embedded mask's own blocks without reading pixel values.

    Rasterio exposes data blocks but not mask blocks. GDAL's existing Python
    bindings supply that metadata; mask tiles need not match data tiles.
    The caller must already have checked the signed file dependencies.

    Args:
        dataset: Open, authorized GeoTIFF retained throughout the inspection.

    Returns:
        Mask block height and width, or None when no dataset mask exists.

    Raises:
        ValueError: If mask metadata cannot be verified or uses alpha validity.
    """
    flags = set(dataset.mask_flag_enums[0])
    if MaskFlags.alpha in flags:
        raise ValueError("Bounded raster reads do not support alpha validity masks")
    if MaskFlags.per_dataset not in flags:
        return None
    from osgeo import gdal

    try:
        with (
            gdal.ExceptionMgr(),
            gdal.OpenEx(
                dataset.name,
                gdal.OF_RASTER | gdal.OF_READONLY,
                allowed_drivers=["GTiff"],
            ) as source,
        ):
            if source is None:
                raise ValueError("Cannot inspect the embedded raster mask")
            if {Path(name).resolve() for name in source.GetFileList()} != {
                Path(dataset.name).resolve()
            }:
                raise ValueError("Raster mask metadata requires unsigned sidecars")
            band = source.GetRasterBand(1)
            mask = band.GetMaskBand()
            width, height = mask.GetBlockSize()
            if (
                band.GetMaskFlags() != gdal.GMF_PER_DATASET
                or mask.XSize != dataset.width
                or mask.YSize != dataset.height
                or mask.DataType != gdal.GDT_Byte
                or width < 1
                or height < 1
            ):
                raise ValueError("Unsupported embedded raster mask structure")
            return height, width
    except RuntimeError as error:
        raise ValueError("Cannot inspect the embedded raster mask") from error


def mask_invalid_raster_values(
    values: NDArray[numpy.generic],
    nodata: float | int | None,
    validity: NDArray[numpy.generic] | None = None,
) -> numpy.ma.MaskedArray:
    """Exclude nonfinite, NoData and mask-invalid cells while preserving valid zero.

    An embedded mask adds exclusions; it never overrides the band's NoData.

    Args:
        values: Numeric band values on a caller-bounded grid.
        nodata: Original band's declared NoData, including NaN or None.
        validity: Optional equally shaped GDAL mask; zero is invalid.

    Returns:
        Original values with the combined boolean mask, without copying values.
    """
    valid = numpy.isfinite(values)
    if nodata is not None:
        numpy.not_equal(values, nodata, out=valid, where=valid)
    if validity is not None:
        numpy.logical_and(valid, validity, out=valid)
    numpy.logical_not(valid, out=valid)
    return numpy.ma.array(values, mask=valid, copy=False)


def _require_mask_block_memory(
    dataset: rasterio.io.DatasetReader, value_block_bytes: int
) -> None:
    """Bound mask decoding alongside the admitted value and boolean buffers.

    Args:
        dataset: Source whose signed dependencies were checked.
        value_block_bytes: One data block plus its returned boolean mask.

    Raises:
        ValueError: If the combined native allocation exceeds 64 MiB.
    """
    shape = internal_mask_block_shape(dataset)
    if shape is not None and (
        value_block_bytes
        + max(
            shape[0] * shape[1], dataset.block_shapes[0][0] * dataset.block_shapes[0][1]
        )
        > BOUNDED_RASTER_MAX_NATIVE_BLOCK_DECODED_BYTES
    ):
        raise ValueError("Raster data and mask blocks exceed the 64 MiB memory limit")


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


def require_pixel_source_structure(dataset: rasterio.io.DatasetReader) -> None:
    """Require a numeric first band whose native blocks fit the pixel reader's limit.

    Embedded mask blocks are bounded separately from data blocks.

    Args:
        dataset: Open GeoTIFF whose file dependencies and georeferencing are checked.

    Raises:
        ValueError: If band-one values or their decoded blocks are unsupported.
    """
    if dataset.count < 1 or dataset.dtypes[0] not in {
        "uint8",
        "uint16",
        "int16",
        "uint32",
        "int32",
        "float32",
        "float64",
    }:
        raise ValueError("Pixel reading requires a numeric first raster band.")
    height, width = dataset.block_shapes[0]
    if (
        height * width * (numpy.dtype(dataset.dtypes[0]).itemsize + 1)
        > BOUNDED_RASTER_MAX_NATIVE_BLOCK_DECODED_BYTES
    ):
        raise ValueError("Raster blocks exceed the pixel reader's 64 MiB memory limit.")
    _require_mask_block_memory(
        dataset, height * width * (numpy.dtype(dataset.dtypes[0]).itemsize + 1)
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
    if not mask_flags.issubset(
        {MaskFlags.all_valid, MaskFlags.nodata, MaskFlags.per_dataset}
    ):
        raise ValueError(
            "Bounded raster reads do not support alpha or unknown validity masks"
        )
    _require_mask_block_memory(dataset, decoded_block_bytes)


def read_native_raster_block(
    dataset: rasterio.io.DatasetReader,
    window: Window,
) -> numpy.ma.MaskedArray:
    """Read one exact band block with its embedded validity and NoData exclusions.

    Args:
        dataset: Open source whose validity contract is established.
        window: Exact integral native band-one block window.

    Returns:
        Finite native values masked by both NoData and embedded validity.

    Raises:
        rasterio.errors.RasterioError: If the bounded band read fails.
    """
    return read_native_raster_window(dataset, window)


def read_native_raster_window(
    dataset: rasterio.io.DatasetReader, window: Window
) -> numpy.ma.MaskedArray:
    """Read a caller-admitted native window with the established validity policy.

    Args:
        dataset: Open source whose validity contract is established.
        window: Bounded integral window inside the source, admitted by the caller.

    Returns:
        Native band-one values with combined mask, NoData and nonfinite
        exclusions. Neither values nor validity are resampled.

    Raises:
        rasterio.errors.RasterioError: If native band or mask I/O fails.
    """
    values = dataset.read(1, window=window, masked=False)
    validity = (
        dataset.read_masks(1, window=window)
        if MaskFlags.per_dataset in dataset.mask_flag_enums[0]
        else None
    )
    return mask_invalid_raster_values(values, dataset.nodatavals[0], validity)


def source_work_for_blocks(
    dataset: rasterio.io.DatasetReader,
    block_indexes: tuple[SourceBlockIndex, ...],
) -> tuple[int, int]:
    """Count native data/mask reads and their conservative decoded bytes.

    Each data window is charged for every mask block it intersects, including
    repeated mask blocks across windows. No GDAL cache hit is assumed. Masked
    sources are charged full native blocks even at raster edges.

    Args:
        dataset: Open one-band raster with native block metadata.
        block_indexes: Unique native block row/column indexes.

    Returns:
        Combined data/mask block-read count and decoded value/validity bytes.

    Raises:
        ValueError: If embedded mask metadata cannot be verified.
    """
    bytes_per_pixel = numpy.dtype(dataset.dtypes[0]).itemsize + 1
    mask_shape = internal_mask_block_shape(dataset)
    count = len(block_indexes)
    decoded = 0
    for index in block_indexes:
        window = dataset.block_window(1, *index)
        if mask_shape is None:
            decoded += int(window.width) * int(window.height) * bytes_per_pixel
            continue
        height, width = dataset.block_shapes[0]
        decoded += height * width * bytes_per_pixel
        mh, mw = mask_shape
        mask_blocks = (
            math.ceil((window.row_off + window.height) / mh) - int(window.row_off) // mh
        ) * (
            math.ceil((window.col_off + window.width) / mw) - int(window.col_off) // mw
        )
        count += mask_blocks
        decoded += mask_blocks * mh * mw
    return count, decoded


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
