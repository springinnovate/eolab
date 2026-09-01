"""FastAPI delivery boundary for raster publication."""

from dataclasses import dataclass

from fastapi import APIRouter

from eolab_app.raster.errors import RasterFeatureError
from eolab_app.raster.models import (
    CatalogRasterRequest,
    PublishedRaster,
)
from eolab_app.raster.publication import RasterPublicationService
from eolab_app.raster.sources import PublishedRasterRegistry
from eolab_app.routes.raster_http import raster_http_exception


@dataclass(frozen=True)
class RasterFeature:
    """One explicit raster feature boundary wired into the application.

    Attributes:
        router: Prepared-raster publication route; analysis is exposed by its
            sibling router.
        registry: Process-local authorization consulted by the WMS proxy.
    """

    router: APIRouter
    registry: PublishedRasterRegistry


def create_raster_feature(
    publication_service: RasterPublicationService,
    registry: PublishedRasterRegistry,
) -> RasterFeature:
    """Create the raster router around fully constructed services.

    Args:
        publication_service: Serialized publication workflow.
        registry: Process-local layer authorization shared with WMS.

    Returns:
        Router and registry forming the explicit raster feature boundary.
    """
    router = APIRouter(prefix="/api/rendering", tags=["rendering"])

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

    return RasterFeature(router=router, registry=registry)
