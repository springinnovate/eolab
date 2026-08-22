"""Bounded raster sampling and distribution algorithms."""

import math
from pathlib import Path

import numpy
import rasterio
from rasterio.enums import Resampling
from rasterio.features import geometry_mask
from rasterio.warp import transform
from rasterio.windows import Window, transform as window_transform

from eolab_app.raster.models import (
    CanonicalWgs84Bounds,
    RasterHistogram,
    RasterPercentiles,
    RasterStatistics,
    RasterValueRange,
    SelectedRasterArea,
    Wgs84Bounds,
)


RASTER_STATISTICS_ALGORITHM = "bounded-selected-area-v3"
RASTER_STATISTICS_BIN_COUNT = 64
RASTER_STATISTICS_BOUNDS_DENSIFY_POINTS = 21
RASTER_STATISTICS_MAX_SAMPLE_DIMENSION = 512
# Match the ESOS-C AOI contract: a resampled cell contributes when the
# transformed selection touches it, including cells crossed only at an edge.
RASTER_STATISTICS_SELECTION_ALL_TOUCHED = True


class NoValidRasterSamplesError(ValueError):
    """Raised when a bounded sample contains no finite data values."""


class NoRasterBoundsOverlapError(ValueError):
    """Raised when a selected WGS 84 area does not overlap the raster."""


def bounded_raster_sample_shape(
    source_width: int,
    source_height: int,
    maximum_sample_dimension: int = RASTER_STATISTICS_MAX_SAMPLE_DIMENSION,
) -> tuple[int, int]:
    """Return an aspect-preserving sample size within a square bound.

    Args:
        source_width: Raster width in source pixels.
        source_height: Raster height in source pixels.
        maximum_sample_dimension: Maximum height or width of the sample.

    Returns:
        Sample height and width.
    """
    if max(source_width, source_height) <= maximum_sample_dimension:
        return source_height, source_width

    scale = maximum_sample_dimension / max(source_width, source_height)
    sample_height = max(1, math.floor(source_height * scale))
    sample_width = max(1, math.floor(source_width * scale))
    return sample_height, sample_width


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
        Strict range accepted by the WMS style contract.
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


def densified_wgs84_bounds_ring(
    selected_bounds: CanonicalWgs84Bounds,
) -> tuple[tuple[float, float], ...]:
    """Trace all four selection edges with intermediate WGS 84 vertices.

    Args:
        selected_bounds: Canonical west, south, east, and north bounds.

    Returns:
        Closed WGS 84 polygon ring with each edge evenly densified.
    """
    west, south, east, north = selected_bounds
    edge_endpoints = (
        ((west, south), (east, south)),
        ((east, south), (east, north)),
        ((east, north), (west, north)),
        ((west, north), (west, south)),
    )
    denominator = RASTER_STATISTICS_BOUNDS_DENSIFY_POINTS + 1
    ring: list[tuple[float, float]] = []
    for edge_index, (start, end) in enumerate(edge_endpoints):
        first_step = 0 if edge_index == 0 else 1
        for step in range(first_step, denominator + 1):
            fraction = step / denominator
            ring.append(
                (
                    start[0] + (end[0] - start[0]) * fraction,
                    start[1] + (end[1] - start[1]) * fraction,
                )
            )
    return tuple(ring)


