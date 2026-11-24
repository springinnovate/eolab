"""Bounded raster sampling and distribution algorithms."""

from eolab_app.bounded_vector import PolygonRasterizer, pixels_inside_area
import math
from typing import Literal

import numpy
from numpy.typing import NDArray
from pydantic import PrivateAttr
import rasterio
from rasterio.enums import Resampling
from rasterio.warp import transform
from rasterio.windows import Window, transform as window_transform

from eolab_app.raster.bounded_window import (
    selected_raster_area_for_wgs84_polygons,
    selected_raster_area_for_sampling_box,
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
    BoxStatistic,
    PercentAbove,
    RasterBoxPreview,
    RasterPreviewValue,
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
    overview_sample_grid_policy_parameters,
    read_bounded_overview,
    read_source_window_sample_grid,
    sample_grid_policy_parameters,
)
from eolab_app.raster.reader import RasterData, RasterDataset, open_raster_data
from eolab_app.raster.source_contract import (
    BOUNDED_RASTER_MAX_NATIVE_BLOCK_DECODED_BYTES,
    require_raster_analysis_georeferencing,
    require_signed_raster_dependencies,
)
from eolab_app.sampling_area import (
    RasterSamplingArea,
    SelectedBoundsSamplingArea,
    SamplingBoxArea,
    CatalogSelectionSamplingArea,
    PolygonInputSamplingArea,
    WholeRasterSamplingArea,
)

RASTER_STATISTICS_ALGORITHM = "rendering-independent-bounded-area-v9"
RASTER_STATISTICS_BIN_COUNT = 64
RASTER_STATISTICS_MAX_TRANSFORMED_COORDINATES = 500_000
# Match the ESOS-C catalog selection contract: a resampled cell contributes when the
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
        *overview_sample_grid_policy_parameters(),
        EXACT_SOURCE_MAX_DIMENSION,
        EXACT_SOURCE_MAX_BLOCK_READS,
        EXACT_SOURCE_MAX_DECODED_BYTES,
    )


class NoValidRasterSamplesError(ValueError):
    """Raised when a bounded sample contains no finite data values."""


