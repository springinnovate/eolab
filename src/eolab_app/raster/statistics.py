"""Bounded raster sampling and distribution algorithms."""

import math
from pathlib import Path

import numpy
import rasterio
from rasterio.features import geometry_mask
from rasterio.warp import transform
from rasterio.windows import Window, transform as window_transform

from eolab_app.raster.bounded_window import (
    BOUNDED_SOURCE_WINDOW_PADDING_PIXELS as RASTER_STATISTICS_SOURCE_WINDOW_PADDING_PIXELS,
    BOUNDED_WGS84_DENSIFY_POINTS as RASTER_STATISTICS_BOUNDS_DENSIFY_POINTS,
    NoRasterBoundsOverlapError,
    densified_wgs84_bounds_ring,
    selected_raster_area_for_wgs84_bounds as _selected_raster_area_for_wgs84_bounds,
)
from eolab_app.raster.exact_source import (
    EXACT_SOURCE_MAX_BLOCK_READS,
    EXACT_SOURCE_MAX_DECODED_BYTES,
    EXACT_SOURCE_MAX_DIMENSION,
    plan_exact_source_window,
    read_exact_source_window,
)
from eolab_app.raster.models import (
    CanonicalWgs84Bounds,
    RasterHistogram,
    RasterPercentiles,
    RasterStatistics,
    RasterValueRange,
    SelectedRasterArea,
    Wgs84Bounds,
)
from eolab_app.raster.read_cancellation import (
    RasterReadCancellationCheck,
    require_active_raster_read,
)
from eolab_app.raster.sample_grid import (
    read_source_window_sample_grid,
    sample_grid_policy_parameters,
)
from eolab_app.raster.source_contract import (
    BOUNDED_RASTER_MAX_NATIVE_BLOCK_DECODED_BYTES,
    require_raster_analysis_georeferencing,
    require_signed_raster_dependencies,
)
from eolab_app.sampling_area import (
    RasterSamplingArea,
    SelectedBoundsSamplingArea,
    TemporaryAoiSamplingArea,
    WholeRasterSamplingArea,
)


RASTER_STATISTICS_ALGORITHM = "rendering-independent-bounded-area-v6"
RASTER_STATISTICS_BIN_COUNT = 64
RASTER_STATISTICS_MAX_TRANSFORMED_COORDINATES = 500_000
# Match the ESOS-C AOI contract: a resampled cell contributes when the
# transformed selection touches it, including cells crossed only at an edge.
RASTER_STATISTICS_SELECTION_ALL_TOUCHED = True


def raster_statistics_policy_parameters() -> tuple[int, ...]:
    """Return every fixed planning input used by cache identity.

    Returns:
        Native-block, sampling-grid, exact-window, geometry, and point-location
        parameters.
    """
    return (
        RASTER_STATISTICS_BIN_COUNT,
        RASTER_STATISTICS_BOUNDS_DENSIFY_POINTS,
        RASTER_STATISTICS_MAX_TRANSFORMED_COORDINATES,
        RASTER_STATISTICS_SOURCE_WINDOW_PADDING_PIXELS,
        int(RASTER_STATISTICS_SELECTION_ALL_TOUCHED),
        BOUNDED_RASTER_MAX_NATIVE_BLOCK_DECODED_BYTES,
        *sample_grid_policy_parameters(),
        EXACT_SOURCE_MAX_DIMENSION,
        EXACT_SOURCE_MAX_BLOCK_READS,
        EXACT_SOURCE_MAX_DECODED_BYTES,
    )


class NoValidRasterSamplesError(ValueError):
    """Raised when a bounded sample contains no finite data values."""


def selected_raster_area_for_wgs84_bounds(
    dataset: rasterio.io.DatasetReader,
    selected_bounds: CanonicalWgs84Bounds,
) -> SelectedRasterArea:
    """Preserve the statistics module's public bounded-window contract.

    Args:
        dataset: Open source raster with a coordinate reference system.
        selected_bounds: Canonical west, south, east, north WGS 84 bounds.

    Returns:
        Projected selection polygon and clipped source-pixel envelope.

    Raises:
        NoRasterBoundsOverlapError: If the selection misses the raster.
        ValueError: If the bounds cannot be transformed to the raster CRS.
    """
    return _selected_raster_area_for_wgs84_bounds(
        dataset,
        selected_bounds,
        coordinate_transform=transform,
    )


