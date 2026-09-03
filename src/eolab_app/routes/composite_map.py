"""HTTP delivery for authorized GeoServer-composed map tiles."""

import math
import re

import httpx2
from fastapi import APIRouter, HTTPException, Request, Response

from eolab_app.diagnostics.tracker import GetMapRequestTracker
from eolab_app.rendering.composite import (
    CompositeMapPlanUnavailableError,
    CompositeMapRenderingService,
)
from eolab_app.rendering.errors import (
    PublishedLayerChangedError,
    PublishedLayerNotAuthorizedError,
    PublishedLayerRequestError,
)
from eolab_app.rendering.models import (
    CompositeMapPlanRequest,
    PublishedCompositeMapPlan,
)
from eolab_app.rendering.sld import build_get_map_document
from eolab_app.routes.geoserver_map import (
    forward_geoserver_get_map,
    geoserver_forward_headers,
)


_PLAN_ID_PATTERN = re.compile(r"[0-9a-f]{64}")
_COMPOSITE_TILE_PARAMETERS = frozenset({
    "bbox",
    "format",
    "height",
    "layers",
    "request",
    "service",
    "srs",
    "styles",
    "tiled",
    "tilesorigin",
    "transparent",
    "version",
    "width",
})


def validated_composite_tile_query(
    request: Request,
) -> tuple[tuple[float, float, float, float], int, int, str]:
    """Validate the exact Leaflet WMS tile contract for a composite plan.

    Args:
        request: Incoming same-origin tile request.

    Returns:
        Finite projected bounding box, pixel width, pixel height, and SRS.

    Raises:
        HTTPException: If the request is not one bounded transparent PNG tile.
    """
    entries = list(request.query_params.multi_items())
    query = {key.lower(): value for key, value in entries}
    if len(query) != len(entries):
        raise HTTPException(
            status_code=400,
            detail="Tile parameters must not repeat",
        )
    unsupported = query.keys() - _COMPOSITE_TILE_PARAMETERS
    if unsupported:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported tile parameter: {sorted(unsupported)[0]}",
        )
    required = {
        "service": "wms",
        "version": "1.1.1",
        "request": "getmap",
        "layers": "composite",
        "format": "image/png",
        "transparent": "true",
        "srs": "epsg:3857",
    }
    for name, expected in required.items():
        if query.get(name, "").lower() != expected:
            raise HTTPException(
                status_code=400,
                detail=f"{name} must be {expected}",
            )
    if query.get("styles", "") != "":
        raise HTTPException(status_code=400, detail="styles must be empty")
    try:
        width = int(query["width"])
        height = int(query["height"])
    except (KeyError, ValueError) as error:
        raise HTTPException(
            status_code=400,
            detail="width and height must be integers",
        ) from error
    if not 1 <= width <= 512 or not 1 <= height <= 512:
        raise HTTPException(
            status_code=400,
            detail="width and height must be between 1 and 512",
        )
    try:
        bbox = tuple(float(value) for value in query["bbox"].split(","))
    except (KeyError, ValueError) as error:
        raise HTTPException(
            status_code=400,
            detail="bbox must contain four finite numbers",
        ) from error
    if (
        len(bbox) != 4
        or not all(math.isfinite(value) for value in bbox)
        or bbox[0] >= bbox[2]
        or bbox[1] >= bbox[3]
    ):
        raise HTTPException(
            status_code=400,
            detail="bbox must contain an increasing finite extent",
        )
    return (bbox[0], bbox[1], bbox[2], bbox[3]), width, height, "EPSG:3857"


def create_composite_map_router(
    rendering_service: CompositeMapRenderingService,
    geoserver_client: httpx2.AsyncClient,
    geoserver_internal_url: str,
    get_map_request_tracker: GetMapRequestTracker,
) -> APIRouter:
    """Create the plan-registration and composite tile delivery boundary.

    Args:
        rendering_service: Neutral authorization and plan lifecycle service.
        geoserver_client: Shared unauthenticated GeoServer WMS client.
        geoserver_internal_url: Internal GeoServer base URL.
        get_map_request_tracker: Bounded GetMap request observer.

    Returns:
        Router serving safe render plans and their GeoServer-composed PNGs.
    """
    router = APIRouter(prefix="/api/map-rendering", tags=["rendering"])
    internal_wms_url = f"{geoserver_internal_url.rstrip('/')}/eolab/wms"

    @router.post("/plans", response_model=PublishedCompositeMapPlan)
    async def create_plan(
        plan: CompositeMapPlanRequest,
    ) -> PublishedCompositeMapPlan:
        """Authorize and retain one complete visible map presentation.

        Args:
            plan: Bounded top-first published layers and appearances.

        Returns:
            Content-addressed identity and browser WMS URL.

        Raises:
            HTTPException: If any layer, source, or style is not current.
        """
        try:
            return await rendering_service.create_plan(plan)
        except PublishedLayerChangedError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except (
            PublishedLayerNotAuthorizedError,
            PublishedLayerRequestError,
            ValueError,
        ) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @router.get("/plans/{plan_id}/wms", include_in_schema=False)
    async def render_plan(plan_id: str, request: Request) -> Response:
        """Render one authorized plan as a transparent GeoServer tile.

        Args:
            plan_id: Content-addressed current-process plan identity.
            request: Incoming bounded Leaflet WMS tile request.

        Returns:
            GeoServer-composed PNG response and safe cache headers.

        Raises:
            HTTPException: If the plan, tile request, source, style, or
                rendering service is unavailable.
        """
        if _PLAN_ID_PATTERN.fullmatch(plan_id) is None:
            raise HTTPException(
                status_code=404,
                detail="Composite map plan not found",
            )
        bbox, width, height, spatial_reference = validated_composite_tile_query(
            request
        )
        try:
            plan = await rendering_service.require_current(plan_id)
        except CompositeMapPlanUnavailableError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except PublishedLayerChangedError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except (
            PublishedLayerNotAuthorizedError,
            PublishedLayerRequestError,
        ) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        get_map_document = build_get_map_document(
            plan.sld_document,
            bbox,
            width,
            height,
            spatial_reference,
        )
        return await forward_geoserver_get_map(
            request,
            geoserver_client.post(
                internal_wms_url,
                content=get_map_document,
                headers=geoserver_forward_headers(
                    request,
                    content_type="application/xml",
                ),
            ),
            get_map_request_tracker,
        )

    return router
