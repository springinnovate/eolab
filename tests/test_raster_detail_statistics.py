"""Test bounded click-window histograms for sampled raster previews."""

import asyncio
import numpy
import pytest

from eolab_app.raster.detail_preview import _suggested_range
from eolab_app.raster.detail_statistics import summarize_raster_detail_preview
from eolab_app.raster.detail_statistics_service import (
    RasterDetailStatisticsService,
)
from eolab_app.raster.errors import RasterConflictError
from eolab_app.raster.models import (
    CatalogRasterDetailStatisticsRequest,
    RasterDetailPreview,
)
from eolab_app.raster.statistics import NoValidRasterSamplesError


ITEM_ID = "geotiff-0123456789abcdef01234567"
SELECTED_BOUNDS = {
    "west": -123.0,
    "south": 48.0,
    "east": -122.0,
    "north": 49.0,
}


def _preview(
    values: list[float | None],
    width: int = 127,
    height: int = 127,
) -> RasterDetailPreview:
    """Build one valid fine current-view preview around controlled values.

    Args:
        values: Finite/nodata prefix padded to the exact fixed grid.
        width: Positive sampled-proxy width.
        height: Positive sampled-proxy height.

    Returns:
        Valid fine center-point sampled proxy.
    """
    pixels = values + [None] * (width * height - len(values))
    finite_values = [value for value in values if value is not None]
    suggested_range = None
    if finite_values:
        sample = numpy.ma.array(finite_values, dtype=numpy.float64)
        suggested_range = _suggested_range(sample)
    return RasterDetailPreview(
        scope="currentView",
        rendering="sampledProxy",
        policyVersion="bounded-adaptive-raster-v7",
        approximate=True,
        label="Approximate current-view center sample",
        rasterExtent=(-180.0, -90.0, 180.0, 90.0),
        imageBounds=(-123.0, 48.0, -122.0, 49.0),
        imageWidth=width,
        imageHeight=height,
        pixelValues=pixels,
        suggestedRange=suggested_range,
        limits={
            "maximumProxyDimension": 127,
            "maximumExactDetailDimension": 512,
            "maximumSourceBlockReads": 16_129,
            "maximumDecodedSourceBytes": 9_663_676_416,
            "maximumTransformedPositions": 16_129,
            "maximumPointsPerCell": 1,
        },
        actual={
            "sampleGridWidth": width,
            "sampleGridHeight": height,
            "sourceBlockReadCount": 1,
            "decodedSourceBytes": 4096,
            "pointsPerCell": 1,
        },
    )


def _request() -> CatalogRasterDetailStatisticsRequest:
    """Build one validated selected-window statistics request.

    Returns:
        Catalog request containing no browser-controlled source parameters.
    """
    return CatalogRasterDetailStatisticsRequest(
        collectionId="eolab-mounted-geotiffs",
        itemId=ITEM_ID,
        selectedBounds=SELECTED_BOUNDS,
    )


def test_detail_statistics_exclude_nodata_and_preserve_grid_provenance() -> None:
    """Summarize only finite points and report the exact bounded grid."""
    statistics = summarize_raster_detail_preview(
        _preview([-5.0, None, 1.0, 10.0]),
        _request(),
    )

    assert statistics.scope == "selectedArea"
    assert statistics.selected_bounds is not None
    assert statistics.selected_bounds.model_dump() == SELECTED_BOUNDS
    assert statistics.sample_width == statistics.source_width == 127
    assert statistics.sample_height == statistics.source_height == 127
    assert statistics.sampled_pixel_count == 127 * 127
    assert statistics.valid_sample_count == 3
    assert statistics.sample_minimum == -5.0
    assert statistics.sample_maximum == 10.0
    assert statistics.percentiles.p50 == 1.0
    assert sum(statistics.histogram.counts) == 3
    assert len(statistics.histogram.counts) == 64
    assert len(statistics.histogram.edges) == 65


