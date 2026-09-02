"""FastAPI delivery boundary for rendering-independent raster analysis."""

from fastapi import APIRouter, HTTPException, Request

from eolab_app.raster.errors import RasterFeatureError
from eolab_app.raster.models import (
    CatalogPixelRequest,
    CatalogRasterPairRequest,
    CatalogRasterStatisticsRequest,
    RasterPixel,
    RasterPairedStatistics,
    RasterStatistics,
)
from eolab_app.raster.pixel_service import RasterPixelService
from eolab_app.raster.statistics_service import RasterStatisticsService
from eolab_app.routes.http_disconnect import (
    HttpClientDisconnectedError,
    run_until_http_disconnect,
)
from eolab_app.routes.raster_http import raster_http_exception


def create_raster_analysis_router(
    pixel_service: RasterPixelService,
    statistics_service: RasterStatisticsService,
) -> APIRouter:
    """Create independent raster-analysis routes.

    Args:
        pixel_service: Catalog-authorized, capacity-limited pixel workflow.
        statistics_service: Catalog-authorized bounded histogram workflow.

    Returns:
        Router that does not depend on visualization or publication state.
    """
    router = APIRouter(
        prefix="/api/raster-analysis",
        tags=["raster-analysis"],
    )

    @router.post(
        "/pixels",
        response_model=RasterPixel,
    )
    async def sample_raster_pixel(
        request: CatalogPixelRequest,
    ) -> RasterPixel:
        """Read one pixel from a selected catalog raster.

        Args:
            request: Catalog Item identity and WGS 84 coordinate.

        Returns:
            Band-one pixel position and value or out-of-bounds result.

        Raises:
            HTTPException: If the source is not current or cannot be sampled.
        """
        try:
            return await pixel_service.get(request)
        except RasterFeatureError as error:
            raise raster_http_exception(error) from error

    @router.post(
        "/statistics",
        response_model=RasterStatistics,
    )
    async def sample_raster_statistics(
        request: CatalogRasterStatisticsRequest,
        http_request: Request,
    ) -> RasterStatistics:
        """Summarize one catalog raster and normalized sampling area.

        Args:
            request: Catalog identity and strict whole/bounds/AOI area union.
            http_request: Incoming request used to detect cancellation.

        Returns:
            Bounded band-1 statistics independent of rendering state.

        Raises:
            HTTPException: If analysis fails or the browser disconnects.
        """
        try:
            return await run_until_http_disconnect(
                http_request,
                statistics_service.get(request),
            )
        except RasterFeatureError as error:
            raise raster_http_exception(error) from error
        except HttpClientDisconnectedError as error:
            raise HTTPException(
                status_code=499,
                detail="The raster statistics request was canceled",
            ) from error

    @router.post(
        "/paired-statistics",
        response_model=RasterPairedStatistics,
    )
    async def sample_paired_raster_statistics(
        request: CatalogRasterPairRequest,
        http_request: Request,
    ) -> RasterPairedStatistics:
        """Summarize valid paired cells on the ordered X reference grid.

        Args:
            request: Two catalog identities and optional canonical bounds.
            http_request: Incoming request used to detect cancellation.

        Returns:
            Bounded two-dimensional histogram, marginals, and provenance.

        Raises:
            HTTPException: If analysis fails or the browser disconnects.
        """
        try:
            return await run_until_http_disconnect(
                http_request,
                statistics_service.get_paired(request),
            )
        except RasterFeatureError as error:
            raise raster_http_exception(error) from error
        except HttpClientDisconnectedError as error:
            raise HTTPException(
                status_code=499,
                detail="The paired raster statistics request was canceled",
            ) from error

    return router
