"""Restricted public WMS validation, authorization, and forwarding."""

import asyncio

import httpx2
from fastapi import APIRouter, HTTPException, Request, Response

from eolab_app.diagnostics.tracker import GetMapRequestTracker
from eolab_app.rendering.errors import (
    PublishedLayerChangedError,
    PublishedLayerNotAuthorizedError,
    PublishedLayerRequestError,
)
from eolab_app.rendering.ports import PublishedLayerRegistry
from eolab_app.routes.geoserver_map import (
    forward_geoserver_get_map,
    geoserver_forward_headers,
    safe_geoserver_response,
)


MAX_FEATURE_INFO_FEATURES = 10
MAX_FEATURE_INFO_RESPONSE_BYTES = 512 * 1024
MAX_FEATURE_INFO_BUFFER_PIXELS = 20


PUBLIC_WMS_COMMON_QUERY_PARAMETERS = frozenset(
    {"request", "service", "version"}
)
PUBLIC_WMS_MAP_QUERY_PARAMETERS = PUBLIC_WMS_COMMON_QUERY_PARAMETERS | {
    "bbox",
    "bgcolor",
    "crs",
    "elevation",
    "env",
    "exceptions",
    "format",
    "height",
    "layers",
    "srs",
    "styles",
    "time",
    "transparent",
    "width",
}
PUBLIC_WMS_QUERY_PARAMETERS = {
    "getcapabilities": PUBLIC_WMS_COMMON_QUERY_PARAMETERS
    | {"acceptformats", "acceptversions", "sections", "updatesequence"},
    "getmap": PUBLIC_WMS_MAP_QUERY_PARAMETERS | {"tiled", "tilesorigin"},
    "getfeatureinfo": PUBLIC_WMS_MAP_QUERY_PARAMETERS
    | {
        "buffer",
        "feature_count",
        "i",
        "info_format",
        "j",
        "propertyname",
        "query_layers",
        "x",
        "y",
    },
    "getlegendgraphic": PUBLIC_WMS_COMMON_QUERY_PARAMETERS
    | {
        "bgcolor",
        "env",
        "format",
        "height",
        "layer",
        "legend_options",
        "rule",
        "scale",
        "style",
        "transparent",
        "width",
    },
}


def validated_public_wms_query(
    request: Request,
) -> tuple[list[tuple[str, str]], str | None, str]:
    """Validate an untrusted request against the public WMS contract.

    Args:
        request: Incoming WMS request.

    Returns:
        Accepted query entries, the one requested data layer or ``None`` for
        GetCapabilities, and the normalized operation.

    Raises:
        HTTPException: If the request is not an allowed operation or uses an
            unsupported or repeated parameter.
    """
    query_entries = list(request.query_params.multi_items())
    normalized_query = {key.lower(): value for key, value in query_entries}
    if len(normalized_query) != len(query_entries):
        raise HTTPException(status_code=400, detail="WMS parameters must not repeat")
    if normalized_query.get("service", "").lower() != "wms":
        raise HTTPException(status_code=400, detail="service must be WMS")

    operation = normalized_query.get("request", "").lower()
    allowed_parameters = PUBLIC_WMS_QUERY_PARAMETERS.get(operation)
    if allowed_parameters is None:
        raise HTTPException(status_code=400, detail="Unsupported WMS operation")
    unsupported_parameters = normalized_query.keys() - allowed_parameters
    if unsupported_parameters:
        raise HTTPException(
            status_code=400,
            detail=(
                "Unsupported WMS parameter: "
                f"{sorted(unsupported_parameters)[0]}"
            ),
        )

    for dimension_name in ("width", "height"):
        if dimension_name not in normalized_query:
            continue
        try:
            dimension = int(normalized_query[dimension_name])
        except ValueError as error:
            raise HTTPException(
                status_code=400,
                detail=f"{dimension_name} must be an integer",
            ) from error
        if not 1 <= dimension <= 2048:
            raise HTTPException(
                status_code=400,
                detail=f"{dimension_name} must be between 1 and 2048",
            )
    if operation in {"getmap", "getlegendgraphic"}:
        if normalized_query.get("format", "").lower() != "image/png":
            raise HTTPException(
                status_code=400,
                detail="WMS map and legend format must be image/png",
            )
    elif operation == "getfeatureinfo":
        if normalized_query.get("format", "image/png").lower() != "image/png":
            raise HTTPException(
                status_code=400,
                detail="WMS map format must be image/png",
            )
        if normalized_query.get("info_format", "").lower() != "application/json":
            raise HTTPException(
                status_code=400,
                detail="WMS feature information format must be application/json",
            )
        try:
            feature_count = int(normalized_query.get("feature_count", "1"))
        except ValueError as error:
            raise HTTPException(
                status_code=400,
                detail="feature_count must be an integer",
            ) from error
        if not 1 <= feature_count <= MAX_FEATURE_INFO_FEATURES:
            raise HTTPException(
                status_code=400,
                detail=(
                    "feature_count must be between 1 and "
                    f"{MAX_FEATURE_INFO_FEATURES}"
                ),
            )
        try:
            buffer_pixels = int(normalized_query.get("buffer", "0"))
        except ValueError as error:
            raise HTTPException(
                status_code=400,
                detail="buffer must be an integer",
            ) from error
        if not 0 <= buffer_pixels <= MAX_FEATURE_INFO_BUFFER_PIXELS:
            raise HTTPException(
                status_code=400,
                detail=(
                    "buffer must be between 0 and "
                    f"{MAX_FEATURE_INFO_BUFFER_PIXELS}"
                ),
            )
    layer_name = None
    if operation == "getmap":
        layer_name = normalized_query.get("layers")
    elif operation == "getfeatureinfo":
        layer_name = normalized_query.get("layers")
        if normalized_query.get("query_layers") != layer_name:
            raise HTTPException(
                status_code=400,
                detail="query_layers must match layers",
            )
    elif operation == "getlegendgraphic":
        layer_name = normalized_query.get("layer")
    if operation != "getcapabilities" and (
        not layer_name or "," in layer_name
    ):
        raise HTTPException(
            status_code=400,
            detail="Exactly one WMS layer must be requested",
        )
    return query_entries, layer_name, operation