def strict_raster_value_range(
    sample_minimum: float,
    sample_maximum: float,
    p05: float,
    p50: float,
    p95: float,
) -> RasterValueRange:
    """Derive a finite, strictly ordered style range from sample values.

    Args:
        sample_minimum: Lowest sampled value.
        sample_maximum: Highest sampled value.
        p05: Fifth sample percentile.
        p50: Median sample value.
        p95: Ninety-fifth sample percentile.

    Returns:
        Strict range safe for downstream color and style controls.
    """
    if p05 < p50 < p95:
        return RasterValueRange(minimum=p05, midpoint=p50, maximum=p95)

    percentile_padding = max(
        max(abs(value) for value in (p05, p50, p95)) * 1e-6,
        1e-12,
    )
    padded_minimum = p05 - percentile_padding if p05 == p50 else p05
    padded_maximum = p95 + percentile_padding if p50 == p95 else p95
    if (
        all(
            math.isfinite(value)
            for value in (padded_minimum, p50, padded_maximum)
        )
        and padded_minimum < p50 < padded_maximum
    ):
        return RasterValueRange(
            minimum=padded_minimum,
            midpoint=p50,
            maximum=padded_maximum,
        )

    if sample_minimum < sample_maximum:
        midpoint = sample_minimum / 2 + sample_maximum / 2
        if sample_minimum < midpoint < sample_maximum:
            return RasterValueRange(
                minimum=sample_minimum,
                midpoint=midpoint,
                maximum=sample_maximum,
            )

        lower_value = math.nextafter(sample_minimum, -math.inf)
        if math.isfinite(lower_value):
            return RasterValueRange(
                minimum=lower_value,
                midpoint=sample_minimum,
                maximum=sample_maximum,
            )
        upper_value = math.nextafter(sample_maximum, math.inf)
        return RasterValueRange(
            minimum=sample_minimum,
            midpoint=sample_maximum,
            maximum=upper_value,
        )

    constant_value = sample_minimum
    scale_relative_padding = max(abs(constant_value) * 1e-6, 1e-12)
    lower_value = constant_value - scale_relative_padding
    upper_value = constant_value + scale_relative_padding
    if (
        all(
            math.isfinite(value)
            for value in (lower_value, constant_value, upper_value)
        )
        and lower_value < constant_value < upper_value
    ):
        return RasterValueRange(
            minimum=lower_value,
            midpoint=constant_value,
            maximum=upper_value,
        )

    lower_value = math.nextafter(constant_value, -math.inf)
    upper_value = math.nextafter(constant_value, math.inf)
    if math.isfinite(lower_value) and math.isfinite(upper_value):
        return RasterValueRange(
            minimum=lower_value,
            midpoint=constant_value,
            maximum=upper_value,
        )
    if math.isfinite(lower_value):
        return RasterValueRange(
            minimum=math.nextafter(lower_value, -math.inf),
            midpoint=lower_value,
            maximum=constant_value,
        )
    return RasterValueRange(
        minimum=constant_value,
        midpoint=upper_value,
        maximum=math.nextafter(upper_value, math.inf),
    )


def _polygon_rings(
    geometry: dict[str, object],
) -> tuple[tuple[tuple[float, float], ...], ...]:
    """Return every ring from one validated polygonal GeoJSON geometry.

    Args:
        geometry: Fresh Polygon or MultiPolygon GeoJSON mapping.

    Returns:
        Exterior and interior rings in deterministic geometry order.

    Raises:
        TypeError: If the lifecycle-owned geometry contract is malformed.
    """
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, (list, tuple)):
        raise TypeError("Temporary AOI polygon coordinates are malformed")
    polygons = [coordinates] if geometry.get("type") == "Polygon" else coordinates
    rings: list[tuple[tuple[float, float], ...]] = []
    for polygon in polygons:
        if not isinstance(polygon, (list, tuple)):
            raise TypeError("Temporary AOI polygon is malformed")
        for ring in polygon:
            if not isinstance(ring, (list, tuple)):
                raise TypeError("Temporary AOI polygon ring is malformed")
            positions: list[tuple[float, float]] = []
            for position in ring:
                if not isinstance(position, (list, tuple)) or len(position) < 2:
                    raise TypeError("Temporary AOI polygon position is malformed")
                positions.append((float(position[0]), float(position[1])))
            if len(positions) < 4:
                raise TypeError("Temporary AOI polygon ring is too short")
            rings.append(tuple(positions))
    return tuple(rings)


