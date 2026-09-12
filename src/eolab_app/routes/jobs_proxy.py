"""Bounded same-origin forwarding to the independent Job service."""

import re

import httpx2
from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

MAX_REQUEST_BYTES = 65536
MAX_RESPONSE_BYTES = 1048576


def proxy_error(status: int, code: str, message: str) -> JSONResponse:
    """Return a proxy error in the Job service's public envelope.

    Args:
        status: HTTP failure status.
        code: Stable proxy error identity.
        message: Public explanation without private upstream addresses.

    Returns:
        Non-cacheable JSON error.
    """
    return JSONResponse(
        {"error": {"code": code, "message": message}},
        status_code=status,
        headers={"Cache-Control": "no-store"},
    )


def create_jobs_proxy_router(
    client: httpx2.AsyncClient, internal_url: str = "http://jobs:8080"
) -> APIRouter:
    """Expose only the Job service prefix through an owned HTTP connection pool.

    This proxy buffers bounded JSON/docs responses. Real SSE and artifact
    streaming require a later implementation; their endpoints currently return
    JSON 501. Bearer authorization is relayed only to the fixed Jobs endpoint;
    cookies and arbitrary identity/response headers are not relayed.

    Args:
        client: Composition-owned Job service HTTP client.
        internal_url: Trusted deployment/test endpoint, never request input.

    Returns:
        Prefix-isolated forwarding routes; service absence returns 502.
    """
    router = APIRouter()

    @router.api_route(
        "/api/jobs", methods=["GET", "POST", "PATCH", "DELETE"], include_in_schema=False
    )
    @router.api_route(
        "/api/jobs/{path:path}",
        methods=["GET", "POST", "PATCH", "DELETE"],
        include_in_schema=False,
    )
    async def forward(request: Request, path: str = "") -> Response:
        """Forward a bounded API request without allowing upstream path escape.

        Args:
            request: Public request and bounded body stream.
            path: Decoded suffix under the fixed API prefix.

        Returns:
            Upstream body/status and safe headers, or a structured proxy failure.
        """
        if path != "openapi.json" and not re.fullmatch(
            r"(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]*", path
        ):
            return proxy_error(404, "not_found", "Unknown Job service endpoint.")
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > MAX_REQUEST_BYTES:
                return proxy_error(
                    413, "request_too_large", "Request exceeds 65536 bytes."
                )
            body.extend(chunk)
        headers = {
            name: request.headers[name]
            for name in (
                "accept",
                "content-type",
                "idempotency-key",
                "last-event-id",
                "authorization",
            )
            if name in request.headers
        }
        headers["accept-encoding"] = "identity"
        endpoint = f"{internal_url.rstrip('/')}/api/jobs" + (f"/{path}" if path else "")
        try:
            async with client.stream(
                request.method,
                endpoint,
                params=request.query_params,
                content=bytes(body),
                headers=headers,
                follow_redirects=False,
            ) as upstream:
                if upstream.is_redirect:
                    return proxy_error(
                        502, "jobs_unavailable", "Unexpected Job service redirect."
                    )
                content = bytearray()
                async for chunk in upstream.aiter_bytes():
                    if len(content) + len(chunk) > MAX_RESPONSE_BYTES:
                        return proxy_error(
                            502,
                            "response_too_large",
                            "Job service response exceeds the preview limit.",
                        )
                    content.extend(chunk)
                response_headers = {
                    name: upstream.headers[name]
                    for name in (
                        "content-type",
                        "allow",
                        "retry-after",
                        "www-authenticate",
                        "location",
                    )
                    if name in upstream.headers
                }
                response_headers["cache-control"] = "no-store"
                return Response(
                    bytes(content),
                    status_code=upstream.status_code,
                    headers=response_headers,
                )
        except httpx2.RequestError:
            return proxy_error(
                502,
                "jobs_unavailable",
                "Job service is unavailable; try again shortly.",
            )

    return router
