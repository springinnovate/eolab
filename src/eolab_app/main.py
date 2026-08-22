"""Create the EOLab FastAPI application and serve its browser assets."""

import asyncio
import math
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path

import httpx2
import psycopg
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.staticfiles import StaticFiles

from eolab_app.catalog.pgstac import PgStacCatalogDatabase
from eolab_app.catalog.reconciliation import MissingItemReconciler
from eolab_app.catalog.scanner import ScanManager
from eolab_app.catalog.stac_api import StacApiWriter
from eolab_app.diagnostics import (
    GetMapRequestTracker,
    RenderingDiagnostics,
    RenderingDiagnosticsService,
)
from eolab_app.rendering import (
    CatalogPixelRequest,
    CatalogRasterRequest,
    CatalogRasterStatisticsRequest,
    PublishedRaster,
    PublishedRasterRegistry,
    RASTER_PIXEL_READ_CONCURRENCY,
    RasterPixel,
    RasterStatistics,
    RasterStatisticsService,
    publish_catalog_raster,
    sample_catalog_raster_pixel,
    update_catalog_raster_assessment,
)
from eolab_app.routes.scans import create_scan_router
from eolab_app.settings import APPLICATION_VERSION_PATH, load_settings


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


def _validate_raster_style_environment(environment: str) -> None:
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