def selected_raster_area_for_wgs84_bounds(
    dataset: RasterDataset,
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
        maximum_output_coordinates=RASTER_STATISTICS_MAX_TRANSFORMED_COORDINATES,
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


def build_raster_histogram_edges(
    minimum: float,
    maximum: float,
    bin_count: int,
) -> NDArray[numpy.float64]:
    """Build distinct finite histogram edges containing the sampled range.

    Preserve the sample domain when it can represent every edge. Otherwise,
    expand it using the same relative padding as constant-value distributions,
    keeping expansion inside the finite float64 limits. Callers retain the
    original sample extrema separately from this histogram domain.

    Args:
        minimum: Finite sample minimum.
        maximum: Finite sample maximum no lower than ``minimum``.
        bin_count: Fixed histogram size of 32 or 64 used by the statistics owner.

    Returns:
        ``bin_count + 1`` finite, strictly increasing float64 edges containing
        both sample extrema, for use as explicit NumPy histogram bins.
    """
    if math.isfinite(maximum - minimum):
        edges = numpy.linspace(minimum, maximum, bin_count + 1)
    else:
        # Halving before interpolation avoids overflowing the endpoint span.
        edges = numpy.linspace(minimum / 2, maximum / 2, bin_count + 1) * 2
        edges[0], edges[-1] = minimum, maximum
    if numpy.all(edges[1:] > edges[:-1]):
        return edges

    padding = max(abs(minimum) * 1e-6, abs(maximum) * 1e-6, 1e-12)
    finite_limit = float(numpy.finfo(numpy.float64).max)
    lower = max(-finite_limit, minimum - padding)
    upper = min(finite_limit, maximum + padding)
    return numpy.linspace(lower, upper, bin_count + 1)


def selected_raster_area_for_catalog_selection(
    dataset: RasterDataset,
    sampling_area: CatalogSelectionSamplingArea,
    cancellation_requested: RasterReadCancellationCheck | None = None,
) -> SelectedRasterArea:
    """Read a catalog selection using the statistics owner's transformation budget.

    Args:
        dataset: Open, georeferenced source raster.
        sampling_area: Immutable catalog descriptor and authorized original source.
        cancellation_requested: Optional thread-safe cancellation predicate.

    Returns:
        Projected polygon union and bounded source window.

    Raises:
        ValueError: If projection fails or exceeds the statistics budget.
        NoRasterBoundsOverlapError: If the selection misses the source grid.
    """
    reader = PolygonRasterizer(
        dataset,
        sampling_area.resolved,
        RASTER_STATISTICS_MAX_TRANSFORMED_COORDINATES,
        cancellation_requested,
    )
    return SelectedRasterArea(
        source_window=reader.source_window, projected_geometries=reader
    )


def selected_raster_area_for_polygon_input(
    dataset: RasterDataset, sampling_area: PolygonInputSamplingArea
) -> SelectedRasterArea:
    """Project a saved polygon selection within the histogram coordinate budget.

    Use its validated bounds to choose the cyclic column view before projection.

    Args:
        dataset: Open, georeferenced source raster.
        sampling_area: Authorized temporary input containing exact WGS84 polygons.

    Returns:
        Polygon mask geometries and the integral source window covering them.

    Raises:
        ValueError: If projection fails or exceeds the coordinate budget.
        NoRasterBoundsOverlapError: If the selection misses the raster.
    """
    return selected_raster_area_for_wgs84_polygons(
        dataset,
        tuple(
            polygon.model_dump(mode="json")
            for polygon in sampling_area.polygons.polygons
        ),
        RASTER_STATISTICS_MAX_TRANSFORMED_COORDINATES,
        selected_bounds=sampling_area.polygons.bounds(),
    )


# A denser window than the histogram grid retains detail in sparse rasters.
BOX_PREVIEW_MAX_OVERVIEW_DIMENSION = 2048
BOX_PREVIEW_ALGORITHM = "box-statistics-native-or-nearest-v2"


def _summarize_box_pixels(
    valid: NDArray[numpy.float64],
    statistics: tuple[BoxStatistic, ...],
    method: Literal["exact", "estimated", "unavailable"],
    unit: str | None,
) -> RasterBoxPreview:
    """Calculate the requested statistics over the same included pixel values.

    Args:
        valid: Finite, unmasked pixel values inside the box, including zeros.
        statistics: Ordered built-in statistics and strict percentage thresholds.
        method: Source of this sample, shared by every returned value.
        unit: Declared band unit for the mean and population standard deviation.

    Returns:
        Values in request order, with nulls for an empty or unavailable sample.
    """
    results: dict[BoxStatistic, float] = {}
    if valid.size:
        if "mean" in statistics or "stdev" in statistics:
            magnitude = max(abs(float(valid.min())), abs(float(valid.max())))
            # A power of two preserves mantissas while keeping both moments finite.
            bound, exponent = math.frexp(magnitude)
            scaled = numpy.ldexp(valid, -exponent)
            if "mean" in statistics:
                mean = float(numpy.mean(scaled))
                results["mean"] = math.ldexp(max(-bound, min(bound, mean)), exponent)
            if "stdev" in statistics:
                # Subtract a nearby origin before centering tightly clustered values.
                deviation = float(numpy.std(scaled - scaled[0]))
                # Both the mean magnitude and the population deviation are at most
                # the largest absolute input. Rounding at that bound must stay finite.
                results["stdev"] = math.ldexp(min(deviation, bound), exponent)
        for statistic in dict.fromkeys(statistics):
            if isinstance(statistic, PercentAbove):
                results[statistic] = 100 * numpy.count_nonzero(valid > statistic.threshold) / valid.size
    return RasterBoxPreview(method=method, values=tuple(
        RasterPreviewValue(value=results.get(statistic), unit="%" if isinstance(statistic, PercentAbove) else unit)
        for statistic in statistics
    ))


def read_sampling_box_preview(
    source: RasterData,
    sampling_area: SamplingBoxArea,
    cancellation_requested: RasterReadCancellationCheck | None = None,
    *,
    statistics: tuple[BoxStatistic, ...],
) -> RasterBoxPreview:
    """Calculate all requested box statistics from one native or overview window.

    A nearest-neighbor overview samples one original value per regularly spaced
    cell. The finest suitable nearest-neighbor level supplies the sample.
    Zeros participate and NoData and nonfinite representatives are omitted.
    Means of averaged cells with unknown valid counts, or of mode/min/max
    overviews, cannot estimate these statistics on the same basis.

    Args:
        source: Authorized original raster or admitted temporal observation.
        sampling_area: Validated geodesic sampling box.
        cancellation_requested: Last-waiter cancellation check.
        statistics: Ordered statistics to calculate from this shared sample.

    Returns:
        Native or estimated values with units and a shared method. An empty exact box
        has a null value. Unsuitable or empty overview samples are unavailable.

    Raises:
        NoRasterBoundsOverlapError: If the box misses the source.
        ValueError: If source structure, validity or georeferencing is unsupported.
        RasterReadCancelled: If the read is superseded.
        rasterio.errors.RasterioError: If opening or reading the source fails.
    """
    require_active_raster_read(cancellation_requested)
    with open_raster_data(source) as dataset:
        require_signed_raster_dependencies(dataset, source)
        require_raster_analysis_georeferencing(dataset)
        area = selected_raster_area_for_sampling_box(
            dataset, sampling_area.box, RASTER_STATISTICS_MAX_TRANSFORMED_COORDINATES
        )
        window = area.source_window
        unit = dataset.units[0]
        native = plan_exact_source_window(dataset, window)
        if native is not None:
            sample = read_exact_source_window(dataset, native, cancellation_requested)
        else:
            sample = read_bounded_overview(
                dataset, window, 1, 1, cancellation_requested,
                maximum_dimension=BOX_PREVIEW_MAX_OVERVIEW_DIMENSION,
                prefer_finest=True,
                required_resampling=Resampling.nearest,
                maximum_decoded_bytes=EXACT_SOURCE_MAX_DECODED_BYTES,
            )
            if sample is None:
                return _summarize_box_pixels(numpy.empty(0, dtype=numpy.float64), statistics, "unavailable", unit)
        height, width = sample.shape
        transform = window_transform(window, dataset.transform) * rasterio.Affine.scale(
            window.width / width, window.height / height
        )
        inside = pixels_inside_area(
            area.projected_geometries, out_shape=sample.shape, transform=transform,
            all_touched=False,
        )
        valid = sample.data[inside & ~numpy.ma.getmaskarray(sample)].astype(numpy.float64, copy=False)
        require_active_raster_read(cancellation_requested)
        precision: Literal["exact", "estimated", "unavailable"] = "exact"
        if native is None:
            precision = "estimated" if valid.size else "unavailable"
        preview = _summarize_box_pixels(valid, statistics, precision, unit)
        require_active_raster_read(cancellation_requested)
        return preview


def read_raster_statistics(
    source: RasterData,
    sampling_area: RasterSamplingArea,
    cancellation_requested: RasterReadCancellationCheck | None = None,
) -> RasterStatistics:
    """Calculate band-one distributions using a complete window or a sample grid.

    The sampling area determines an integer-pixel source window. Windows that
    fit the dimension, block-count, and decoded-byte limits are read completely.
    Larger windows use a center-sampled grid with at most 127 cells per edge;
    its required blocks and decoded bytes are checked before reading. Sources
    without embedded validity masks use a suitable embedded overview when
    available. Sources with masks sample original pixels from native blocks.
    Both paths read source data independently of WMS publication.

    Args:
        source: Authorized raster file or selected temporal observation.
        sampling_area: Whole-raster, rectangle, geodesic box or authorized polygon selection.
        cancellation_requested: Optional thread-safe check that returns true when the read is cancelled.

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
    with open_raster_data(source) as dataset:
        require_active_raster_read(cancellation_requested)
        require_signed_raster_dependencies(dataset, source)
        require_raster_analysis_georeferencing(dataset)
        if isinstance(sampling_area, SelectedBoundsSamplingArea):
            selected_area = selected_raster_area_for_wgs84_bounds(
                dataset,
                sampling_area.bounds,
            )
        elif isinstance(sampling_area, SamplingBoxArea):
            selected_area = selected_raster_area_for_sampling_box(
                dataset,
                sampling_area.box,
                RASTER_STATISTICS_MAX_TRANSFORMED_COORDINATES,
            )
        elif isinstance(sampling_area, CatalogSelectionSamplingArea):
            selected_area = selected_raster_area_for_catalog_selection(
                dataset,
                sampling_area,
                cancellation_requested,
            )
        elif isinstance(sampling_area, PolygonInputSamplingArea):
            selected_area = selected_raster_area_for_polygon_input(
                dataset, sampling_area
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
            sample = read_source_window_sample_grid(
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
            outside_selection = ~pixels_inside_area(
                selected_area.projected_geometries,
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

    return summarize_raster_sample(sample, source_window, sampling_area, sampling_method)


def _count_histogram_bins(
    sorted_values: NDArray[numpy.float64], edges: NDArray[numpy.float64]
) -> RasterHistogram:
    """Count sorted sample values between consecutive edges, including the final edge.

    Args:
        sorted_values: All finite unmasked values in ascending order.
        edges: Strictly increasing bin boundaries.

    Returns:
        Counts and edges for the represented portion of the sample.
    """
    positions = sorted_values.searchsorted(edges, side="left")
    positions[-1] = sorted_values.searchsorted(edges[-1], side="right")
    return RasterHistogram(counts=numpy.diff(positions).tolist(), edges=edges.tolist())


class ContinuousRasterStatistics(RasterStatistics):
    """Keep the bounded continuous sample in the statistics cache for histogram zoom."""

    # Immutable bytes compare by value across native reader processes.
    _sorted_float64_bytes: bytes = PrivateAttr()

    def with_histogram_window(self, limits: tuple[float, float]) -> RasterStatistics:
        """Return statistics with an additional histogram over the inclusive limits.

        Args:
            limits: Requested finite, increasing minimum and maximum.

        Returns:
            A response sharing the full distribution and sampling provenance.

        Raises:
            ValueError: If the limits cannot represent 64 distinct float64 bins.
        """
        edges = build_raster_histogram_edges(*limits, RASTER_STATISTICS_BIN_COUNT)
        if (edges[0], edges[-1]) != limits:
            raise ValueError("Choose a wider histogram range to fit 64 distinct bins.")
        sorted_values = numpy.frombuffer(self._sorted_float64_bytes, dtype=numpy.float64)
        return self.model_copy(update={"window_histogram": _count_histogram_bins(sorted_values, edges)})


def summarize_raster_sample(
    sample: numpy.ma.MaskedArray,
    source_window: Window,
    sampling_area: RasterSamplingArea,
    sampling_method: Literal["sampleGrid", "exactSourceWindow"],
    *,
    retain_histogram_sample: bool = True,
) -> RasterStatistics:
    """Calculate counts, percentiles and a histogram from masked raster samples.

    Args:
        sample: Band-one values from the neutral raster reader, whose mask
            excludes nonfinite, NoData and invalid cells, plus any area exclusions.
        source_window: Integral source envelope represented by the sample.
        sampling_area: Validated scope and selection provenance.
        sampling_method: Exact native window or bounded center-grid method.
        retain_histogram_sample: Keep sorted valid values for continuous histogram zoom.

    Returns:
        Numeric counts, percentiles, suggested range and sampling provenance.

    Raises:
        NoValidRasterSamplesError: If no finite unmasked values remain.
    """
    source_width, source_height = int(source_window.width), int(source_window.height)
    sample_height, sample_width = sample.shape
    sample_values = numpy.asarray(sample.compressed(), dtype=numpy.float64)
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
    sample_values.sort()
    histogram = _count_histogram_bins(
        sample_values,
        build_raster_histogram_edges(sample_minimum, sample_maximum, RASTER_STATISTICS_BIN_COUNT),
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
    catalog_selection = (
        sampling_area.resolved.selection
        if isinstance(sampling_area, CatalogSelectionSamplingArea)
        else None
    )
    result_type = ContinuousRasterStatistics if retain_histogram_sample else RasterStatistics
    result = result_type(
        scope=sampling_area.kind,
        selectedBounds=selected_bounds_model,
        catalogSelection=catalog_selection,
        polygonArea=(
            sampling_area.reference
            if isinstance(sampling_area, PolygonInputSamplingArea)
            else None
        ),
        samplingBox=(
            sampling_area.box if isinstance(sampling_area, SamplingBoxArea) else None
        ),
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
        histogram=histogram,
        suggestedRange=suggested_range,
    )
    if isinstance(result, ContinuousRasterStatistics):
        result._sorted_float64_bytes = sample_values.tobytes()
    return result
