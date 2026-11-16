"""HTTP forwarding for cancellable GeoServer maps and feature inspections."""

from collections.abc import Awaitable

import httpx2
from fastapi import HTTPException, Request, Response

from eolab_app.diagnostics.tracker import GetMapRequestTracker
from eolab_app.rendering.render_queue import (
    RenderExecutionTimeoutError,
    RenderQueueUnavailableError,
)
from eolab_app.routes.http_disconnect import (
    HttpClientDisconnectedError,
    run_until_http_disconnect,
)


def geoserver_forward_headers(
    request: Request,
    *,
    content_type: str | None = None,
) -> dict[str, str]:
    """Build the bounded forwarding headers shared by GeoServer requests.

    Args:
        request: Incoming browser request.
        content_type: Optional internal request media type.

    Returns:
        Safe accept and forwarded-origin headers, plus optional content type.
    """
    headers = {
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
        headers["x-forwarded-port"] = forwarded_port
    if content_type is not None:
        headers["content-type"] = content_type
    return headers


async def forward_geoserver_get_map(
    request: Request,
    operation: Awaitable[httpx2.Response],
    tracker: GetMapRequestTracker,
) -> Response:
    """Forward one GetMap operation with cancellation and diagnostics.

    Args:
        request: Incoming browser request owning the upstream work.
        operation: Asynchronous tile lookup or queued GeoServer request.
        tracker: Bounded GetMap request observer.

    Returns:
        GeoServer response with only safe representation headers.

    Raises:
        HTTPException: If the client disconnects, admission fails, execution
            expires, or GeoServer is unavailable.
    """
    try:
        with tracker.track() as tracked_request:
            try:
                geoserver_response = await run_until_http_disconnect(
                    request,
                    operation,
                )
            except HttpClientDisconnectedError as error:
                tracked_request.canceled = True
                raise HTTPException(
                    status_code=499,
                    detail="The map request was canceled",
                ) from error
            response_media_type = geoserver_response.headers.get(
                "content-type",
                "",
            ).partition(";")[0].lower()
            tracked_request.succeeded = (
                geoserver_response.is_success
                and response_media_type == "image/png"
            )
    except RenderQueueUnavailableError as error:
        raise HTTPException(
            status_code=503, detail=str(error), headers={"Retry-After": "1"},
        ) from error
    except RenderExecutionTimeoutError as error:
        raise HTTPException(status_code=504, detail=str(error)) from error
    except httpx2.RequestError as error:
        raise HTTPException(
            status_code=502,
            detail="The rendering service is unavailable",
        ) from error
    return safe_geoserver_response(geoserver_response)


async def forward_geoserver_feature_info(
    request: Request,
    operation: Awaitable[httpx2.Response],
) -> httpx2.Response:
    """Await one feature inspection without counting it as a map render.

    The WMS route validates the returned feature payload. Queued work is canceled
    when its client disconnects; the queue retains started HTTP work and its
    source leases through the upstream response or existing execution deadline.

    Args:
        request: Browser request that owns the inspection.
        operation: Already-authorized inspection submitted to the shared queue.

    Returns:
        Upstream response for the owning route's feature-payload validation.

    Raises:
        HTTPException: If the client disconnects, admission fails, or execution
            exceeds its deadline.
        httpx2.RequestError: If the upstream HTTP transport fails.
    """
    try:
        return await run_until_http_disconnect(request, operation)
    except HttpClientDisconnectedError as error:
        raise HTTPException(
            499,
            "The feature inspection request was canceled",
            headers={"Cache-Control": "private, no-store"},
        ) from error
    except RenderQueueUnavailableError as error:
        raise HTTPException(
            503,
            "Feature inspection is busy. Try again shortly.",
            headers={"Retry-After": "1", "Cache-Control": "private, no-store"},
        ) from error
    except RenderExecutionTimeoutError as error:
        raise HTTPException(
            504,
            "Feature inspection exceeded its time limit.",
            headers={"Cache-Control": "private, no-store"},
        ) from error


def safe_geoserver_response(geoserver_response: httpx2.Response) -> Response:
    """Expose one GeoServer response without forwarding unsafe headers.

    Args:
        geoserver_response: Completed internal GeoServer response.

    Returns:
        Body, status, and safe representation headers.
    """
    response_headers = {
        header_name: header_value
        for header_name in (
            "cache-control",
            "content-disposition",
            "content-type",
            "etag",
            "geowebcache-cache-result",
            "geowebcache-crs",
            "geowebcache-gridset",
            "geowebcache-miss-reason",
            "geowebcache-tile-bounds",
            "geowebcache-tile-index",
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