def test_detail_statistics_accept_aspect_grid_and_exact_source_detail() -> None:
    """Summarize both representations produced by the adaptive reader."""
    landscape = summarize_raster_detail_preview(
        _preview([1.0, 2.0, 3.0], width=127, height=64),
        _request(),
    )
    assert (landscape.sample_width, landscape.sample_height) == (127, 64)

    exact_document = _preview([1.0, 2.0]).model_dump(by_alias=True)
    exact_document.update({
        "rendering": "exactSourceWindow",
        "imageWidth": 3,
        "imageHeight": 2,
        "pixelValues": [1.0, 2.0, None, 3.0, 4.0, 5.0],
        "suggestedRange": {"minimum": 1.0, "midpoint": 3.0, "maximum": 5.0},
        "limits": {
            **exact_document["limits"],
            "maximumSourceBlockReads": 1_024,
            "maximumDecodedSourceBytes": 67_108_864,
        },
        "actual": {
            "sampleGridWidth": 3,
            "sampleGridHeight": 2,
            "sourceBlockReadCount": 1,
            "decodedSourceBytes": 4096,
            "pointsPerCell": 0,
            "sourceWindow": {
                "columnOffset": 10,
                "rowOffset": 20,
                "width": 3,
                "height": 2,
            },
        },
    })
    exact = summarize_raster_detail_preview(
        RasterDetailPreview.model_validate(exact_document),
        _request(),
    )
    assert (exact.sample_width, exact.sample_height) == (3, 2)
    assert exact.valid_sample_count == 5


def test_detail_statistics_reject_nodata_only_and_wrong_preview_policy() -> None:
    """Keep empty or non-current-view data outside histogram contract."""
    with pytest.raises(NoValidRasterSamplesError):
        summarize_raster_detail_preview(_preview([None]), _request())

    wrong_preview = _preview([1.0, 2.0]).model_copy(
        update={"scope": "rasterExtent"}
    )
    with pytest.raises(ValueError, match="fixed current-view center policy"):
        summarize_raster_detail_preview(wrong_preview, _request())


def test_service_forces_fine_center_grid_over_selected_bounds() -> None:
    """Reuse the authorized detail reader with no caller-selected read shape."""
    requests = []

    class _PreviewService:
        """Record one delegated bounded-preview request."""

        async def get(self, request: object) -> RasterDetailPreview:
            """Return controlled preview after recording the request.

            Args:
                request: Service-owned detail-preview request.

            Returns:
                Controlled finite fine-grid preview.
            """
            requests.append(request)
            return _preview([2.0, 4.0, 8.0])

    service = RasterDetailStatisticsService(_PreviewService())  # type: ignore[arg-type]
    statistics = asyncio.run(service.get(_request()))

    delegated = requests[0]
    assert delegated.view_bounds is not None
    assert delegated.view_bounds.model_dump() == SELECTED_BOUNDS
    assert statistics.valid_sample_count == 3


def test_service_maps_nodata_only_grid_to_actionable_conflict() -> None:
    """Report an honest selected-area failure without inventing zero values."""

    class _PreviewService:
        """Return one all-nodata bounded preview."""

        async def get(self, request: object) -> RasterDetailPreview:
            """Return all nodata for the ignored controlled request.

            Args:
                request: Service-owned preview request.

            Returns:
                Fine current-view preview with no finite points.
            """
            return _preview([None])

    service = RasterDetailStatisticsService(_PreviewService())  # type: ignore[arg-type]

    with pytest.raises(RasterConflictError, match="No finite, non-nodata"):
        asyncio.run(service.get(_request()))


def test_preview_initial_range_uses_bounded_minimum_median_and_maximum() -> None:
    """Initialize browser colors from approximate extrema and median."""
    result = _suggested_range(
        numpy.ma.array([-100.0, 1.0, 2.0, 3.0, 1_000.0])
    )

    assert result is not None
    assert result.minimum == -100.0
    assert result.midpoint == 2.0
    assert result.maximum == 1_000.0
