"""FastAPI delivery boundary for raster application services."""

import asyncio
from dataclasses import dataclass

from fastapi import APIRouter, HTTPException, Request

from eolab_app.raster.assessment import RasterAssessmentService
from eolab_app.raster.detail_preview_service import RasterDetailPreviewService
from eolab_app.raster.detail_statistics_service import (
    RasterDetailStatisticsService,
)
from eolab_app.raster.errors import RasterFeatureError
from eolab_app.raster.models import (
    CatalogRasterDetailPreviewRequest,
    CatalogRasterDetailStatisticsRequest,
    CatalogRasterRequest,
    CatalogRasterStatisticsRequest,
    PublishedRaster,
    RasterDetailPreview,
    RasterStatistics,
)
from eolab_app.raster.publication import RasterPublicationService
from eolab_app.raster.sources import PublishedRasterRegistry
from eolab_app.raster.statistics_service import RasterStatisticsService
from eolab_app.routes.raster_http import raster_http_exception


@dataclass(frozen=True)
class RasterFeature:
    """One explicit raster feature boundary wired into the application.

    Attributes:
        router: HTTP routes for raster assessment, publication, and analysis.
        registry: Process-local authorization consulted by the WMS proxy.
    """

    router: APIRouter
    registry: PublishedRasterRegistry


async def wait_for_http_disconnect(request: Request) -> None:
    """Wait until the ASGI server reports that the browser disconnected.

    Args:
        request: Incoming statistics request.

    Returns:
        None after an ``http.disconnect`` message arrives.
    """
    while (message := await request.receive())["type"] != "http.disconnect":
        pass


def create_raster_feature(
    assessment_service: RasterAssessmentService,
    publication_service: RasterPublicationService,
    statistics_service: RasterStatisticsService,
    detail_preview_service: RasterDetailPreviewService,
    detail_statistics_service: RasterDetailStatisticsService,
    registry: PublishedRasterRegistry,
) -> RasterFeature:
    """Create the raster router around fully constructed services.

    Args:
        assessment_service: Authoritative reassessment workflow.
        publication_service: Serialized publication workflow.
        statistics_service: Coalescing statistics workflow.
        detail_preview_service: Coalescing bounded detail-preview workflow.
        detail_statistics_service: Selected-window sampled-grid statistics.
        registry: Process-local layer authorization shared with WMS.

    Returns:
        Router and registry forming the explicit raster feature boundary.
    """
    router = APIRouter(prefix="/api/rendering", tags=["rendering"])

    @router.post(
        "/assessments",
        response_model=dict[str, object],
    )
    async def assess_raster(
        request: CatalogRasterRequest,
    ) -> dict[str, object]:
        """Assess and update one selected legacy raster Item.

        Args:
            request: Authoritative Collection and Item identity.

        Returns:
            Updated browser-safe raster visualization assessment.

        Raises:
            HTTPException: If the Item or mounted raster cannot be assessed.
        """
        try:
            return await assessment_service.assess(request)
        except RasterFeatureError as error:
            raise raster_http_exception(error) from error

    @router.post(
        "/layers",
        response_model=PublishedRaster,
    )
    async def publish_raster(
        request: CatalogRasterRequest,
    ) -> PublishedRaster:
        """Publish one authoritative mounted GeoTIFF as a WMS layer.

        Args:
            request: Authoritative Collection and Item identity.

        Returns:
            Published WMS layer identity and raster bounds.

        Raises:
            HTTPException: If catalog, source, or GeoServer publication fails.
        """
        try:
            return await publication_service.publish(request)
        except RasterFeatureError as error:
            raise raster_http_exception(error) from error

    @router.post(
        "/detail-previews",
        response_model=RasterDetailPreview,
    )
    async def raster_detail_preview(
        request: CatalogRasterDetailPreviewRequest,
    ) -> RasterDetailPreview:
        """Return an explicitly selected bounded sampled-raster preview.

        Args:
            request: Catalog identity and one of the three fixed preview modes.

        Returns:
            Georeferenced numeric image colored by the browser's shared raster
            ramp without any arbitrary full-source read.

        Raises:
            HTTPException: If the raster or preview contract is inapplicable.
        """
        try:
            return await detail_preview_service.get(request)
        except RasterFeatureError as error:
            raise raster_http_exception(error) from error

    @router.post(
        "/statistics",
        response_model=RasterStatistics,
    )
    async def raster_statistics(
        request: CatalogRasterStatisticsRequest,
        http_request: Request,
    ) -> RasterStatistics:
        """Summarize a whole raster or selected area through a bounded sample.

        Args:
            request: Published Item identity and optional selected bounds.
            http_request: Incoming request used to detect cancellation.

        Returns:
            Bounded raster statistics for the requested scope.

        Raises:
            HTTPException: If sampling fails or the browser disconnects.
        """
        statistics_task = asyncio.create_task(statistics_service.get(request))
        disconnect_task = asyncio.create_task(
            wait_for_http_disconnect(http_request)
        )
        try:
            completed_tasks, _ = await asyncio.wait(
                (statistics_task, disconnect_task),
                return_when=asyncio.FIRST_COMPLETED,
            )
            if statistics_task in completed_tasks:
                try:
                    return statistics_task.result()
                except RasterFeatureError as error:
                    raise raster_http_exception(error) from error

            raise HTTPException(
                status_code=499,
                detail="The raster statistics request was canceled",
            )
        finally:
            disconnect_task.cancel()
            statistics_task.cancel()
            await asyncio.gather(
                statistics_task,
                disconnect_task,
                return_exceptions=True,
            )

    @router.post(
        "/detail-statistics",
        response_model=RasterStatistics,
    )
    async def raster_detail_statistics(
        request: CatalogRasterDetailStatisticsRequest,
    ) -> RasterStatistics:
        """Summarize one clicked window on an overview-limited raster.

        Args:
            request: Catalog identity and required WGS 84 selected bounds.

        Returns:
            Fixed-bin histogram over bounded Fine adaptive detail.

        Raises:
            HTTPException: If authorization or bounded sampling fails.
        """
        try:
            return await detail_statistics_service.get(request)
        except RasterFeatureError as error:
            raise raster_http_exception(error) from error

    return RasterFeature(router=router, registry=registry)
