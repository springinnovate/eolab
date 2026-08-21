"""Create the EOLab FastAPI application and serve its browser assets."""

import asyncio

from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path

import httpx2
import psycopg
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.staticfiles import StaticFiles

from eolab_app.rendering import (
    CatalogRasterRequest,
    PublishedRaster,
    PublishedRasterRegistry,
    publish_catalog_raster,
    update_catalog_raster_assessment,
)
from eolab_app.settings import APPLICATION_VERSION_PATH, load_settings
from eolab_app.scanning import PgStacCatalogDatabase, ScanManager, StacApiWriter


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


def _validated_public_wms_query(
    request: Request,
) -> tuple[list[tuple[str, str]], str | None]:
    """Validate an untrusted request against the public WMS contract.

    Args:
        request: Incoming WMS request.

    Returns:
        Query entries accepted by EOLab's public WMS contract and the one
        requested data layer, or None for GetCapabilities.

    Raises:
        HTTPException: If the request is not an allowed WMS operation or uses
            an unsupported or repeated parameter.
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
    if normalized_query.get(style_parameter, "") not in {
        "",
        "dynamic-raster",
        "eolab:dynamic-raster",
    }:
        raise HTTPException(
            status_code=400,
            detail="WMS style must be dynamic-raster",
        )
    if operation != "getcapabilities" and (
        not layer_name or "," in layer_name
    ):
        raise HTTPException(
            status_code=400,
            detail="Exactly one WMS layer must be requested",
        )
    return query_entries, layer_name


async def _number_matched_is_estimated(
    search_request_body: bytes,
    number_matched: int,
) -> bool:
    """Report whether pgSTAC supplied its estimate for an Item Search count."""
    async with await psycopg.AsyncConnection.connect(
        options="-c search_path=pgstac,public"
    ) as connection:
        cursor = await connection.execute(
            """
            SELECT total_count IS NULL
            FROM pgstac.search_wheres
            WHERE md5(_where) = md5(
                pgstac.stac_search_to_where(%s::jsonb)
            )
            AND COALESCE(total_count, estimated_count) = %s
            """,
            (search_request_body.decode(), number_matched),
        )
        result = await cursor.fetchone()
    if result is None:
        raise RuntimeError("pgSTAC did not record Item Search count statistics")
    return result[0]


def create_app(
    version_file_path: Path = APPLICATION_VERSION_PATH,
    catalog_transport: httpx2.AsyncBaseTransport | None = None,
    geoserver_transport: httpx2.AsyncBaseTransport | None = None,
    number_matched_estimate_lookup: Callable[[bytes, int], Awaitable[bool]] = (
        _number_matched_is_estimated
    ),
) -> FastAPI:
    """Create an application from the deployment environment.

    Args:
        version_file_path: File containing the Git-derived application version.
            The default allows Uvicorn to invoke this factory without arguments;
            tests pass a temporary version file.
        catalog_transport: HTTP transport used to reach the internal STAC API.
            The default creates a real network transport; tests pass a mock
            transport.
        geoserver_transport: HTTP transport used to reach internal GeoServer.
            The default creates a real network transport; tests pass a mock
            transport.
        number_matched_estimate_lookup: Determines whether pgSTAC estimated an
            Item Search count. Tests pass a database-free implementation.

    Returns:
        A FastAPI application configured from the validated deployment
        environment, with its health and public-configuration routes
        registered and its static frontend mounted.

    Raises:
        FileNotFoundError: If the baked version file does not exist.
        KeyError: If a required environment variable is missing.
        ValueError: If an environment value violates the settings contract.
    """
    app_global_configuration = load_settings(version_file_path)
    catalog_client = httpx2.AsyncClient(
        transport=catalog_transport,
        timeout=10,
    )
    geoserver_wms_client = httpx2.AsyncClient(
        transport=geoserver_transport,
        timeout=30,
    )
    geoserver_rest_client = httpx2.AsyncClient(
        transport=geoserver_transport,
        timeout=30,
        auth=httpx2.BasicAuth(
            app_global_configuration.geoserver_admin_user,
            app_global_configuration.geoserver_admin_password,
        ),
    )
    raster_publish_lock = asyncio.Lock()
    published_rasters = PublishedRasterRegistry()

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        """Close shared upstream connection pools at application shutdown."""
        yield
        await catalog_client.aclose()
        await geoserver_wms_client.aclose()
        await geoserver_rest_client.aclose()

    application = FastAPI(
        title=app_global_configuration.app_title,
        description=app_global_configuration.app_subtitle,
        version=app_global_configuration.app_version,
        lifespan=lifespan,
    )
    scan_manager = ScanManager(
        app_global_configuration.scan_mount_path,
        tuple(
            app_global_configuration.scan_mount_path / relative_path
            for relative_path in app_global_configuration.scan_paths_within_mount
        ),
        StacApiWriter(
            app_global_configuration.catalog_internal_url,
            catalog_transport,
        ),
        PgStacCatalogDatabase(),
        app_global_configuration.scan_worker_count,
        app_global_configuration.scan_writer_count,
        app_global_configuration.scan_batch_size,
    )

    @application.get("/healthz", tags=["system"])
    def healthz() -> dict[str, str]:
        """Report application liveness and the configured release version.

        Returns:
            The current liveness status.
        """
        return {
            "status": "ok",
            "service": "eolab",
            "version": app_global_configuration.app_version,
        }

    @application.get("/api/config", tags=["system"])
    def public_configuration() -> dict[str, object]:
        """Return the browser-safe application configuration.

        Returns:
            The public application configuration.
        """
        return app_global_configuration.as_public_dict()

    @application.get("/api/scans/current", tags=["catalog"])
    async def current_scan() -> dict[str, object]:
        """Return current mounted-dataset scan progress.

        Returns:
            A snapshot of the active or most recently completed scan.
        """
        return scan_manager.status()

    @application.post("/api/scans", status_code=202, tags=["catalog"])
    async def start_scan() -> dict[str, object]:
        """Start a recursive scan of the configured read-only source.

        Returns:
            Initial progress for the new scan.

        Raises:
            HTTPException: If another scan is still running.
        """
        try:
            return await scan_manager.start()
        except RuntimeError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @application.post(
        "/api/rendering/assessments",
        response_model=dict[str, object],
        tags=["rendering"],
    )
    async def assess_raster(
        request: CatalogRasterRequest,
    ) -> dict[str, object]:
        """Assess and update one selected legacy raster Item."""
        return await update_catalog_raster_assessment(
            request,
            app_global_configuration.scan_mount_path,
            catalog_client,
            app_global_configuration.catalog_internal_url,
        )

    @application.post(
        "/api/rendering/layers",
        response_model=PublishedRaster,
        tags=["rendering"],
    )
    async def publish_raster(request: CatalogRasterRequest) -> PublishedRaster:
        """Publish one authoritative mounted GeoTIFF as a WMS layer."""
        async with raster_publish_lock:
            return await publish_catalog_raster(
                request,
                app_global_configuration.scan_mount_path,
                catalog_client,
                geoserver_rest_client,
                app_global_configuration.catalog_internal_url,
                app_global_configuration.geoserver_internal_url,
                published_rasters,
            )

    @application.api_route(
        "/stac",
        methods=["GET", "POST"],
        include_in_schema=False,
    )
    @application.api_route(
        "/stac/{catalog_path:path}",
        methods=["GET", "POST"],
        include_in_schema=False,
    )
    async def stac_catalog(
        request: Request,
        catalog_path: str = "",
    ) -> Response:
        """Expose the internal read-only STAC API at the public ``/stac`` path.

        Args:
            request: Incoming catalog request.
            catalog_path: Path below the STAC landing page.

        Returns:
            The unmodified STAC response body, status, and content type.

        Raises:
            HTTPException: If a write request is attempted or the catalog
                service cannot be reached.
        """
        if request.method == "POST" and catalog_path.strip("/") != "search":
            raise HTTPException(
                status_code=405,
                detail="Only STAC Item Search accepts POST requests",
            )

        internal_catalog_url = app_global_configuration.catalog_internal_url.rstrip("/")
        upstream_url = f"{internal_catalog_url}/{catalog_path}"
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
                upstream_url,
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

    # Claim non-GET methods before the catch-all static mount so they receive
    # the WMS contract's 405 response instead of being treated as asset paths.
    @application.api_route(
        "/geoserver/eolab/wms",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        include_in_schema=False,
    )
    async def wms(request: Request) -> Response:
        """Expose supported read-only WMS operations for the EOLab workspace.

        Args:
            request: Incoming WMS request.

        Returns:
            GeoServer's response body, status, and safe response headers.

        Raises:
            HTTPException: If the query is outside the public WMS contract or
                GeoServer cannot be reached.
        """
        if request.method != "GET":
            raise HTTPException(
                status_code=405,
                detail="The public WMS endpoint accepts only GET requests",
            )
        query_entries, layer_name = _validated_public_wms_query(request)
        if layer_name is not None:
            await asyncio.to_thread(
                published_rasters.require_current,
                layer_name,
            )
        internal_geoserver_url = (
            app_global_configuration.geoserver_internal_url.rstrip("/")
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
            geoserver_response = await geoserver_wms_client.get(
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

    static_directory = Path(__file__).parent / "static"
    application.mount(
        "/",
        StaticFiles(directory=static_directory, html=True, check_dir=False),
        name="frontend",
    )

    return application