def _densify_polygon_rings(
    rings: tuple[tuple[tuple[float, float], ...], ...],
) -> tuple[tuple[tuple[float, float], ...], ...]:
    """Densify AOI edges without exceeding transformed-coordinate capacity.

    Args:
        rings: Validated closed WGS 84 polygon rings.

    Returns:
        Rings with a bounded number of evenly spaced edge positions.

    Raises:
        ValueError: If source rings already exceed transformation capacity.
    """
    segment_count = sum(max(0, len(ring) - 1) for ring in rings)
    if segment_count < 1:
        raise ValueError("Temporary AOI has no polygon edges")
    if segment_count + len(rings) > RASTER_STATISTICS_MAX_TRANSFORMED_COORDINATES:
        raise ValueError("Temporary AOI exceeds the transformed-geometry limit")
    densify_points = min(
        RASTER_STATISTICS_BOUNDS_DENSIFY_POINTS,
        max(
            0,
            (RASTER_STATISTICS_MAX_TRANSFORMED_COORDINATES - len(rings))
            // segment_count
            - 1,
        ),
    )
    denominator = densify_points + 1
    densified: list[tuple[tuple[float, float], ...]] = []
    for ring in rings:
        result = [ring[0]]
        for start, end in zip(ring, ring[1:]):
            for step in range(1, denominator + 1):
                fraction = step / denominator
                result.append((
                    start[0] + (end[0] - start[0]) * fraction,
                    start[1] + (end[1] - start[1]) * fraction,
                ))
        densified.append(tuple(result))
    return tuple(densified)


def _source_window_for_projected_geometries(
    dataset: rasterio.io.DatasetReader,
    projected_geometries: tuple[dict[str, object], ...],
) -> Window:
    """Clip a projected polygon envelope to one raster's pixel grid.

    Args:
        dataset: Open source raster with an invertible affine transform.
        projected_geometries: Polygonal geometries in the source raster CRS.

    Returns:
        Integer source-pixel window containing every projected polygon.

    Raises:
        NoRasterBoundsOverlapError: If the envelope misses the raster grid.
        TypeError: If a projected polygon mapping is malformed.
    """
    projected_positions = [
        position
        for geometry in projected_geometries
        for ring in _polygon_rings(geometry)
        for position in ring
    ]
    inverse_transform = ~dataset.transform
    pixel_positions = tuple(
        inverse_transform * position for position in projected_positions
    )
    padding = RASTER_STATISTICS_SOURCE_WINDOW_PADDING_PIXELS
    column_start = max(
        0,
        math.floor(min(point[0] for point in pixel_positions)) - padding,
    )
    row_start = max(
        0,
        math.floor(min(point[1] for point in pixel_positions)) - padding,
    )
    column_stop = min(
        dataset.width,
        math.ceil(max(point[0] for point in pixel_positions)) + padding,
    )
    row_stop = min(
        dataset.height,
        math.ceil(max(point[1] for point in pixel_positions)) + padding,
    )
    if column_start >= column_stop or row_start >= row_stop:
        raise NoRasterBoundsOverlapError
    return Window(
        column_start,
        row_start,
        column_stop - column_start,
        row_stop - row_start,
    )


