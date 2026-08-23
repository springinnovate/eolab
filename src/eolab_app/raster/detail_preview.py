"""Strictly bounded Rasterio algorithms for detail-only raster previews."""

import base64
import binascii
import math
import struct
import zlib
from pathlib import Path

import numpy
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import array_bounds, from_bounds, xy
from rasterio.warp import reproject, transform, transform_bounds
from rasterio.windows import Window, transform as window_transform

from eolab_app.raster.models import (
    RasterDetailPreview,
    RasterDetailPreviewLimits,
    RasterDetailPreviewMode,
    RasterDetailSample,
)


DETAIL_PREVIEW_POLICY_VERSION = "bounded-detail-preview-v1"
DETAIL_PREVIEW_GRID_EDGE = 5
DETAIL_PREVIEW_MAX_GRID_SAMPLES = DETAIL_PREVIEW_GRID_EDGE**2
DETAIL_PREVIEW_PATCH_DIMENSION = 128
DETAIL_PREVIEW_CANDIDATE_FRACTIONS = (0.2, 0.5, 0.8)
DETAIL_PREVIEW_MAX_PATCH_CANDIDATES = (
    len(DETAIL_PREVIEW_CANDIDATE_FRACTIONS) ** 2
)


class NoUsefulDetailPatchError(ValueError):
    """Raised when every bounded representative-patch candidate is nodata."""


def _sample_value(sample: numpy.ma.MaskedArray) -> float | None:
    """Convert one masked sample to an honest finite public value.

    Args:
        sample: One-by-one masked Rasterio sample.

    Returns:
        A finite float, or ``None`` for nodata/non-finite data.
    """
    if sample.count() == 0:
        return None
    value = float(sample[0, 0])
    return value if math.isfinite(value) else None


def _wgs84_sample_positions(
    dataset: rasterio.io.DatasetReader,
    rows: list[int],
    columns: list[int],
) -> tuple[list[float], list[float]]:
    """Transform source-cell centers to explicit WGS 84 axis order.

    Args:
        dataset: Open raster with a validated CRS.
        rows: Source row indexes.
        columns: Source column indexes paired with ``rows``.

    Returns:
        Longitude and latitude arrays.

    Raises:
        ValueError: If the raster has no CRS or transformation is non-finite.
    """
    if dataset.crs is None:
        raise ValueError("Detail-only preview requires a valid raster CRS")
    source_x, source_y = xy(dataset.transform, rows, columns, offset="center")
    longitudes, latitudes = transform(
        dataset.crs,
        "EPSG:4326",
        source_x,
        source_y,
    )
    if not all(
        math.isfinite(coordinate)
        for coordinate in (*longitudes, *latitudes)
    ):
        raise ValueError("Raster sample positions could not be georeferenced")
    return list(longitudes), list(latitudes)


def _read_samples(
    dataset: rasterio.io.DatasetReader,
    rows: list[int],
    columns: list[int],
) -> list[RasterDetailSample]:
    """Read fixed one-pixel windows and preserve their spatial placement.

    Args:
        dataset: Open raster dataset.
        rows: Valid source row indexes.
        columns: Valid source column indexes paired with ``rows``.

    Returns:
        Georeferenced samples in the supplied deterministic order.
    """
    longitudes, latitudes = _wgs84_sample_positions(dataset, rows, columns)
    samples: list[RasterDetailSample] = []
    for row, column, longitude, latitude in zip(
        rows,
        columns,
        longitudes,
        latitudes,
        strict=True,
    ):
        value = _sample_value(
            dataset.read(
                1,
                window=Window(column, row, 1, 1),
                masked=True,
            )
        )
        samples.append(
            RasterDetailSample(
                row=row,
                column=column,
                longitude=longitude,
                latitude=latitude,
                value=value,
            )
        )
    return samples


