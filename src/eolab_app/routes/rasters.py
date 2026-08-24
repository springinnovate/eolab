"""FastAPI delivery boundary for raster application services."""

import asyncio
from dataclasses import dataclass

from fastapi import APIRouter, HTTPException, Request

from eolab_app.raster.assessment import RasterAssessmentService
from eolab_app.raster.detail_preview_service import RasterDetailPreviewService
from eolab_app.raster.errors import RasterFeatureError
from eolab_app.raster.models import (
    CatalogRasterDetailPreviewRequest,
    CatalogRasterRequest,
    PublishedRaster,
    RasterDetailPreview,
)
from eolab_app.raster.publication import RasterPublicationService
from eolab_app.raster.sources import PublishedRasterRegistry
from eolab_app.routes.raster_http import (
    raster_http_exception,
    wait_for_http_disconnect,
)


@dataclass(frozen=True)
class RasterFeature:
    """One explicit raster feature boundary wired into the application.

    Attributes:
        router: Rendering routes for assessment, publication, and bounded
            detail previews; analysis is exposed by its sibling router.
        registry: Process-local authorization consulted by the WMS proxy.
    """

    router: APIRouter
    registry: PublishedRasterRegistry


def create_raster_feature(
    assessment_service: RasterAssessmentService,
    publication_service: RasterPublicationService,
    detail_preview_service: RasterDetailPreviewService,
    registry: PublishedRasterRegistry,
) -> RasterFeature:
    """Create the raster router around fully constructed services.

    Args:
        assessment_service: Authoritative reassessment workflow.
        publication_service: Serialized publication workflow.
        detail_preview_service: Coalescing bounded detail-preview workflow.
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
        http_request: Request,
    ) -> RasterDetailPreview:
        """Return an explicitly selected bounded sampled-raster preview.

        Args:
            request: Catalog identity and optional current map view.
            http_request: Incoming request used to detect cancellation.

        Returns:
            Georeferenced numeric image colored by the browser's shared raster
            ramp without any arbitrary full-source read.

        Raises:
            HTTPException: If the raster or preview contract is inapplicable
                or the browser disconnects.
        """
        preview_task = asyncio.create_task(detail_preview_service.get(request))
        disconnect_task = asyncio.create_task(
            wait_for_http_disconnect(http_request)
        )
        try:
            completed_tasks, _ = await asyncio.wait(
                (preview_task, disconnect_task),
                return_when=asyncio.FIRST_COMPLETED,
            )
            if preview_task in completed_tasks:
                try:
                    return preview_task.result()
                except RasterFeatureError as error:
                    raise raster_http_exception(error) from error

            raise HTTPException(
                status_code=499,
                detail="The raster detail preview request was canceled",
            )
        finally:
            disconnect_task.cancel()
            preview_task.cancel()
            await asyncio.gather(
                preview_task,
                disconnect_task,
                return_exceptions=True,
            )

    return RasterFeature(router=router, registry=registry)