def selected_raster_area_for_wgs84_bounds(
    dataset: rasterio.io.DatasetReader,
    selected_bounds: CanonicalWgs84Bounds,
) -> SelectedRasterArea:
    """Project a WGS 84 rectangle and bound it in source-pixel space.

    All four edges are densified before transformation. The transformed
    polygon is retained for masking, while its inverse-affine envelope supplies
    a bounded source window for north-up, rotated, or skewed rasters.

    Args:
        dataset: Open source raster with a coordinate reference system.
        selected_bounds: Canonical west, south, east, north WGS 84 bounds.

    Returns:
        Projected selection polygon and integer source-pixel envelope.

    Raises:
        NoRasterBoundsOverlapError: If the selection misses the raster.
        ValueError: If the bounds cannot be transformed to the raster CRS.
    """
    wgs84_ring = densified_wgs84_bounds_ring(selected_bounds)
    projected_x, projected_y = transform(
        "EPSG:4326",
        dataset.crs,
        [coordinate[0] for coordinate in wgs84_ring],
        [coordinate[1] for coordinate in wgs84_ring],
    )
    projected_ring = tuple(zip(projected_x, projected_y, strict=True))
    if not all(
        math.isfinite(coordinate)
        for point in projected_ring
        for coordinate in point
    ):
        raise ValueError("Selected bounds could not be projected")

    inverse_transform = ~dataset.transform
    pixel_ring = tuple(
        inverse_transform * projected_coordinate
        for projected_coordinate in projected_ring
    )
    column_start = max(0, math.floor(min(point[0] for point in pixel_ring)))
    row_start = max(0, math.floor(min(point[1] for point in pixel_ring)))
    column_stop = min(
        dataset.width,
        math.ceil(max(point[0] for point in pixel_ring)),
    )
    row_stop = min(
        dataset.height,
        math.ceil(max(point[1] for point in pixel_ring)),
    )
    if column_start >= column_stop or row_start >= row_stop:
        raise NoRasterBoundsOverlapError
    return SelectedRasterArea(
        source_window=Window(
            column_start,
            row_start,
            column_stop - column_start,
            row_stop - row_start,
        ),
        projected_geometry={
            "type": "Polygon",
            "coordinates": [projected_ring],
        },
    )


def read_raster_statistics(
    source_path: Path,
    selected_bounds: CanonicalWgs84Bounds | None = None,
) -> RasterStatistics:
    """Read a fixed-size raster sample and summarize band 1.

    Args:
        source_path: Authorized mounted GeoTIFF.
        selected_bounds: Optional west, south, east, north selection in WGS 84.

    Returns:
        Finite sample distribution and a suggested display range.

    Raises:
        NoRasterBoundsOverlapError: If selected geometry misses the raster.
        NoValidRasterSamplesError: If the sample has no finite data values.
        OSError: If the source cannot be read.
        rasterio.errors.RasterioError: If GDAL cannot open or sample it.
        ValueError: If selected bounds cannot be projected.
    """
    with rasterio.open(source_path) as dataset:
        selected_area = (
            selected_raster_area_for_wgs84_bounds(dataset, selected_bounds)
            if selected_bounds is not None
            else None
        )
        source_window = (
            selected_area.source_window
            if selected_area is not None
            else None
        )
        source_width = (
            int(source_window.width)
            if source_window is not None
            else dataset.width
        )
        source_height = (
            int(source_window.height)
            if source_window is not None
            else dataset.height
        )
        sample_height, sample_width = bounded_raster_sample_shape(
            source_width,
            source_height,
        )
        read_options: dict[str, object] = {
            "out_shape": (sample_height, sample_width),
            "masked": True,
            "resampling": Resampling.nearest,
        }
        if source_window is not None:
            read_options["window"] = source_window
        sample = dataset.read(1, **read_options)
        if selected_area is not None:
            source_sample_transform = window_transform(
                source_window,
                dataset.transform,
            ) * rasterio.Affine.scale(
                source_width / sample_width,
                source_height / sample_height,
            )
            outside_selection = geometry_mask(
                [selected_area.projected_geometry],
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
            west=selected_bounds[0],
            south=selected_bounds[1],
            east=selected_bounds[2],
            north=selected_bounds[3],
        )
        if selected_bounds is not None
        else None
    )
    return RasterStatistics(
        scope=("selectedArea" if selected_bounds is not None else "wholeRaster"),
        selectedBounds=selected_bounds_model,
        sourceWidth=source_width,
        sourceHeight=source_height,
        sourcePixelCount=source_pixel_count,
        sampleWidth=sample_width,
        sampleHeight=sample_height,
        sampledPixelCount=sampled_pixel_count,
        validSampleCount=int(sample_values.size),
        estimated=sampled_pixel_count < source_pixel_count,
        sampleMinimum=sample_minimum,
        sampleMaximum=sample_maximum,
        percentiles=RasterPercentiles(p05=p05, p50=p50, p95=p95),
        histogram=RasterHistogram(
            counts=[int(count) for count in counts],
            edges=[float(edge) for edge in edges],
        ),
        suggestedRange=suggested_range,
    )
