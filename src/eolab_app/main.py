"""Create the EOLab FastAPI application and serve its browser assets."""

from collections.abc import Awaitable, Callable
from pathlib import Path

import httpx2
import psycopg
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.staticfiles import StaticFiles

from eolab_app.settings import APPLICATION_VERSION_PATH, load_settings
from eolab_app.scanning import PgStacCatalogDatabase, ScanManager, StacApiWriter


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
    application = FastAPI(
        title=app_global_configuration.app_title,
        description=app_global_configuration.app_subtitle,
        version=app_global_configuration.app_version,
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
        """Return current GeoTIFF scan progress.

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
            async with httpx2.AsyncClient(
                transport=catalog_transport,
                timeout=10,
            ) as catalog_client:
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

    static_directory = Path(__file__).parent / "static"
    application.mount(
        "/",
        StaticFiles(directory=static_directory, html=True, check_dir=False),
        name="frontend",
    )

    return application
