"""Adaptive bounded numeric images for overview-limited raster detail."""

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
    DETAIL_PATCH_MAX_DECODED_SOURCE_BYTES,
    DETAIL_PROXY_MAX_DECODED_SOURCE_BYTES,
    DETAIL_PROXY_MAX_DIMENSION,
    DETAIL_PROXY_MAX_POINTS_PER_CELL,
    DETAIL_PROXY_MAX_SOURCE_BLOCK_READS,
    DETAIL_PROXY_MAX_TRANSFORMED_POSITIONS,
    BoundedWindowSamples,
    detail_proxy_maximum_dimension,
    read_bounded_candidate_windows,
    read_detail_proxy,
)
from eolab_app.raster.exact_detail import (
    EXACT_DETAIL_MAX_DECODED_SOURCE_BYTES,
    EXACT_DETAIL_MAX_DIMENSION,
    EXACT_DETAIL_MAX_SOURCE_BLOCK_READS,
    plan_exact_current_view,
    read_exact_current_view,
)
from eolab_app.raster.models import (
    CanonicalWgs84Bounds,
    RasterDetailPreview,
    RasterDetailPreviewDensity,
    RasterDetailPreviewLimits,
    RasterDetailPreviewMode,
    RasterDetailPreviewRendering,
    RasterDetailPreviewScope,
    RasterDetailSourceWindow,
    RasterDetailPreviewWork,
    RasterValueRange,
)
from eolab_app.raster.read_cancellation import (
    RasterReadCancellationCheck,
    require_active_raster_read,
)
from eolab_app.raster.statistics import strict_raster_value_range


DETAIL_PREVIEW_POLICY_VERSION = "bounded-adaptive-raster-v6"
DETAIL_PREVIEW_PATCH_DIMENSION = 128
DETAIL_PREVIEW_CANDIDATE_FRACTIONS = (0.2, 0.5, 0.8)
DETAIL_PREVIEW_MAX_PATCH_CANDIDATES = (
    len(DETAIL_PREVIEW_CANDIDATE_FRACTIONS) ** 2
)
DETAIL_PREVIEW_EDGE_DENSIFY_SEGMENTS = 21
WEB_MERCATOR_LIMIT = 20_037_508.342789244
WEB_MERCATOR_LATITUDE_LIMIT = 85.0511287798066


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
        rasterio.errors.RasterioError: If CRS transformation fails.
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


def _floating_values_and_validity(
    source_values: numpy.ma.MaskedArray,
) -> tuple[numpy.ndarray, numpy.ndarray]:
    """Materialize masked source values for GDAL without integer NaN writes.

    The source data is converted to a private float64 array before invalid
    positions receive NaN. This preserves integer rasters while giving GDAL an
    unambiguous numeric nodata marker and an independent validity plane.

    Args:
        source_values: Two-dimensional masked numeric source values.

    Returns:
        Float64 values with invalid positions set to NaN, and a matching uint8
        plane containing one for valid positions and zero for invalid ones.
    """
    numeric_source = numpy.asarray(
        source_values.data,
        dtype=numpy.float64,
    ).copy()
    invalid_source = (
        numpy.ma.getmaskarray(source_values)
        | ~numpy.isfinite(numeric_source)
    )
    numeric_source[invalid_source] = numpy.nan
    valid_source = numpy.asarray(~invalid_source, dtype=numpy.uint8)
    return numeric_source, valid_source


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
    numeric_source, valid_source = _floating_values_and_validity(source_values)
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