def selected_raster_area_for_temporary_aoi(
    dataset: rasterio.io.DatasetReader,
    sampling_area: TemporaryAoiSamplingArea,
) -> SelectedRasterArea:
    """Project and bound an immutable temporary AOI for one raster grid.

    Every polygon edge is densified under a fixed transformed-coordinate
    ceiling before explicit longitude/latitude transformation. The resulting
    Polygon and MultiPolygon mappings remain separate; ``geometry_mask`` unions
    them so overlaps can never count a grid cell twice.

    Args:
        dataset: Open source raster with a coordinate reference system.
        sampling_area: Resolved ready temporary AOI.

    Returns:
        Projected polygonal geometry and clipped source-pixel envelope.

    Raises:
        NoRasterBoundsOverlapError: If the AOI envelope misses the raster.
        ValueError: If transformation produces a non-finite position or exceeds
            the explicit transformed-geometry ceiling.
        TypeError: If immutable geometry violates its owned contract.
    """
    geometry_ring_groups: list[
        tuple[str, tuple[tuple[tuple[float, float], ...], ...]]
    ] = []
    all_rings: list[tuple[tuple[float, float], ...]] = []
    for immutable_geometry in sampling_area.resolved_aoi.geometries:
        geometry = immutable_geometry.as_geojson()
        rings = _polygon_rings(geometry)
        geometry_ring_groups.append((immutable_geometry.geometry_type, rings))
        all_rings.extend(rings)
    densified_rings = _densify_polygon_rings(tuple(all_rings))
    longitudes = [point[0] for ring in densified_rings for point in ring]
    latitudes = [point[1] for ring in densified_rings for point in ring]
    projected_x, projected_y = transform(
        "EPSG:4326",
        dataset.crs,
        longitudes,
        latitudes,
    )
    projected_positions = tuple(zip(projected_x, projected_y, strict=True))
    if not all(
        math.isfinite(ordinate)
        for position in projected_positions
        for ordinate in position
    ):
        raise ValueError("Temporary AOI could not be projected")

    projected_rings: list[tuple[tuple[float, float], ...]] = []
    position_index = 0
    for ring in densified_rings:
        projected_rings.append(
            projected_positions[position_index:position_index + len(ring)]
        )
        position_index += len(ring)

    projected_geometries: list[dict[str, object]] = []
    ring_index = 0
    for geometry_type, source_rings in geometry_ring_groups:
        ring_counts = []
        if geometry_type == "Polygon":
            ring_counts = [len(source_rings)]
        else:
            source_geometry = sampling_area.resolved_aoi.geometries[
                len(projected_geometries)
            ].as_geojson()
            coordinates = source_geometry["coordinates"]
            if not isinstance(coordinates, list):
                raise TypeError("Temporary AOI MultiPolygon is malformed")
            ring_counts = [len(polygon) for polygon in coordinates]
        polygons = []
        for ring_count in ring_counts:
            polygon_rings = projected_rings[ring_index:ring_index + ring_count]
            ring_index += ring_count
            polygons.append(polygon_rings)
        projected_geometries.append({
            "type": geometry_type,
            "coordinates": polygons[0] if geometry_type == "Polygon" else polygons,
        })

    projected_tuple = tuple(projected_geometries)
    return SelectedRasterArea(
        source_window=_source_window_for_projected_geometries(
            dataset,
            projected_tuple,
        ),
        projected_geometries=projected_tuple,
    )


