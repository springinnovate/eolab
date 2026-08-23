"""Bounded numeric images for approximate raster visualization."""

import math
from pathlib import Path

import numpy
import rasterio
from affine import Affine
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.warp import reproject, transform as warp_transform
from rasterio.windows import Window, transform as window_transform

from eolab_app.raster.detail_proxy import (
    DETAIL_PROXY_MAX_DECODED_SOURCE_BYTES,
    DETAIL_PROXY_MAX_DIMENSION,
    DETAIL_PROXY_MAX_POINTS_PER_CELL,
    DETAIL_PROXY_MAX_SOURCE_BLOCK_READS,
    BoundedWindowSamples,
    read_bounded_candidate_windows,
    read_detail_proxy,
)
from eolab_app.raster.models import (
    RasterDetailPreview,
    RasterDetailPreviewLimits,
    RasterDetailPreviewMode,
    RasterDetailPreviewWork,
    RasterValueRange,
)
from eolab_app.raster.statistics import strict_raster_value_range


DETAIL_PREVIEW_POLICY_VERSION = "bounded-sampled-raster-v2"
DETAIL_PREVIEW_PATCH_DIMENSION = 128
DETAIL_PREVIEW_CANDIDATE_FRACTIONS = (0.2, 0.5, 0.8)
DETAIL_PREVIEW_MAX_PATCH_CANDIDATES = (
    len(DETAIL_PREVIEW_CANDIDATE_FRACTIONS) ** 2
)
DETAIL_PREVIEW_EDGE_DENSIFY_SEGMENTS = 21
WEB_MERCATOR_LIMIT = 20_037_508.342789244


class NoUsefulDetailPatchError(ValueError):
    """Raised when every bounded representative-patch candidate is nodata."""