def _warp_exact_current_view(
    source_crs: object,
    source_transform: Affine,
    source_values: numpy.ma.MaskedArray,
    projected_bounds: tuple[float, float, float, float],
) -> numpy.ma.MaskedArray:
    """Warp one already-bounded native window onto its exact map rectangle.

    The destination retains the source-window dimensions, so the close-view
    handoff never uses a lower-resolution output than the admitted native
    window. Nearest-neighbor reprojection preserves observed band-one values
    and independent validity.

    Args:
        source_crs: Valid source CRS for the admitted native window.
        source_transform: Affine transform of that exact source window.
        source_values: Complete bounded native values and nodata mask.
        projected_bounds: Ordered EPSG:3857 current-view intersection.

    Returns:
        Web-Mercator-aligned masked numeric image with the source dimensions.

    Raises:
        rasterio.errors.RasterioError: If in-memory reprojection fails.
    """
    destination_height, destination_width = source_values.shape
    destination_transform = from_bounds(
        *projected_bounds,
        destination_width,
        destination_height,
    )
    numeric_source, valid_source = _floating_values_and_validity(source_values)
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
    mask = (destination_valid != 1) | ~numpy.isfinite(destination_values)
    return numpy.ma.array(destination_values, mask=mask)


def _intersect_canonical_bounds(
    first: CanonicalWgs84Bounds,
    second: CanonicalWgs84Bounds,
) -> CanonicalWgs84Bounds:
    """Return the non-empty intersection of two canonical WGS 84 bounds.

    Args:
        first: Ordered west, south, east, north bounds.
        second: Ordered west, south, east, north bounds.

    Returns:
        Canonical intersection rectangle.

    Raises:
        ValueError: If either input is invalid or the rectangles do not
            overlap with positive area.
    """
    if any(
        not (
            len(bounds) == 4
            and all(math.isfinite(value) for value in bounds)
            and -180 <= bounds[0] < bounds[2] <= 180
            and -90 <= bounds[1] < bounds[3] <= 90
        )
        for bounds in (first, second)
    ):
        raise ValueError("Sampled raster bounds are invalid")
    intersection = (
        max(first[0], second[0]),
        max(first[1], second[1]),
        min(first[2], second[2]),
        min(first[3], second[3]),
    )
    if intersection[0] >= intersection[2] or intersection[1] >= intersection[3]:
        raise ValueError("Current map view does not intersect the raster extent")
    return intersection


def _projected_sampling_bounds(
    sampling_bounds: CanonicalWgs84Bounds,
) -> tuple[
    tuple[float, float, float, float],
    CanonicalWgs84Bounds,
]:
    """Convert canonical bounds into one displayable Mercator target grid.

    Args:
        sampling_bounds: Ordered WGS 84 raster/view intersection.

    Returns:
        EPSG:3857 target bounds and their canonical display bounds. Polar
        latitude is clipped only to Leaflet's finite Web Mercator world.

    Raises:
        ValueError: If the bounds are outside the displayable Mercator world
            or transformation is invalid.
        rasterio.errors.RasterioError: If CRS transformation fails.
    """
    west, south, east, north = sampling_bounds
    display_bounds = (
        west,
        max(south, -WEB_MERCATOR_LATITUDE_LIMIT),
        east,
        min(north, WEB_MERCATOR_LATITUDE_LIMIT),
    )
    if display_bounds[1] >= display_bounds[3]:
        raise ValueError("Sampled raster bounds are outside the displayable world")
    projected_x, projected_y = warp_transform(
        "EPSG:4326",
        "EPSG:3857",
        [display_bounds[0], display_bounds[2]],
        [display_bounds[1], display_bounds[3]],
    )
    projected_bounds = (
        float(projected_x[0]),
        float(projected_y[0]),
        float(projected_x[1]),
        float(projected_y[1]),
    )
    if not (
        all(math.isfinite(value) for value in projected_bounds)
        and projected_bounds[0] < projected_bounds[2]
        and projected_bounds[1] < projected_bounds[3]
    ):
        raise ValueError("Sampled raster projected bounds are invalid")
    return projected_bounds, display_bounds