def _validated_public_wms_query(
    request: Request,
) -> tuple[list[tuple[str, str]], str | None, str]:
    """Validate an untrusted request against the public WMS contract.

    Args:
        request: Incoming WMS request.

    Returns:
        Query entries accepted by EOLab's public WMS contract, the one
        requested data layer or None for GetCapabilities, and the normalized
        operation established by validation.

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
    if "env" in normalized_query:
        _validate_raster_style_environment(normalized_query["env"])
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
    return query_entries, layer_name, operation


async def _number_matched_is_estimated(
    search_request_body: bytes,
    number_matched: int,
) -> bool:
    """Report whether pgSTAC supplied its estimate for an Item Search count.

    Args:
        search_request_body: Original STAC Item Search JSON body.
        number_matched: Count returned by pgSTAC for that search.

    Returns:
        Whether the returned count came from pgSTAC's estimate.

    Raises:
        RuntimeError: If pgSTAC did not retain statistics for the search.
        UnicodeDecodeError: If the request body is not valid UTF-8.
        psycopg.Error: If the catalog database query fails.
    """
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


async def _wait_for_http_disconnect(request: Request) -> None:
    """Wait until the ASGI server reports that the browser disconnected."""
    while (message := await request.receive())["type"] != "http.disconnect":
        pass


def create_app(
    version_file_path: Path = APPLICATION_VERSION_PATH,
    catalog_transport: httpx2.AsyncBaseTransport | None = None,
    geoserver_transport: httpx2.AsyncBaseTransport | None = None,
    geoserver_diagnostics_transport: httpx2.AsyncBaseTransport | None = None,
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
        geoserver_diagnostics_transport: HTTP transport used only for bounded
            internal metrics and WMS readiness probes. The default creates a
            real network transport; tests pass a mock transport.
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
    geoserver_diagnostics_client = httpx2.AsyncClient(
        transport=geoserver_diagnostics_transport,
        timeout=3,
    )
    raster_publish_lock = asyncio.Lock()
    raster_pixel_read_semaphore = asyncio.Semaphore(
        RASTER_PIXEL_READ_CONCURRENCY
    )
    published_rasters = PublishedRasterRegistry()
    raster_statistics_service = RasterStatisticsService(published_rasters)
    get_map_request_tracker = GetMapRequestTracker(
        app_global_configuration.geoserver_wms_render_count
    )
    rendering_diagnostics = RenderingDiagnosticsService(
        geoserver_diagnostics_client,
        app_global_configuration.geoserver_metrics_internal_url,
        app_global_configuration.geoserver_internal_url,
        get_map_request_tracker,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        """Own and close all shared upstream connection pools.

        Args:
            _: FastAPI application supplied by the lifespan protocol.

        Yields:
            Control while the application serves requests.
        """
        async with AsyncExitStack() as client_stack:
            for client in (
                catalog_client,
                geoserver_wms_client,
                geoserver_rest_client,
                geoserver_diagnostics_client,
            ):
                client_stack.push_async_callback(client.aclose)
            yield

    application = FastAPI(
        title=app_global_configuration.app_title,
        description=app_global_configuration.app_subtitle,
        version=app_global_configuration.app_version,
        lifespan=lifespan,
    )
    catalog_database = PgStacCatalogDatabase()
    scan_manager = ScanManager(
        app_global_configuration.scan_mount_path,
        tuple(
            app_global_configuration.scan_mount_path / relative_path
            for relative_path in app_global_configuration.scan_paths_within_mount
        ),
        StacApiWriter(
            app_global_configuration.catalog_internal_url,
            catalog_transport,
            write_timeout_seconds=(
                app_global_configuration.scan_catalog_write_timeout_seconds
            ),
            error_detail_limit=(
                app_global_configuration.scan_catalog_error_detail_limit
            ),
        ),
        catalog_database,
        app_global_configuration.scan_worker_count,
        app_global_configuration.scan_writer_count,
        app_global_configuration.scan_batch_size,
        reconciler=MissingItemReconciler(
            app_global_configuration.scan_mount_path,
            catalog_database,
            app_global_configuration.scan_batch_size,
            page_size=app_global_configuration.scan_reconciliation_page_size,
            concurrency=(
                app_global_configuration.scan_reconciliation_concurrency
            ),
            spool_memory_bytes=(
                app_global_configuration.scan_reconciliation_spool_memory_bytes
            ),
        ),
        error_detail_limit=app_global_configuration.scan_error_detail_limit,
    )
    application.include_router(create_scan_router(scan_manager))

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

    @application.get(
        "/api/rendering/diagnostics",
        response_model=RenderingDiagnostics,
        tags=["rendering"],
    )
    async def rendering_diagnostics_summary(
        response: Response,
    ) -> RenderingDiagnostics:
        """Return a browser-safe summary of internal rendering state.

        Args:
            response: Outgoing response whose cache policy is set here.

        Returns:
            Current allowlisted metrics, or the stable unavailable variant.
        """
        response.headers["cache-control"] = "no-store"
        return await rendering_diagnostics.get()

    @application.post(
        "/api/rendering/assessments",
        response_model=dict[str, object],
        tags=["rendering"],
    )
    async def assess_raster(
        request: CatalogRasterRequest,
    ) -> dict[str, object]:
        """Assess and update one selected legacy raster Item.

        Args:
            request: Authoritative Collection and Item identity.

        Returns:
            Updated browser-safe raster visualization assessment.

        Raises:
            HTTPException: If the Item or mounted raster cannot be assessed.
        """
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
        """Publish one authoritative mounted GeoTIFF as a WMS layer.

        Args:
            request: Authoritative Collection and Item identity.

        Returns:
            Published WMS layer identity and raster bounds.

        Raises:
            HTTPException: If the catalog, source, or GeoServer publication
                contract fails.
        """
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

    @application.post(
        "/api/rendering/pixels",
        response_model=RasterPixel,
        tags=["rendering"],
    )
    async def sample_raster_pixel(
        request: CatalogPixelRequest,
    ) -> RasterPixel:
        """Read one pixel from the selected published raster.

        Args:
            request: Published layer identity and WGS84 coordinate.

        Returns:
            Band-one pixel position and value or out-of-bounds result.

        Raises:
            HTTPException: If the layer is not current or the raster read
                cannot satisfy the pixel-sampling contract.
        """
        return await sample_catalog_raster_pixel(
            request,
            published_rasters,
            raster_pixel_read_semaphore,
        )

    @application.post(
        "/api/rendering/statistics",
        response_model=RasterStatistics,
        tags=["rendering"],
    )
    async def raster_statistics(
        request: CatalogRasterStatisticsRequest,
        http_request: Request,
    ) -> RasterStatistics:
        """Summarize a whole raster or selected area through a bounded sample."""
        statistics_task = asyncio.create_task(
            raster_statistics_service.get(request)
        )
        disconnect_task = asyncio.create_task(
            _wait_for_http_disconnect(http_request)
        )
        try:
            completed_tasks, _ = await asyncio.wait(
                (statistics_task, disconnect_task),
                return_when=asyncio.FIRST_COMPLETED,
            )
            if statistics_task in completed_tasks:
                return statistics_task.result()

            raise HTTPException(
                status_code=499,
                detail="The raster statistics request was canceled",
            )
        finally:
            disconnect_task.cancel()
            statistics_task.cancel()
            await asyncio.gather(
                statistics_task,
                disconnect_task,
                return_exceptions=True,
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
        query_entries, layer_name, operation = _validated_public_wms_query(request)
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
            if operation == "getmap":
                with get_map_request_tracker.track() as tracked_request:
                    geoserver_response = await geoserver_wms_client.get(
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
