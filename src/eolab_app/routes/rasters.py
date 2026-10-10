"""FastAPI delivery boundary for raster publication."""

from dataclasses import dataclass
from collections.abc import Callable

from fastapi import APIRouter, HTTPException, Request, Response

from eolab_app.raster.errors import RasterFeatureError
from eolab_app.raster.models import (
    CatalogRasterRequest,
    PublishedRaster,
)
from eolab_app.raster.publication import RasterPublicationService
from eolab_app.raster.sources import PublishedRasterRegistry
from eolab_app.routes.raster_http import raster_http_exception
from eolab_app.raster.source_models import RasterSourceRequest, RunArtifactReference
from eolab_app.source_files import SourceFileError

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
    session_owner: Callable[[Request, Response], str] | None = None,
) -> RasterFeature:
    """Create the raster router around fully constructed services.

    Args:
        publication_service: Serialized publication workflow.
        registry: Process-local layer authorization shared with WMS.
        session_owner: Composition-supplied current-session authority for run outputs.

    Returns:
        Router and registry forming the explicit raster feature boundary.
    """
    router = APIRouter(prefix="/api/rendering", tags=["rendering"])

    @router.post(
        "/layers",
        response_model=PublishedRaster,
    )
    async def publish_raster(
        request: CatalogRasterRequest | RasterSourceRequest,
        http_request: Request,
        response: Response,
    ) -> PublishedRaster:
        """Publish one authoritative mounted GeoTIFF as a WMS layer.

        Args:
            request: Authoritative Collection and Item identity.
            http_request: HTTP session and same-origin request context.
            response: Private response headers for temporary publications.

        Returns:
            Published WMS layer identity and raster bounds.

        Raises:
            HTTPException: If catalog, source, or GeoServer publication fails.
        """
        try:
            owner = None
            if isinstance(request, RasterSourceRequest) and isinstance(
                request.source, RunArtifactReference
            ):
                if session_owner is None:
                    raise SourceFileError(
                        "Temporary raster publication is unavailable.", 503
                    )
                owner = session_owner(http_request, response)
            if owner is None:
                return await publication_service.publish(request)
            return await publication_service.publish(request, owner)
        except RasterFeatureError as error:
            raise raster_http_exception(error) from error
        except SourceFileError as error:
            raise HTTPException(
                error.status, str(error), headers={"Cache-Control": "private, no-store"}
            ) from error

    return RasterFeature(router=router, registry=registry)