def _require_signed_geotiff_dependencies(
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
            could influence sampling or georeferencing.
    """
    signed_source = source_path.resolve(strict=False)
    dependencies = {
        Path(dataset_file).resolve(strict=False)
        for dataset_file in dataset.files
    }
    if dependencies != {signed_source}:
        raise ValueError(
            "Sampled raster preview requires validity and georeferencing "
            "metadata embedded in the signed GeoTIFF; external GDAL "
            "sidecars are unsupported"
        )


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


def _densified_array_edge_positions(
    source_transform: Affine,
    width: int,
    height: int,
) -> tuple[list[float], list[float]]:
    """Trace a rotated or skewed numeric image boundary in its source CRS.

    Args:
        source_transform: Affine mapping numeric-image pixels to source CRS.
        width: Positive numeric-image width.
        height: Positive numeric-image height.

    Returns:
        Source-CRS x and y positions along every densified image edge.
    """
    corners = (
        ((0.0, 0.0), (float(width), 0.0)),
        ((float(width), 0.0), (float(width), float(height))),
        ((float(width), float(height)), (0.0, float(height))),
        ((0.0, float(height)), (0.0, 0.0)),
    )
    source_x: list[float] = []
    source_y: list[float] = []
    for edge_index, (start, end) in enumerate(corners):
        first_step = 0 if edge_index == 0 else 1
        for step in range(
            first_step,
            DETAIL_PREVIEW_EDGE_DENSIFY_SEGMENTS + 1,
        ):
            fraction = step / DETAIL_PREVIEW_EDGE_DENSIFY_SEGMENTS
            pixel_position = (
                start[0] + (end[0] - start[0]) * fraction,
                start[1] + (end[1] - start[1]) * fraction,
            )
            x, y = source_transform * pixel_position
            source_x.append(x)
            source_y.append(y)
    return source_x, source_y


def _web_mercator_bounds(
    source_crs: object,
    source_transform: Affine,
    width: int,
    height: int,
) -> tuple[float, float, float, float]:
    """Project and clip one numeric image boundary to Leaflet's single world.

    Args:
        source_crs: Valid Rasterio source CRS.
        source_transform: Affine mapping numeric-image pixels to source CRS.
        width: Positive numeric-image width.
        height: Positive numeric-image height.

    Returns:
        Strict west, south, east, north bounds in EPSG:3857.

    Raises:
        ValueError: If projection is non-finite or misses Leaflet's world.
    """
    source_x, source_y = _densified_array_edge_positions(
        source_transform,
        width,
        height,
    )
    projected_x, projected_y = warp_transform(
        source_crs,
        "EPSG:3857",
        source_x,
        source_y,
    )
    if not all(
        math.isfinite(value) for value in (*projected_x, *projected_y)
    ):
        raise ValueError("Sampled raster image could not be georeferenced")
    west = max(-WEB_MERCATOR_LIMIT, min(projected_x))
    south = max(-WEB_MERCATOR_LIMIT, min(projected_y))
    east = min(WEB_MERCATOR_LIMIT, max(projected_x))
    north = min(WEB_MERCATOR_LIMIT, max(projected_y))
    if west >= east or south >= north:
        raise ValueError("Sampled raster image is outside the displayable world")
    return west, south, east, north


def _warp_numeric_image(
    source_crs: object,
    source_transform: Affine,
    source_values: numpy.ma.MaskedArray,
    maximum_dimension: int,
) -> tuple[tuple[float, float, float, float], numpy.ma.MaskedArray]:
    """Warp only an already-bounded numeric image into Leaflet Web Mercator.

    Values and validity are warped independently with nearest-neighbor
    resampling so nodata remains transparent and is never converted to zero.

    Args:
        source_crs: Valid Rasterio source CRS.
        source_transform: Affine mapping bounded source values to source CRS.
        source_values: Masked numeric image already read under fixed limits.
        maximum_dimension: Fixed maximum destination image edge.

    Returns:
        WGS 84 image bounds and Web-Mercator-aligned masked values.

    Raises:
        ValueError: If CRS transformation or output bounds are invalid.
        rasterio.errors.RasterioError: If in-memory reprojection fails.
    """
    source_height, source_width = source_values.shape
    projected_bounds = _web_mercator_bounds(
        source_crs,
        source_transform,
        source_width,
        source_height,
    )
    destination_height = min(maximum_dimension, source_height)
    destination_width = min(maximum_dimension, source_width)
    destination_transform = from_bounds(
        *projected_bounds,
        destination_width,
        destination_height,
    )
    numeric_source = numpy.asarray(
        numpy.ma.filled(source_values, numpy.nan),
        dtype=numpy.float64,
    )
    valid_source = numpy.asarray(
        ~numpy.ma.getmaskarray(source_values) & numpy.isfinite(numeric_source),
        dtype=numpy.uint8,
    )
    destination_values = numpy.full(
        (destination_height, destination_width),
        numpy.nan,
        dtype=numpy.float64,
    )
    destination_valid = numpy.zeros(
        destination_values.shape,
        dtype=numpy.uint8,
    )
    reproject(
        numeric_source,
        destination_values,
        src_transform=source_transform,
        src_crs=source_crs,
        src_nodata=numpy.nan,
        dst_transform=destination_transform,
        dst_crs="EPSG:3857",
        dst_nodata=numpy.nan,
        resampling=Resampling.nearest,
    )
    reproject(
        valid_source,
        destination_valid,
        src_transform=source_transform,
        src_crs=source_crs,
        src_nodata=0,
        dst_transform=destination_transform,
        dst_crs="EPSG:3857",
        dst_nodata=0,
        resampling=Resampling.nearest,
    )
    longitudes, latitudes = warp_transform(
        "EPSG:3857",
        "EPSG:4326",
        [projected_bounds[0], projected_bounds[2]],
        [projected_bounds[1], projected_bounds[3]],
    )
    image_bounds = (
        float(longitudes[0]),
        float(latitudes[0]),
        float(longitudes[1]),
        float(latitudes[1]),
    )
    if not (
        all(math.isfinite(value) for value in image_bounds)
        and image_bounds[0] < image_bounds[2]
        and image_bounds[1] < image_bounds[3]
    ):
        raise ValueError("Sampled raster image bounds are invalid")
    mask = (destination_valid != 1) | ~numpy.isfinite(destination_values)
    return image_bounds, numpy.ma.array(destination_values, mask=mask)


def _suggested_range(
    values: numpy.ma.MaskedArray,
) -> RasterValueRange | None:
    """Derive the normal strict three-stop range from bounded preview values.

    Args:
        values: Bounded masked numeric image.

    Returns:
        Strict approximate fifth/median/ninety-fifth percentile range, or
        ``None`` when the bounded sample contains no finite values.
    """
    finite_values = numpy.asarray(values.compressed(), dtype=numpy.float64)
    finite_values = finite_values[numpy.isfinite(finite_values)]
    if finite_values.size == 0:
        return None
    p05, p50, p95 = numpy.percentile(finite_values, (5, 50, 95))
    return strict_raster_value_range(
        float(numpy.min(finite_values)),
        float(numpy.max(finite_values)),
        float(p05),
        float(p50),
        float(p95),
    )


def _flatten_values(values: numpy.ma.MaskedArray) -> list[float | None]:
    """Flatten one masked image to browser-safe row-major values.

    Args:
        values: Bounded masked numeric image.

    Returns:
        Finite floats and ``None`` for nodata/non-finite cells.
    """
    numeric_values = numpy.asarray(
        numpy.ma.filled(values, numpy.nan),
        dtype=numpy.float64,
    )
    mask = numpy.ma.getmaskarray(values) | ~numpy.isfinite(numeric_values)
    return [
        None if masked else float(value)
        for value, masked in zip(
            numeric_values.ravel(),
            mask.ravel(),
            strict=True,
        )
    ]


def _representative_patch(
    dataset: rasterio.io.DatasetReader,
) -> tuple[Window, numpy.ma.MaskedArray, BoundedWindowSamples]:
    """Select one patch using deterministic bounded candidate windows.

    Candidates are visited in top-left row-major order. Ranking uses valid
    coverage first, population standard deviation second, then the earliest
    candidate as the stable tie-breaker. Each candidate is read once and is at
    most 128 by 128 source pixels.

    Args:
        dataset: Open band-one raster.

    Returns:
        Selected source window, its already-read masked values, and the shared
        native-block work used for all admitted candidates.

    Raises:
        NoUsefulDetailPatchError: If every candidate is nodata/non-finite.
        rasterio.errors.RasterioError: If a bounded read fails.
    """
    bounded_samples = read_bounded_candidate_windows(
        dataset,
        _candidate_windows(dataset.width, dataset.height),
    )
    candidates: list[
        tuple[tuple[float, float, int], Window, numpy.ma.MaskedArray]
    ] = []
    for index, (window, sample) in enumerate(bounded_samples.samples):
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
    return selected_window, selected_sample, bounded_samples


def _limits() -> RasterDetailPreviewLimits:
    """Return the fixed public work limits for policy version two.

    Returns:
        Immutable response model containing every server-owned ceiling.
    """
    return RasterDetailPreviewLimits(
        maximumProxyDimension=DETAIL_PROXY_MAX_DIMENSION,
        maximumSourceBlockReads=DETAIL_PROXY_MAX_SOURCE_BLOCK_READS,
        maximumDecodedSourceBytes=DETAIL_PROXY_MAX_DECODED_SOURCE_BYTES,
        maximumPointsPerCell=DETAIL_PROXY_MAX_POINTS_PER_CELL,
        maximumPatchDimension=DETAIL_PREVIEW_PATCH_DIMENSION,
        maximumPatchCandidates=DETAIL_PREVIEW_MAX_PATCH_CANDIDATES,
    )


def _preview_response(
    mode: RasterDetailPreviewMode,
    label: str,
    raster_extent: tuple[float, float, float, float],
    image_bounds: tuple[float, float, float, float],
    values: numpy.ma.MaskedArray,
    actual_work: RasterDetailPreviewWork,
) -> RasterDetailPreview:
    """Build one validated common numeric-image response.

    Args:
        mode: Explicit user-selected preview policy.
        label: User-facing approximation description.
        raster_extent: Authoritative cataloged WGS 84 extent.
        image_bounds: WGS 84 placement of the Web-Mercator-aligned image.
        values: Bounded row-major masked numeric image.
        actual_work: Source-grid resolution and actual bounded source work.

    Returns:
        Browser-safe detail-only preview response.
    """
    image_height, image_width = values.shape
    return RasterDetailPreview(
        mode=mode,
        policyVersion=DETAIL_PREVIEW_POLICY_VERSION,
        label=label,
        rasterExtent=raster_extent,
        imageBounds=image_bounds,
        imageWidth=image_width,
        imageHeight=image_height,
        pixelValues=_flatten_values(values),
        suggestedRange=_suggested_range(values),
        limits=_limits(),
        actual=actual_work,
    )


def read_raster_detail_preview(
    source_path: Path,
    mode: RasterDetailPreviewMode,
    raster_extent: tuple[float, float, float, float],
) -> RasterDetailPreview:
    """Read one bounded numeric preview from an overview-limited raster.

    Full-extent modes adapt their grid density until unique native block reads
    and decoded band-one bytes fit fixed ceilings. Every native block is read
    once without ``out_shape``. The representative patch retains its fixed
    at-most-nine-candidate, 128-by-128-window policy; candidates that exceed
    the shared block/byte ceilings are skipped. Only already-bounded NumPy
    arrays are reprojected for Leaflet.

    Args:
        source_path: Authorized mounted GeoTIFF.
        mode: Explicit preview mode selected by the user.
        raster_extent: Authoritative cataloged WGS 84 raster extent.

    Returns:
        Browser-safe georeferenced numeric preview with public resource limits.

    Raises:
        NoUsefulDetailPatchError: If bounded patch candidates contain no data.
        OSError: If the source cannot be read.
        rasterio.errors.RasterioError: If GDAL cannot open/read/reproject it.
        ValueError: If the dataset contract or georeferencing is invalid.
    """
    labels = {
        "centerSample": (
            "Approximate full-extent proxy using each preview cell's center"
        ),
        "representativeSample": (
            "Approximate full-extent proxy using representative cell samples"
        ),
        "representativePatch": "Approximate representative detail patch",
    }
    if mode not in labels:
        raise ValueError(f"Unsupported detail preview mode: {mode}")
    with rasterio.open(source_path) as dataset:
        _require_signed_geotiff_dependencies(dataset, source_path)
        if dataset.count != 1 or dataset.width < 1 or dataset.height < 1:
            raise ValueError("Detail-only preview requires one non-empty band")
        if dataset.crs is None:
            raise ValueError("Detail-only preview requires a valid raster CRS")
        if mode in {"centerSample", "representativeSample"}:
            proxy_values, plan = read_detail_proxy(dataset, mode)
            source_transform = dataset.transform * Affine.scale(
                dataset.width / plan.width,
                dataset.height / plan.height,
            )
            image_bounds, image_values = _warp_numeric_image(
                dataset.crs,
                source_transform,
                proxy_values,
                DETAIL_PROXY_MAX_DIMENSION,
            )
            return _preview_response(
                mode,
                labels[mode],
                raster_extent,
                image_bounds,
                image_values,
                RasterDetailPreviewWork(
                    sampleGridWidth=plan.width,
                    sampleGridHeight=plan.height,
                    sourceBlockReadCount=len(plan.block_indexes),
                    decodedSourceBytes=plan.decoded_source_bytes,
                    pointsPerCell=plan.points_per_cell,
                    candidateWindowCount=0,
                ),
            )

        patch_window, patch_values, patch_work = _representative_patch(dataset)
        image_bounds, image_values = _warp_numeric_image(
            dataset.crs,
            window_transform(patch_window, dataset.transform),
            patch_values,
            DETAIL_PREVIEW_PATCH_DIMENSION,
        )
        return _preview_response(
            mode,
            labels[mode],
            raster_extent,
            image_bounds,
            image_values,
            RasterDetailPreviewWork(
                sampleGridWidth=int(patch_window.width),
                sampleGridHeight=int(patch_window.height),
                sourceBlockReadCount=len(patch_work.block_indexes),
                decodedSourceBytes=patch_work.decoded_source_bytes,
                pointsPerCell=0,
                candidateWindowCount=len(patch_work.samples),
            ),
        )
