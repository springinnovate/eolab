"""Compose the EOLab application, shared clients, and feature routers."""

from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from datetime import timedelta
from pathlib import Path

import httpx2
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from eolab_app.catalog.pgstac import PgStacCatalogDatabase
from eolab_app.catalog.reconciliation import MissingItemReconciler
from eolab_app.catalog.scanner import ScanManager
from eolab_app.catalog.search_counts import number_matched_is_estimated
from eolab_app.catalog.stac_api import StacApiWriter
from eolab_app.diagnostics.service import RenderingDiagnosticsService
from eolab_app.diagnostics.tracker import GetMapRequestTracker
from eolab_app.raster.assessment import (
    RasterAssessmentFinalizer,
    RasterAssessmentService,
)
from eolab_app.raster.catalog import StacRasterCatalog
from eolab_app.raster.geoserver import (
    GeoServerRasterPublisher,
    GeoServerRasterReaderAssessor,
)
from eolab_app.raster.detail_preview_service import RasterDetailPreviewService
from eolab_app.raster.pixel_service import RasterPixelService
from eolab_app.raster.publication import RasterPublicationService
from eolab_app.raster.sources import (
    MountedRasterResolver,
    PublishedRasterRegistry,
)
from eolab_app.raster.statistics_service import RasterStatisticsService
from eolab_app.routes.catalog import create_catalog_router
from eolab_app.routes.diagnostics import create_diagnostics_router
from eolab_app.routes.rasters import create_raster_feature
from eolab_app.routes.scans import create_scan_router
from eolab_app.routes.stac_proxy import (
    NumberMatchedEstimateLookup,
    create_stac_proxy_router,
)
from eolab_app.routes.system import create_system_router
from eolab_app.routes.temporary_aois import create_temporary_aoi_router
from eolab_app.routes.wms_proxy import create_wms_proxy_router
from eolab_app.settings import APPLICATION_VERSION_PATH, load_settings
from eolab_app.temporary_aoi.service import TemporaryAoiService


def create_app(
    version_file_path: Path = APPLICATION_VERSION_PATH,
    catalog_transport: httpx2.AsyncBaseTransport | None = None,
    geoserver_transport: httpx2.AsyncBaseTransport | None = None,
    geoserver_diagnostics_transport: httpx2.AsyncBaseTransport | None = None,
    number_matched_estimate_lookup: NumberMatchedEstimateLookup = (
        number_matched_is_estimated
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
    raster_catalog = StacRasterCatalog(
        catalog_client,
        app_global_configuration.catalog_internal_url,
    )
    raster_source_resolver = MountedRasterResolver(
        app_global_configuration.scan_mount_path
    )
    raster_reader_assessor = GeoServerRasterReaderAssessor(
        geoserver_rest_client,
        app_global_configuration.geoserver_internal_url,
    )
    raster_assessment_finalizer = RasterAssessmentFinalizer(
        raster_source_resolver,
        raster_reader_assessor,
    )
    published_rasters = PublishedRasterRegistry()
    raster_feature = create_raster_feature(
        RasterAssessmentService(
            app_global_configuration.scan_mount_path,
            raster_catalog,
            raster_source_resolver,
            raster_reader_assessor,
        ),
        RasterPublicationService(
            raster_catalog,
            raster_source_resolver,
            GeoServerRasterPublisher(
                geoserver_rest_client,
                app_global_configuration.geoserver_internal_url,
            ),
            published_rasters,
        ),
        RasterPixelService(
            published_rasters,
            app_global_configuration.raster_pixel_read_concurrency,
        ),
        RasterStatisticsService(
            published_rasters,
            app_global_configuration.raster_statistics_read_concurrency,
            app_global_configuration.raster_statistics_cache_entries,
        ),
        RasterDetailPreviewService(
            raster_catalog,
            raster_source_resolver,
            app_global_configuration.raster_pixel_read_concurrency,
            app_global_configuration.raster_statistics_cache_entries,
        ),
        published_rasters,
    )
    get_map_request_tracker = GetMapRequestTracker(
        app_global_configuration.geoserver_wms_render_count
    )
    rendering_diagnostics = RenderingDiagnosticsService(
        geoserver_diagnostics_client,
        app_global_configuration.geoserver_metrics_internal_url,
        app_global_configuration.geoserver_internal_url,
        get_map_request_tracker,
    )
    temporary_aoi_service = TemporaryAoiService(
        ttl=timedelta(
            seconds=app_global_configuration.temporary_aoi_ttl_seconds
        ),
        maximum_upload_bytes=(
            app_global_configuration.temporary_aoi_max_upload_bytes
        ),
        forbidden_roots=(
            Path.cwd(),
            app_global_configuration.scan_mount_path,
        )
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
            await temporary_aoi_service.start()
            client_stack.push_async_callback(temporary_aoi_service.close)
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
    application.include_router(
        create_catalog_router(catalog_database.random_matching_item)
    )
    application.include_router(raster_feature.router)
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
        item_finalizer=raster_assessment_finalizer,
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
    application.include_router(
        create_system_router(
            app_global_configuration.app_version,
            app_global_configuration.as_public_dict(),
        )
    )
    application.include_router(create_diagnostics_router(rendering_diagnostics))
    application.include_router(
        create_temporary_aoi_router(
            temporary_aoi_service,
            app_global_configuration.temporary_aoi_max_upload_bytes,
        )
    )
    application.include_router(
        create_stac_proxy_router(
            catalog_client,
            app_global_configuration.catalog_internal_url,
            number_matched_estimate_lookup,
        )
    )
    application.include_router(
        create_wms_proxy_router(
            geoserver_wms_client,
            app_global_configuration.geoserver_internal_url,
            raster_feature.registry,
            get_map_request_tracker,
        )
    )

    static_directory = Path(__file__).parent / "static"
    application.mount(
        "/",
        StaticFiles(directory=static_directory, html=True, check_dir=False),
        name="frontend",
    )

    return application