def _suggested_range(
    values: numpy.ma.MaskedArray,
) -> RasterValueRange | None:
    """Derive a strict minimum/median/maximum bounded-preview range.

    Args:
        values: Bounded masked numeric image.

    Returns:
        Strict approximate minimum/median/maximum range, or ``None`` when the
        bounded sample contains no finite values.
    """
    finite_values = numpy.asarray(values.compressed(), dtype=numpy.float64)
    finite_values = finite_values[numpy.isfinite(finite_values)]
    if finite_values.size == 0:
        return None
    sample_minimum = float(numpy.min(finite_values))
    sample_maximum = float(numpy.max(finite_values))
    sample_median = float(numpy.median(finite_values))
    return strict_raster_value_range(
        sample_minimum,
        sample_maximum,
        sample_minimum,
        sample_median,
        sample_maximum,
    )


def _flatten_values(values: numpy.ma.MaskedArray) -> list[float | None]:
    """Flatten one masked image to browser-safe row-major values.

    Args:
        values: Bounded masked numeric image.

    Returns:
        Finite floats and ``None`` for nodata/non-finite cells.
    """
    numeric_values, validity = _floating_values_and_validity(values)
    return [
        None if not valid else float(value)
        for value, valid in zip(
            numeric_values.ravel(),
            validity.ravel(),
            strict=True,
        )
    ]


