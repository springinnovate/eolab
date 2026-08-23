"""Restricted public WMS validation, authorization, and forwarding."""

import asyncio
import math
import re

import httpx2
from fastapi import APIRouter, HTTPException, Request, Response

from eolab_app.diagnostics.tracker import GetMapRequestTracker
from eolab_app.raster.errors import RasterFeatureError, RasterRequestError
from eolab_app.raster.sources import PublishedRasterRegistry
from eolab_app.routes.rasters import raster_http_exception
from eolab_app.vector.sources import PublishedVectorRegistry


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
RASTER_STYLE_ENVIRONMENT_KEYS = frozenset(
    {"min", "med", "max", "cmin", "cmed", "cmax"}
)
RASTER_STYLE_COLOR_PATTERN = re.compile(r"#[0-9a-fA-F]{6}")
RASTER_STYLE_ENVIRONMENT_ERROR = (
    "env must define ordered finite min, med, and max values plus cmin, "
    "cmed, and cmax six-digit hex colors"
)
PUBLIC_WMS_STYLE_NAMES = frozenset({
    "dynamic-raster",
    "vector-point",
    "vector-line",
    "vector-polygon",
})


def validate_raster_style_environment(environment: str) -> None:
    """Validate the six substitutions consumed by the dynamic raster SLD.

    Args:
        environment: Untrusted WMS ``env`` query value.

    Raises:
        HTTPException: If the value is not exactly the six finite, ordered
            threshold and color assignments used by EOLab's raster style.
    """
    invalid_environment = HTTPException(
        status_code=400,
        detail=RASTER_STYLE_ENVIRONMENT_ERROR,
    )
    fields = environment.split(";")
    if len(environment) > 256 or len(fields) != 6:
        raise invalid_environment

    assignments = {}
    for field in fields:
        name, separator, value = field.partition(":")
        if separator == "" or name in assignments:
            raise invalid_environment
        assignments[name] = value
    if assignments.keys() != RASTER_STYLE_ENVIRONMENT_KEYS:
        raise invalid_environment

    try:
        thresholds = tuple(
            float(assignments[name]) for name in ("min", "med", "max")
        )
    except ValueError as error:
        raise invalid_environment from error
    if not (
        all(math.isfinite(value) for value in thresholds)
        and thresholds[0] < thresholds[1] < thresholds[2]
        and all(
            RASTER_STYLE_COLOR_PATTERN.fullmatch(assignments[name])
            for name in ("cmin", "cmed", "cmax")
        )
    ):
        raise invalid_environment


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
        if normalized_query.get("info_format", "").lower() not in {
            "application/json",
            "text/plain",
        }:
            raise HTTPException(
                status_code=400,
                detail=(
                    "WMS feature information format must be application/json "
                    "or text/plain"
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
    style_parameter = "style" if operation == "getlegendgraphic" else "styles"
    requested_style = normalized_query.get(style_parameter, "")
    unqualified_style = requested_style.removeprefix("eolab:")
    if requested_style and unqualified_style not in PUBLIC_WMS_STYLE_NAMES:
        raise HTTPException(
            status_code=400,
            detail="WMS style must be dynamic-raster",
        )
    if "env" in normalized_query:
        validate_raster_style_environment(normalized_query["env"])
        if unqualified_style in {
            "vector-point",
            "vector-line",
            "vector-polygon",
        }:
            raise HTTPException(
                status_code=400,
                detail="env is available only for the dynamic raster style",
            )
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
    published_rasters: PublishedRasterRegistry,
    published_vectors: PublishedVectorRegistry,
    get_map_request_tracker: GetMapRequestTracker,
) -> APIRouter:
    """Create the restricted public WMS proxy.

    Args:
        geoserver_client: Shared unauthenticated GeoServer WMS client.
        geoserver_internal_url: Internal GeoServer base URL.
        published_rasters: Current-process layer authorization registry.
        published_vectors: Current-process exact-vector authorization registry.
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
            try:
                try:
                    authorization = await asyncio.to_thread(
                        published_rasters.require_current,
                        layer_name,
                    )
                except RasterRequestError:
                    authorization = await asyncio.to_thread(
                        published_vectors.require_current,
                        layer_name,
                    )
            except RasterFeatureError as error:
                raise raster_http_exception(error) from error
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
                    detail="WMS style does not match the authorized layer",
                )

        forwarded_headers = {
            "accept": request.headers.get("accept", "*/*"),
            "x-forwarded-host": request.headers.get(
                "x-forwarded-host",
                request.headers["host"],
            ),
            "x-forwarded-proto": request.headers.get(
                "x-forwarded-proto",
                request.url.scheme,
            ),
        }
        if forwarded_port := request.headers.get("x-forwarded-port"):
            forwarded_headers["x-forwarded-port"] = forwarded_port
        try:
            if operation == "getmap":
                with get_map_request_tracker.track() as tracked_request:
                    geoserver_response = await geoserver_client.get(
                        f"{internal_geoserver_url}/eolab/wms",
                        params=query_entries,
                        headers=forwarded_headers,
                    )
                    response_media_type = geoserver_response.headers.get(
                        "content-type",
                        "",
                    ).partition(";")[0].lower()
                    tracked_request.succeeded = (
                        geoserver_response.is_success
                        and response_media_type == "image/png"
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

        response_headers = {
            header_name: header_value
            for header_name in (
                "cache-control",
                "content-disposition",
                "content-type",
                "etag",
                "last-modified",
            )
            if (header_value := geoserver_response.headers.get(header_name))
        }
        response_headers["x-content-type-options"] = "nosniff"
        return Response(
            content=geoserver_response.content,
            status_code=geoserver_response.status_code,
            headers=response_headers,
        )

    return router
