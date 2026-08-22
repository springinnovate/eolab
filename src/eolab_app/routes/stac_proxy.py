"""Restricted public HTTP proxy for the internal read-only STAC API."""

from collections.abc import Awaitable, Callable

import httpx2
from fastapi import APIRouter, HTTPException, Request, Response


NumberMatchedEstimateLookup = Callable[[bytes, int], Awaitable[bool]]


def create_stac_proxy_router(
    catalog_client: httpx2.AsyncClient,
    catalog_internal_url: str,
    number_matched_estimate_lookup: NumberMatchedEstimateLookup,
) -> APIRouter:
    """Create the restricted public STAC proxy.

    Args:
        catalog_client: Shared client for the internal STAC API.
        catalog_internal_url: Internal STAC API base URL.
        number_matched_estimate_lookup: Classifies successful Item Search
            counts as exact or estimated.

    Returns:
        Router that exposes reads and STAC Item Search without catalog writes.
    """
    router = APIRouter()
    internal_catalog_url = catalog_internal_url.rstrip("/")

    @router.api_route(
        "/stac",
        methods=["GET", "POST"],
        include_in_schema=False,
    )
    @router.api_route(
        "/stac/{catalog_path:path}",
        methods=["GET", "POST"],
        include_in_schema=False,
    )
    async def stac_catalog(
        request: Request,
        catalog_path: str = "",
    ) -> Response:
        """Forward one allowed public STAC request.

        Args:
            request: Incoming catalog request.
            catalog_path: Path below the STAC landing page.

        Returns:
            Unmodified STAC response body, status, and content type.

        Raises:
            HTTPException: If a write is attempted or the catalog is
                unavailable.
        """
        if request.method == "POST" and catalog_path.strip("/") != "search":
            raise HTTPException(
                status_code=405,
                detail="Only STAC Item Search accepts POST requests",
            )

        forwarded_headers = {
            "accept": request.headers.get("accept", "application/json"),
            "x-forwarded-host": request.headers.get(
                "x-forwarded-host",
                request.headers["host"],
            ),
            "x-forwarded-proto": request.headers.get(
                "x-forwarded-proto",
                request.url.scheme,
            ),
        }
        if content_type := request.headers.get("content-type"):
            forwarded_headers["content-type"] = content_type
        if forwarded_port := request.headers.get("x-forwarded-port"):
            forwarded_headers["x-forwarded-port"] = forwarded_port

        request_body = await request.body()
        try:
            catalog_response = await catalog_client.request(
                request.method,
                f"{internal_catalog_url}/{catalog_path}",
                params=request.query_params,
                content=request_body,
                headers=forwarded_headers,
            )
        except httpx2.RequestError as error:
            raise HTTPException(
                status_code=502,
                detail="The STAC catalog service is unavailable",
            ) from error

        response_headers = {}
        if response_content_type := catalog_response.headers.get("content-type"):
            response_headers["content-type"] = response_content_type
        if (
            catalog_response.is_success
            and request.method == "POST"
            and catalog_path.strip("/") == "search"
        ):
            number_matched = catalog_response.json()["numberMatched"]
            response_headers["x-eolab-number-matched-estimated"] = str(
                await number_matched_estimate_lookup(
                    request_body,
                    number_matched,
                )
            ).lower()
        return Response(
            content=catalog_response.content,
            status_code=catalog_response.status_code,
            headers=response_headers,
        )

    return router
