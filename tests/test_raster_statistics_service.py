"""Test raster statistics caching and source-identity lifecycle."""

import asyncio
import threading
from pathlib import Path

from eolab_app.raster.models import (
    AuthorizedRaster,
    CatalogRasterPairRequest,
    CatalogRasterStatisticsRequest,
    RasterHistogram,
    RasterPairedHistogram,
    RasterPairedStatistics,
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


def _paired_statistics(value: float) -> RasterPairedStatistics:
    """Build one valid bounded paired-statistics result.

    Args:
        value: Single finite value represented in both axes.

    Returns:
        Valid exact paired response with one populated matrix cell.
    """
    counts = [[0 for _ in range(32)] for _ in range(32)]
    counts[0][0] = 1
    return RasterPairedStatistics(
        scope="wholeOverlap",
        selectedBounds=None,
        sourceWidth=1,
        sourceHeight=1,
        sourcePixelCount=1,
        sampleWidth=1,
        sampleHeight=1,
        sampledCellCount=1,
        pairedSampleCount=1,
        samplingMethod="exactReferenceGrid",
        approximate=False,
        xMinimum=value,
        xMaximum=value,
        yMinimum=value,
        yMaximum=value,
        histogram=RasterPairedHistogram(
            xEdges=[float(index) for index in range(33)],
            yEdges=[float(index) for index in range(33)],
            counts=counts,
            xMarginalCounts=[1, *([0] * 31)],
            yMarginalCounts=[1, *([0] * 31)],
        ),
    )


class _PairSourceAuthorizer:
    """Authorize two independently replaceable catalog source identities."""

    def __init__(self, directory: Path) -> None:
        """Create controlled X and Y authorizations.

        Args:
            directory: Directory used for inert source path identities.
        """
        self.authorizations = {
            "geotiff-0123456789abcdef01234567": AuthorizedRaster(
                directory / "x.tif", (1, 2, 3, 4, 5)
            ),
            "geotiff-abcdef0123456789abcdef01": AuthorizedRaster(
                directory / "y.tif", (6, 7, 8, 9, 10)
            ),
        }

    async def authorize(self, request: object) -> AuthorizedRaster:
        """Return the authorization for one request Item.

        Args:
            request: Catalog request containing an ``item_id`` field.

        Returns:
            Current controlled source authorization.
        """
        return self.authorizations[request.item_id]

    async def require_current(self, authorized: AuthorizedRaster) -> None:
        """Require the supplied authorization to remain current.

        Args:
            authorized: Source authorization captured around the read.

        Returns:
            None while an exact controlled value remains present.
        """
        assert authorized in self.authorizations.values()


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


def test_statistics_service_keys_pairs_by_ordered_identities_and_signatures(
    tmp_path: Path,
) -> None:
    """Coalesce an ordered pair and recompute after either source changes.

    Args:
        tmp_path: Directory used for controlled source path identities.
    """
    source_authorizer = _PairSourceAuthorizer(tmp_path)
    read_count = 0
    read_started = threading.Event()
    release_read = threading.Event()

    def reader(
        _: Path,
        __: Path,
        ___: object,
        ____: object,
    ) -> RasterPairedStatistics:
        """Return a new controlled result for each admitted computation."""
        nonlocal read_count
        read_count += 1
        read_started.set()
        assert release_read.wait(timeout=2)
        return _paired_statistics(float(read_count))

    service = RasterStatisticsService(
        source_authorizer,
        read_concurrency=1,
        cache_entries=32,
        paired_statistics_reader=reader,
    )
    request = CatalogRasterPairRequest.model_validate({
        "xRaster": {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-0123456789abcdef01234567",
        },
        "yRaster": {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-abcdef0123456789abcdef01",
        },
    })

    async def exercise_cache() -> None:
        """Coalesce the pair, then invalidate it through Y identity."""
        first_request = asyncio.create_task(service.get_paired(request))
        assert await asyncio.to_thread(read_started.wait, 2)
        second_request = asyncio.create_task(service.get_paired(request))
        await asyncio.sleep(0)
        release_read.set()
        first, coalesced = await asyncio.gather(
            first_request,
            second_request,
        )
        assert coalesced is first
        assert await service.get_paired(request) is first
        source_authorizer.authorizations[request.y_raster.item_id] = (
            AuthorizedRaster(tmp_path / "y.tif", (6, 7, 8, 9, 11))
        )
        replacement = await service.get_paired(request)
        assert replacement.x_minimum == 2

    asyncio.run(exercise_cache())
    assert read_count == 2


def test_statistics_service_shares_one_completed_cache_budget(
    tmp_path: Path,
) -> None:
    """Evict ordinary and paired results through one configured LRU limit.

    Args:
        tmp_path: Directory used for controlled source path identities.
    """
    source_authorizer = _PairSourceAuthorizer(tmp_path)
    ordinary_read_count = 0
    paired_read_count = 0

    def ordinary_reader(
        _: Path,
        __: object,
        ___: object,
    ) -> RasterStatistics:
        """Return a distinguishable ordinary result for each cache miss."""
        nonlocal ordinary_read_count
        ordinary_read_count += 1
        return _statistics(float(ordinary_read_count))

    def paired_reader(
        _: Path,
        __: Path,
        ___: object,
        ____: object,
    ) -> RasterPairedStatistics:
        """Return a distinguishable paired result for each cache miss."""
        nonlocal paired_read_count
        paired_read_count += 1
        return _paired_statistics(float(paired_read_count))

    service = RasterStatisticsService(
        source_authorizer,
        read_concurrency=1,
        cache_entries=1,
        statistics_reader=ordinary_reader,
        paired_statistics_reader=paired_reader,
    )
    ordinary_request = CatalogRasterStatisticsRequest.model_validate({
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": "geotiff-0123456789abcdef01234567",
    })
    paired_request = CatalogRasterPairRequest.model_validate({
        "xRaster": {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-0123456789abcdef01234567",
        },
        "yRaster": {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-abcdef0123456789abcdef01",
        },
    })

    async def exercise_combined_limit() -> None:
        """Prove each result type evicts the other at a one-entry limit."""
        first_ordinary = await service.get(ordinary_request)
        assert await service.get(ordinary_request) is first_ordinary
        first_paired = await service.get_paired(paired_request)
        assert await service.get_paired(paired_request) is first_paired
        second_ordinary = await service.get(ordinary_request)
        assert second_ordinary is not first_ordinary
        second_paired = await service.get_paired(paired_request)
        assert second_paired is not first_paired

    asyncio.run(exercise_combined_limit())
    assert ordinary_read_count == 2
    assert paired_read_count == 2
