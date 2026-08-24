"""FastAPI delivery boundary for rendering-independent raster analysis."""

from fastapi import APIRouter

from eolab_app.raster.errors import RasterFeatureError
from eolab_app.raster.models import CatalogPixelRequest, RasterPixel
from eolab_app.raster.pixel_service import RasterPixelService
from eolab_app.routes.raster_http import raster_http_exception


def create_raster_analysis_router(
    pixel_service: RasterPixelService,
) -> APIRouter:
    """Create independent raster-analysis routes.

    Args:
        pixel_service: Catalog-authorized, capacity-limited pixel workflow.

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

    return router