def read_raster_statistics(
    source_path: Path,
    sampling_area: RasterSamplingArea,
    cancellation_requested: RasterReadCancellationCheck | None = None,
) -> RasterStatistics:
    """Read band-1 statistics through one bounded source-work planner.

    Every scope first resolves a finite integral source envelope. Envelopes
    satisfying the exact dimension, block, and decoded-byte ceilings are read
    completely one native block at a time. Broader envelopes use the fixed
    127-longest-edge center grid, whose unique blocks and cumulative decoded
    work are proven before I/O. No path uses a broad ``out_shape`` read or
    relies on raster overviews, WMS publication, or rendering state.

    Args:
        source_path: Authorized mounted GeoTIFF.
        sampling_area: Explicit whole, selected-bounds, or resolved AOI value.
        cancellation_requested: Optional thread-safe obsolescence predicate.

    Returns:
        Finite sample distribution and a suggested display range.

    Raises:
        NoRasterBoundsOverlapError: If selected geometry misses the raster.
        NoValidRasterSamplesError: If the sample has no finite data values.
        OSError: If the source cannot be read.
        rasterio.errors.RasterioError: If GDAL cannot open or sample it.
        RasterReadCancelled: If every coalesced request waiter disconnects.
        TypeError: If the sampling area is outside the strict area union.
        ValueError: If source structure, CRS, transformation, or bounded-read
            admission is invalid.
    """
    require_active_raster_read(cancellation_requested)
    with rasterio.open(source_path) as dataset:
        require_active_raster_read(cancellation_requested)
        require_signed_raster_dependencies(dataset, source_path)
        require_raster_analysis_georeferencing(dataset)
        if isinstance(sampling_area, SelectedBoundsSamplingArea):
            selected_area = selected_raster_area_for_wgs84_bounds(
                dataset,
                sampling_area.bounds,
            )
        elif isinstance(sampling_area, TemporaryAoiSamplingArea):
            selected_area = selected_raster_area_for_temporary_aoi(
                dataset,
                sampling_area,
            )
        elif isinstance(sampling_area, WholeRasterSamplingArea):
            selected_area = None
        else:
            raise TypeError("Unsupported raster sampling area")
        source_window = selected_area.source_window if selected_area else Window(
            0,
            0,
            dataset.width,
            dataset.height,
        )
        source_width = int(source_window.width)
        source_height = int(source_window.height)
        exact_plan = plan_exact_source_window(dataset, source_window)
        if exact_plan is None:
            sample, _ = read_source_window_sample_grid(
                dataset,
                source_window,
                cancellation_requested,
            )
            sampling_method = "sampleGrid"
        else:
            sample = read_exact_source_window(
                dataset,
                exact_plan,
                cancellation_requested,
            )
            sampling_method = "exactSourceWindow"
        sample_height, sample_width = sample.shape
        if selected_area is not None:
            source_sample_transform = window_transform(
                source_window,
                dataset.transform,
            ) * rasterio.Affine.scale(
                source_width / sample_width,
                source_height / sample_height,
            )
            outside_selection = geometry_mask(
                list(selected_area.projected_geometries),
                out_shape=(sample_height, sample_width),
                transform=source_sample_transform,
                all_touched=RASTER_STATISTICS_SELECTION_ALL_TOUCHED,
            )
            if numpy.all(outside_selection):
                raise NoRasterBoundsOverlapError
            sample = numpy.ma.array(
                numpy.ma.getdata(sample),
                mask=numpy.logical_or(
                    numpy.ma.getmaskarray(sample),
                    outside_selection,
                ),
            )
        require_active_raster_read(cancellation_requested)

    sample_values = numpy.asarray(sample.compressed(), dtype=numpy.float64)
    sample_values = sample_values[numpy.isfinite(sample_values)]
    if sample_values.size == 0:
        raise NoValidRasterSamplesError

    sample_minimum = float(numpy.min(sample_values))
    sample_maximum = float(numpy.max(sample_values))
    p05, p50, p95 = (
        float(value)
        for value in numpy.percentile(sample_values, (5, 50, 95))
    )
    suggested_range = strict_raster_value_range(
        sample_minimum,
        sample_maximum,
        p05,
        p50,
        p95,
    )
    histogram_minimum = (
        sample_minimum
        if sample_minimum < sample_maximum
        else suggested_range.minimum
    )
    histogram_maximum = (
        sample_maximum
        if sample_minimum < sample_maximum
        else suggested_range.maximum
    )
    counts, edges = numpy.histogram(
        sample_values,
        bins=RASTER_STATISTICS_BIN_COUNT,
        range=(histogram_minimum, histogram_maximum),
    )
    source_pixel_count = source_width * source_height
    sampled_pixel_count = sample_width * sample_height
    selected_bounds_model = (
        Wgs84Bounds(
            west=sampling_area.bounds[0],
            south=sampling_area.bounds[1],
            east=sampling_area.bounds[2],
            north=sampling_area.bounds[3],
        )
        if isinstance(sampling_area, SelectedBoundsSamplingArea)
        else None
    )
    temporary_aoi_id = (
        sampling_area.resolved_aoi.identity.reference
        if isinstance(sampling_area, TemporaryAoiSamplingArea)
        else None
    )
    return RasterStatistics(
        scope=sampling_area.kind,
        selectedBounds=selected_bounds_model,
        temporaryAoiId=temporary_aoi_id,
        sourceWidth=source_width,
        sourceHeight=source_height,
        sourcePixelCount=source_pixel_count,
        sampleWidth=sample_width,
        sampleHeight=sample_height,
        sampledPixelCount=sampled_pixel_count,
        validSampleCount=int(sample_values.size),
        samplingMethod=sampling_method,
        estimated=sampling_method == "sampleGrid",
        sampleMinimum=sample_minimum,
        sampleMaximum=sample_maximum,
        percentiles=RasterPercentiles(p05=p05, p50=p50, p95=p95),
        histogram=RasterHistogram(
            counts=[int(count) for count in counts],
            edges=[float(edge) for edge in edges],
        ),
        suggestedRange=suggested_range,
    )