def _grid_indexes(size: int) -> list[int]:
    """Return at most five deterministic cell indexes across one raster axis.

    Args:
        size: Positive source axis length.

    Returns:
        Unique cell indexes from the first through final source cell.
    """
    count = min(DETAIL_PREVIEW_GRID_EDGE, size)
    if count == 1:
        return [size // 2]
    return [
        round((size - 1) * index / (count - 1))
        for index in range(count)
    ]


def _candidate_windows(
    width: int,
    height: int,
) -> list[Window]:
    """Return the fixed three-by-three representative-patch candidates.

    Args:
        width: Positive raster width.
        height: Positive raster height.

    Returns:
        At most nine unique windows, each no larger than 128 by 128 pixels.
    """
    patch_width = min(width, DETAIL_PREVIEW_PATCH_DIMENSION)
    patch_height = min(height, DETAIL_PREVIEW_PATCH_DIMENSION)
    windows: list[Window] = []
    for row_fraction in DETAIL_PREVIEW_CANDIDATE_FRACTIONS:
        for column_fraction in DETAIL_PREVIEW_CANDIDATE_FRACTIONS:
            column_offset = min(
                width - patch_width,
                max(0, round((width - 1) * column_fraction - patch_width / 2)),
            )
            row_offset = min(
                height - patch_height,
                max(0, round((height - 1) * row_fraction - patch_height / 2)),
            )
            window = Window(
                column_offset,
                row_offset,
                patch_width,
                patch_height,
            )
            if window not in windows:
                windows.append(window)
    return windows


def _png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    """Encode one PNG chunk with its length and checksum.

    Args:
        chunk_type: Four-byte PNG chunk type.
        data: Raw chunk payload.

    Returns:
        Complete encoded PNG chunk.
    """
    checksum = binascii.crc32(chunk_type)
    checksum = binascii.crc32(data, checksum) & 0xFFFFFFFF
    return (
        struct.pack(">I", len(data))
        + chunk_type
        + data
        + struct.pack(">I", checksum)
    )


def _rgba_png_data_url(rgba: numpy.ndarray) -> str:
    """Encode one bounded uint8 RGBA array without an imaging dependency.

    Args:
        rgba: Height-by-width-by-four uint8 pixel array.

    Returns:
        Base64 PNG data URL suitable for a Leaflet image overlay.

    Raises:
        ValueError: If the array does not satisfy the encoder contract.
    """
    if rgba.dtype != numpy.uint8 or rgba.ndim != 3 or rgba.shape[2] != 4:
        raise ValueError("PNG preview requires an H-by-W-by-4 uint8 array")
    height, width, _ = rgba.shape
    scanlines = b"".join(
        b"\x00" + rgba[row].tobytes()
        for row in range(height)
    )
    png = b"\x89PNG\r\n\x1a\n" + b"".join(
        (
            _png_chunk(
                b"IHDR",
                struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0),
            ),
            _png_chunk(b"IDAT", zlib.compress(scanlines, level=6)),
            _png_chunk(b"IEND", b""),
        )
    )
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def _render_patch(
    dataset: rasterio.io.DatasetReader,
    window: Window,
    sample: numpy.ma.MaskedArray,
) -> tuple[tuple[float, float, float, float], str]:
    """Warp one already-read source window into a bounded WGS 84 PNG.

    Args:
        dataset: Open source dataset.
        window: Selected bounded source window.
        sample: Masked band-1 pixels read exactly from ``window``.

    Returns:
        WGS 84 image bounds and a transparent grayscale PNG data URL.

    Raises:
        ValueError: If the source CRS or transformed bounds are invalid.
        rasterio.errors.RasterioError: If the bounded reprojection fails.
    """
    if dataset.crs is None:
        raise ValueError("Detail-only preview requires a valid raster CRS")
    source_transform = window_transform(window, dataset.transform)
    source_bounds = array_bounds(
        int(window.height),
        int(window.width),
        source_transform,
    )
    west, south, east, north = transform_bounds(
        dataset.crs,
        "EPSG:4326",
        *source_bounds,
        densify_pts=21,
    )
    if not (
        all(math.isfinite(value) for value in (west, south, east, north))
        and west < east
        and south < north
    ):
        raise ValueError("Detail patch bounds could not be georeferenced")

    source_values = numpy.asarray(
        numpy.ma.filled(sample, numpy.nan),
        dtype=numpy.float64,
    )
    source_valid = numpy.asarray(
        ~numpy.ma.getmaskarray(sample) & numpy.isfinite(source_values),
        dtype=numpy.uint8,
    )
    destination_values = numpy.full(
        (DETAIL_PREVIEW_PATCH_DIMENSION, DETAIL_PREVIEW_PATCH_DIMENSION),
        numpy.nan,
        dtype=numpy.float64,
    )
    destination_valid = numpy.zeros(
        destination_values.shape,
        dtype=numpy.uint8,
    )
    destination_transform = from_bounds(
        west,
        south,
        east,
        north,
        DETAIL_PREVIEW_PATCH_DIMENSION,
        DETAIL_PREVIEW_PATCH_DIMENSION,
    )
    reproject(
        source_values,
        destination_values,
        src_transform=source_transform,
        src_crs=dataset.crs,
        src_nodata=numpy.nan,
        dst_transform=destination_transform,
        dst_crs="EPSG:4326",
        dst_nodata=numpy.nan,
        resampling=Resampling.nearest,
    )
    reproject(
        source_valid,
        destination_valid,
        src_transform=source_transform,
        src_crs=dataset.crs,
        src_nodata=0,
        dst_transform=destination_transform,
        dst_crs="EPSG:4326",
        dst_nodata=0,
        resampling=Resampling.nearest,
    )
    valid = (destination_valid == 1) & numpy.isfinite(destination_values)
    valid_values = destination_values[valid]
    if valid_values.size == 0:
        raise NoUsefulDetailPatchError
    lower, upper = numpy.percentile(valid_values, (2, 98))
    if lower == upper:
        intensity = numpy.full(destination_values.shape, 160, dtype=numpy.uint8)
    else:
        normalized = numpy.zeros(destination_values.shape, dtype=numpy.float64)
        normalized[valid] = numpy.clip(
            (destination_values[valid] - lower) / (upper - lower),
            0,
            1,
        )
        intensity = numpy.asarray(
            normalized * 255,
            dtype=numpy.uint8,
        )
    rgba = numpy.zeros((*destination_values.shape, 4), dtype=numpy.uint8)
    rgba[..., 0] = intensity
    rgba[..., 1] = intensity
    rgba[..., 2] = intensity
    rgba[..., 3] = numpy.where(valid, 230, 0).astype(numpy.uint8)
    return (west, south, east, north), _rgba_png_data_url(rgba)


