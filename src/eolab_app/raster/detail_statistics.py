"""Summarize one bounded sampled-raster grid for histogram controls."""

import numpy

from eolab_app.raster.models import (
    CatalogRasterDetailStatisticsRequest,
    RasterDetailPreview,
    RasterHistogram,
    RasterPercentiles,
    RasterStatistics,
)
from eolab_app.raster.statistics import (
    NoValidRasterSamplesError,
    RASTER_STATISTICS_BIN_COUNT,
    strict_raster_value_range,
)


def summarize_raster_detail_preview(
    preview: RasterDetailPreview,
    request: CatalogRasterDetailStatisticsRequest,
) -> RasterStatistics:
    """Build the shared histogram contract from one exact sampled grid.

    The preview reader has already enforced source authorization, strict native
    block/decoded-work ceilings, nodata handling, and exact placement over the
    requested map window. This function performs no source I/O.

    Args:
        preview: Current-view fine center-sample preview.
        request: Catalog identity and exact selected WGS 84 bounds.

    Returns:
        Selected-area 64-bin statistics over finite sampled-grid cells.

    Raises:
        NoValidRasterSamplesError: If every sampled cell is nodata/non-finite.
        ValueError: If the preview does not have the required provenance.
    """
    if (
        preview.mode != "centerSample"
        or preview.scope != "currentView"
        or preview.density != "fine"
        or preview.image_width != 127
        or preview.image_height != 127
    ):
        raise ValueError("Detail histogram requires a fine current-view center grid")
    sample_values = numpy.asarray(
        [value for value in preview.pixel_values if value is not None],
        dtype=numpy.float64,
    )
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
    sampled_pixel_count = preview.image_width * preview.image_height
    return RasterStatistics(
        scope="selectedArea",
        selectedBounds=request.selected_bounds,
        sourceWidth=preview.image_width,
        sourceHeight=preview.image_height,
        sourcePixelCount=sampled_pixel_count,
        sampleWidth=preview.image_width,
        sampleHeight=preview.image_height,
        sampledPixelCount=sampled_pixel_count,
        validSampleCount=int(sample_values.size),
        estimated=True,
        sampleMinimum=sample_minimum,
        sampleMaximum=sample_maximum,
        percentiles=RasterPercentiles(p05=p05, p50=p50, p95=p95),
        histogram=RasterHistogram(
            counts=[int(count) for count in counts],
            edges=[float(edge) for edge in edges],
        ),
        suggestedRange=suggested_range,
    )