def _representative_patch(
    dataset: rasterio.io.DatasetReader,
    cancellation_requested: RasterReadCancellationCheck | None = None,
) -> tuple[Window, numpy.ma.MaskedArray, BoundedWindowSamples]:
    """Select one patch using deterministic bounded candidate windows.

    Candidates are visited in top-left row-major order. Ranking uses valid
    coverage first, population standard deviation second, then the earliest
    candidate as the stable tie-breaker. Each candidate is read once and is at
    most 128 by 128 source pixels.

    Args:
        dataset: Open band-one raster.
        cancellation_requested: Optional thread-safe obsolescence predicate.

    Returns:
        Selected source window, its already-read masked values, and the shared
        native-block work used for all admitted candidates.

    Raises:
        NoUsefulDetailPatchError: If every candidate is nodata/non-finite.
        RasterReadCancelled: If every request waiter disconnects.
        rasterio.errors.RasterioError: If a bounded read fails.
    """
    bounded_samples = read_bounded_candidate_windows(
        dataset,
        _candidate_windows(dataset.width, dataset.height),
        cancellation_requested,
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


def _limits(
    mode: RasterDetailPreviewMode,
    rendering: RasterDetailPreviewRendering,
) -> RasterDetailPreviewLimits:
    """Return the fixed public work limits for one policy-v6 representation.

    Sampled grids stream as many structurally bounded blocks as their exact
    selected resolution requires, up to the fixed block-count ceiling. Detail
    patches retain the smaller cumulative decoded-work ceiling because they
    reconstruct full 128-by-128 candidate windows.

    Args:
        mode: Validated user-selected preview mode.
        rendering: Sampled, exact-window, or representative-patch result.

    Returns:
        Immutable response model containing every server-owned ceiling.
    """
    return RasterDetailPreviewLimits(
        maximumProxyDimension=DETAIL_PROXY_MAX_DIMENSION,
        maximumExactDetailDimension=EXACT_DETAIL_MAX_DIMENSION,
        maximumSourceBlockReads=(
            EXACT_DETAIL_MAX_SOURCE_BLOCK_READS
            if rendering == "exactSourceWindow"
            else DETAIL_PROXY_MAX_SOURCE_BLOCK_READS
        ),
        maximumDecodedSourceBytes=(
            EXACT_DETAIL_MAX_DECODED_SOURCE_BYTES
            if rendering == "exactSourceWindow"
            else (
                DETAIL_PATCH_MAX_DECODED_SOURCE_BYTES
                if mode == "representativePatch"
                else DETAIL_PROXY_MAX_DECODED_SOURCE_BYTES
            )
        ),
        maximumTransformedPositions=DETAIL_PROXY_MAX_TRANSFORMED_POSITIONS,
        maximumPointsPerCell=DETAIL_PROXY_MAX_POINTS_PER_CELL,
        maximumPatchDimension=DETAIL_PREVIEW_PATCH_DIMENSION,
        maximumPatchCandidates=DETAIL_PREVIEW_MAX_PATCH_CANDIDATES,
    )


def _preview_response(
    mode: RasterDetailPreviewMode,
    scope: RasterDetailPreviewScope,
    rendering: RasterDetailPreviewRendering,
    density: RasterDetailPreviewDensity | None,
    label: str,
    raster_extent: tuple[float, float, float, float],
    image_bounds: tuple[float, float, float, float],
    values: numpy.ma.MaskedArray,
    actual_work: RasterDetailPreviewWork,
) -> RasterDetailPreview:
    """Build one validated common numeric-image response.

    Args:
        mode: Explicit user-selected preview policy.
        scope: Raster extent, current map view, or patch provenance.
        rendering: Sampled, exact-window, or representative-patch result.
        density: Fixed sampled-grid profile, or ``None`` for a patch.
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
        scope=scope,
        rendering=rendering,
        density=density,
        policyVersion=DETAIL_PREVIEW_POLICY_VERSION,
        label=label,
        rasterExtent=raster_extent,
        imageBounds=image_bounds,
        imageWidth=image_width,
        imageHeight=image_height,
        pixelValues=_flatten_values(values),
        suggestedRange=_suggested_range(values),
        limits=_limits(mode, rendering),
        actual=actual_work,
    )


def read_raster_detail_preview(
    source_path: Path,
    mode: RasterDetailPreviewMode,
    raster_extent: CanonicalWgs84Bounds,
    density: RasterDetailPreviewDensity | None,
    view_bounds: CanonicalWgs84Bounds | None = None,
    cancellation_requested: RasterReadCancellationCheck | None = None,
) -> RasterDetailPreview:
    """Read one bounded numeric preview from an overview-limited raster.

    Sampled modes place the selected cell count on the projected rectangle's
    longest edge and preserve its aspect ratio on the shorter edge.
    A current-view request first attempts an exact native window and admits it
    only when its dimensions, native blocks, and decoded bytes satisfy smaller
    fixed limits; broader views retain the selected sampling policy.
    Sampled probes are rejected before pixel I/O if their exact grid exceeds
    its native-block work ceiling and are never silently coarsened. Every
    admitted native block is read once without ``out_shape``. The
    representative patch keeps a fixed
    at-most-nine-candidate, 128-by-128-window policy; candidates that exceed its
    smaller block/byte ceilings are skipped. Only already-bounded NumPy patch
    arrays are reprojected for Leaflet; sampled grids are already aligned to the
    Web Mercator target rectangle.

    Args:
        source_path: Authorized mounted GeoTIFF.
        mode: Explicit preview mode selected by the user.
        raster_extent: Authoritative cataloged WGS 84 raster extent.
        density: Coarse, medium, or fine server-owned exact longest-edge
            resolution for sampled modes; ``None`` for the representative
            patch.
        view_bounds: Optional canonical current map rectangle to refine.
        cancellation_requested: Optional thread-safe obsolescence predicate.

    Returns:
        Browser-safe georeferenced numeric preview with public resource limits.

    Raises:
        NoUsefulDetailPatchError: If bounded patch candidates contain no data.
        RasterReadCancelled: If every request waiter disconnects.
        OSError: If the source cannot be read.
        rasterio.errors.RasterioError: If GDAL cannot open/read/reproject it.
        ValueError: If the dataset contract or georeferencing is invalid.
    """
    if mode not in {
        "centerSample",
        "representativeSample",
        "representativePatch",
    }:
        raise ValueError(f"Unsupported detail preview mode: {mode}")
    if mode == "representativePatch":
        if density is not None or view_bounds is not None:
            raise ValueError(
                "Representative patches do not accept density or view bounds"
            )
    elif density is None:
        raise ValueError("Sampled raster proxies require a density")
    effective_bounds = _intersect_canonical_bounds(
        raster_extent,
        view_bounds or raster_extent,
    )
    require_active_raster_read(cancellation_requested)
    with rasterio.open(source_path) as dataset:
        require_active_raster_read(cancellation_requested)
        _require_signed_geotiff_dependencies(dataset, source_path)
        if dataset.count != 1 or dataset.width < 1 or dataset.height < 1:
            raise ValueError("Detail-only preview requires one non-empty band")
        if dataset.crs is None:
            raise ValueError("Detail-only preview requires a valid raster CRS")
        if mode in {"centerSample", "representativeSample"}:
            projected_bounds, image_bounds = _projected_sampling_bounds(
                effective_bounds
            )
            exact_plan = (
                plan_exact_current_view(dataset, projected_bounds)
                if view_bounds is not None
                else None
            )
            if exact_plan is not None:
                exact_values = read_exact_current_view(
                    dataset,
                    exact_plan,
                    cancellation_requested,
                )
                image_values = _warp_exact_current_view(
                    dataset.crs,
                    window_transform(exact_plan.source_window, dataset.transform),
                    exact_values,
                    projected_bounds,
                )
                source_window = exact_plan.source_window
                return _preview_response(
                    mode,
                    "currentView",
                    "exactSourceWindow",
                    density,
                    "Exact bounded current-view source detail; not a whole-raster "
                    "rendering",
                    raster_extent,
                    image_bounds,
                    image_values,
                    RasterDetailPreviewWork(
                        sampleGridWidth=image_values.shape[1],
                        sampleGridHeight=image_values.shape[0],
                        sourceBlockReadCount=len(exact_plan.block_indexes),
                        decodedSourceBytes=exact_plan.decoded_source_bytes,
                        pointsPerCell=0,
                        candidateWindowCount=0,
                        sourceWindow=RasterDetailSourceWindow(
                            columnOffset=int(source_window.col_off),
                            rowOffset=int(source_window.row_off),
                            width=int(source_window.width),
                            height=int(source_window.height),
                        ),
                    ),
                )
            proxy_values, plan = read_detail_proxy(
                dataset,
                mode,
                detail_proxy_maximum_dimension(density),
                projected_bounds,
                cancellation_requested,
            )
            scope: RasterDetailPreviewScope = (
                "currentView" if view_bounds is not None else "rasterExtent"
            )
            sample_description = (
                "each map cell's center"
                if mode == "centerSample"
                else "representative positions in each map cell"
            )
            scope_description = (
                "current-view detail"
                if scope == "currentView"
                else "raster-extent"
            )
            return _preview_response(
                mode,
                scope,
                "sampledProxy",
                density,
                "Approximate "
                f"{scope_description} sampled proxy using {sample_description}",
                raster_extent,
                image_bounds,
                proxy_values,
                RasterDetailPreviewWork(
                    sampleGridWidth=plan.width,
                    sampleGridHeight=plan.height,
                    sourceBlockReadCount=len(plan.block_indexes),
                    decodedSourceBytes=plan.decoded_source_bytes,
                    pointsPerCell=plan.points_per_cell,
                    candidateWindowCount=0,
                ),
            )

        patch_window, patch_values, patch_work = _representative_patch(
            dataset,
            cancellation_requested,
        )
        image_bounds, image_values = _warp_numeric_image(
            dataset.crs,
            window_transform(patch_window, dataset.transform),
            patch_values,
            DETAIL_PREVIEW_PATCH_DIMENSION,
        )
        return _preview_response(
            mode,
            "representativePatch",
            "representativePatch",
            None,
            "Approximate representative detail patch",
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
                sourceWindow=RasterDetailSourceWindow(
                    columnOffset=int(patch_window.col_off),
                    rowOffset=int(patch_window.row_off),
                    width=int(patch_window.width),
                    height=int(patch_window.height),
                ),
            ),
        )