def _representative_patch(
    dataset: rasterio.io.DatasetReader,
) -> tuple[tuple[float, float, float, float], str]:
    """Select and render one patch using deterministic bounded candidates.

    Candidates are visited in top-left row-major order. Ranking uses valid
    coverage first, population standard deviation second, then the earliest
    candidate as the stable tie-breaker. Each candidate is read once and is at
    most 128 by 128 source pixels.

    Args:
        dataset: Open band-1 raster.

    Returns:
        WGS 84 bounds and PNG for the selected patch.

    Raises:
        NoUsefulDetailPatchError: If every candidate is nodata/non-finite.
        ValueError: If georeferencing fails.
        rasterio.errors.RasterioError: If a bounded read or warp fails.
    """
    candidates: list[tuple[tuple[float, float, int], Window, numpy.ma.MaskedArray]] = []
    for index, window in enumerate(
        _candidate_windows(dataset.width, dataset.height)
    ):
        sample = dataset.read(1, window=window, masked=True)
        values = numpy.asarray(sample.compressed(), dtype=numpy.float64)
        values = values[numpy.isfinite(values)]
        valid_coverage = values.size / (int(window.width) * int(window.height))
        variability = float(numpy.std(values)) if values.size else 0.0
        candidates.append(
            ((valid_coverage, variability, -index), window, sample)
        )
    score, selected_window, selected_sample = max(
        candidates,
        key=lambda candidate: candidate[0],
    )
    if score[0] == 0:
        raise NoUsefulDetailPatchError
    return _render_patch(dataset, selected_window, selected_sample)


def read_raster_detail_preview(
    source_path: Path,
    mode: RasterDetailPreviewMode,
    raster_extent: tuple[float, float, float, float],
) -> RasterDetailPreview:
    """Read one fixed, bounded detail-only preview from band 1.

    ``centerPixel`` performs exactly one one-pixel read. ``samplingGrid``
    performs at most 25 one-pixel reads. ``representativePatch`` performs at
    most nine 128-by-128 reads and reuses the selected candidate for rendering.

    Args:
        source_path: Authorized mounted GeoTIFF.
        mode: Explicit preview mode selected by the user.
        raster_extent: Authoritative cataloged WGS 84 raster extent.

    Returns:
        Browser-safe georeferenced preview with public resource limits.

    Raises:
        NoUsefulDetailPatchError: If bounded patch candidates contain no data.
        OSError: If the source cannot be read.
        rasterio.errors.RasterioError: If GDAL cannot open/read/reproject it.
        ValueError: If the dataset contract or georeferencing is invalid.
    """
    labels = {
        "centerPixel": "Approximate detail-only center-pixel preview",
        "samplingGrid": "Approximate detail-only sampling-grid preview",
        "representativePatch": "Approximate representative detail patch",
    }
    if mode not in labels:
        raise ValueError(f"Unsupported detail preview mode: {mode}")
    limits = RasterDetailPreviewLimits(
        maximumGridSamples=DETAIL_PREVIEW_MAX_GRID_SAMPLES,
        maximumPatchDimension=DETAIL_PREVIEW_PATCH_DIMENSION,
        maximumPatchCandidates=DETAIL_PREVIEW_MAX_PATCH_CANDIDATES,
    )
    with rasterio.open(source_path) as dataset:
        if dataset.count != 1 or dataset.width < 1 or dataset.height < 1:
            raise ValueError("Detail-only preview requires one non-empty band")
        if mode == "centerPixel":
            samples = _read_samples(
                dataset,
                [dataset.height // 2],
                [dataset.width // 2],
            )
            return RasterDetailPreview(
                mode=mode,
                policyVersion=DETAIL_PREVIEW_POLICY_VERSION,
                label=labels[mode],
                rasterExtent=raster_extent,
                samples=samples,
                limits=limits,
            )
        if mode == "samplingGrid":
            rows = _grid_indexes(dataset.height)
            columns = _grid_indexes(dataset.width)
            sample_rows = [row for row in rows for _ in columns]
            sample_columns = [column for _ in rows for column in columns]
            return RasterDetailPreview(
                mode=mode,
                policyVersion=DETAIL_PREVIEW_POLICY_VERSION,
                label=labels[mode],
                rasterExtent=raster_extent,
                samples=_read_samples(dataset, sample_rows, sample_columns),
                limits=limits,
            )
        detail_bounds, image_data_url = _representative_patch(dataset)
        return RasterDetailPreview(
            mode=mode,
            policyVersion=DETAIL_PREVIEW_POLICY_VERSION,
            label=labels[mode],
            rasterExtent=raster_extent,
            samples=[],
            detailBounds=detail_bounds,
            imageDataUrl=image_data_url,
            limits=limits,
        )