def create_wms_proxy_router(
    geoserver_client: httpx2.AsyncClient,
    geoserver_internal_url: str,
    published_layers: tuple[PublishedLayerRegistry, ...],
    get_map_request_tracker: GetMapRequestTracker,
) -> APIRouter:
    """Create the restricted public WMS proxy.

    Args:
        geoserver_client: Shared unauthenticated GeoServer WMS client.
        geoserver_internal_url: Internal GeoServer base URL.
        published_layers: Feature-owned current-process layer registries.
        get_map_request_tracker: Bounded GetMap request observer.

    Returns:
        Router exposing only EOLab's validated WMS contract.
    """
    router = APIRouter()
    internal_geoserver_url = geoserver_internal_url.rstrip("/")

    # Claim non-GET methods before the catch-all static mount so they receive
    # the WMS contract's 405 response instead of being treated as asset paths.
    @router.api_route(
        "/geoserver/eolab/wms",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        include_in_schema=False,
    )
    async def wms(request: Request) -> Response:
        """Forward one validated and authorized WMS operation.

        Args:
            request: Incoming WMS request.

        Returns:
            GeoServer response body, status, and safe headers.

        Raises:
            HTTPException: If the request violates the public contract, its
                layer is not current, or GeoServer is unavailable.
        """
        if request.method != "GET":
            raise HTTPException(
                status_code=405,
                detail="The public WMS endpoint accepts only GET requests",
            )
        query_entries, layer_name, operation = validated_public_wms_query(request)
        if layer_name is not None:
            authorization = None
            for published_layer_registry in published_layers:
                try:
                    authorization = await asyncio.to_thread(
                        published_layer_registry.require_current,
                        layer_name,
                    )
                    break
                except PublishedLayerNotAuthorizedError:
                    continue
                except PublishedLayerChangedError as error:
                    raise HTTPException(status_code=409, detail=str(error)) from error
            if authorization is None:
                raise HTTPException(
                    status_code=400,
                    detail="The WMS layer has not been approved for visualization",
                )
            normalized_query = {
                key.lower(): value for key, value in query_entries
            }
            style_parameter = (
                "style" if operation == "getlegendgraphic" else "styles"
            )
            requested_style = normalized_query.get(
                style_parameter,
                "",
            ).removeprefix("eolab:")
            if requested_style not in {"", authorization.style_name}:
                raise HTTPException(
                    status_code=400,
                    detail=f"WMS style must be {authorization.style_name}",
                )
            try:
                authorization.validate_parameters(operation, normalized_query)
            except PublishedLayerRequestError as error:
                raise HTTPException(status_code=400, detail=str(error)) from error

        forwarded_headers = geoserver_forward_headers(request)
        try:
            if operation == "getmap":
                return await forward_geoserver_get_map(
                    request,
                    geoserver_client.get(
                        f"{internal_geoserver_url}/eolab/wms",
                        params=query_entries,
                        headers=forwarded_headers,
                    ),
                    get_map_request_tracker,
                )
            else:
                geoserver_response = await geoserver_client.get(
                    f"{internal_geoserver_url}/eolab/wms",
                    params=query_entries,
                    headers=forwarded_headers,
                )
        except httpx2.RequestError as error:
            raise HTTPException(
                status_code=502,
                detail="The rendering service is unavailable",
            ) from error

        if operation == "getfeatureinfo" and geoserver_response.is_success:
            response_media_type = geoserver_response.headers.get(
                "content-type",
                "",
            ).partition(";")[0].lower()
            if response_media_type != "application/json":
                raise HTTPException(
                    status_code=502,
                    detail="The rendering service returned invalid feature information",
                )
            if len(geoserver_response.content) > MAX_FEATURE_INFO_RESPONSE_BYTES:
                raise HTTPException(
                    status_code=502,
                    detail="The rendering service returned too much feature information",
                )

        return safe_geoserver_response(geoserver_response)

    return router
