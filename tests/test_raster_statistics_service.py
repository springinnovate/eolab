"""Test raster statistics caching and source-identity lifecycle."""

import asyncio
from pathlib import Path

from eolab_app.raster.models import (
    AuthorizedRaster,
    CatalogRasterStatisticsRequest,
    RasterHistogram,
    RasterPercentiles,
    RasterStatistics,
    RasterValueRange,
)
from eolab_app.raster.statistics_service import RasterStatisticsService


class _SourceAuthorizer:
    """Return a replaceable authorized source identity."""

    def __init__(self, source_path: Path) -> None:
        """Authorize an initial source signature."""
        self.authorization = AuthorizedRaster(source_path, (1, 2, 3, 4, 5))

    async def authorize(self, _: object) -> AuthorizedRaster:
        """Return the current controlled authorization."""
        return self.authorization

    async def require_current(self, authorized: AuthorizedRaster) -> None:
        """Require the supplied authorization to remain current."""
        assert authorized == self.authorization


def _statistics(value: float) -> RasterStatistics:
    """Build one valid bounded statistics result."""
    return RasterStatistics(
        scope="wholeRaster",
        selectedBounds=None,
        sourceWidth=1,
        sourceHeight=1,
        sourcePixelCount=1,
        sampleWidth=1,
        sampleHeight=1,
        sampledPixelCount=1,
        validSampleCount=1,
        samplingMethod="exactSourceWindow",
        estimated=False,
        sampleMinimum=value,
        sampleMaximum=value,
        percentiles=RasterPercentiles(p05=value, p50=value, p95=value),
        histogram=RasterHistogram(
            counts=[1, *([0] * 63)],
            edges=[float(index) for index in range(65)],
        ),
        suggestedRange=RasterValueRange(
            minimum=value - 1,
            midpoint=value,
            maximum=value + 1,
        ),
    )


def test_statistics_service_caches_by_approved_source_signature(
    tmp_path: Path,
) -> None:
    """Reuse one source version and recompute after authorization changes."""
    source_authorizer = _SourceAuthorizer(tmp_path / "raster.tif")
    read_count = 0

    def reader(_: Path, __: object, ___: object) -> RasterStatistics:
        nonlocal read_count
        read_count += 1
        return _statistics(float(read_count))

    service = RasterStatisticsService(
        source_authorizer,
        read_concurrency=1,
        cache_entries=32,
        statistics_reader=reader,
    )
    request = CatalogRasterStatisticsRequest.model_validate(
        {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-0123456789abcdef01234567",
        }
    )

    async def exercise_cache() -> None:
        first = await service.get(request)
        assert await service.get(request) is first
        source_authorizer.authorization = AuthorizedRaster(
            source_authorizer.authorization.source_path,
            (1, 2, 3, 4, 6),
        )
        replacement = await service.get(request)
        assert replacement.sample_minimum == 2

    asyncio.run(exercise_cache())
    assert read_count == 2
