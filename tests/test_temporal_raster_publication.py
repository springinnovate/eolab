"""Exercise temporal display publication through real source and rendering services."""

import asyncio
from collections.abc import Iterator
from pathlib import Path
from xml.etree import ElementTree

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx2
import pytest
import rasterio

from eolab_app.catalog.scanner import ScanManager
from eolab_app.diagnostics.tracker import GetMapRequestTracker
from eolab_app.raster.catalog import StacRasterCatalog
from eolab_app.raster.errors import RasterRequestError
from eolab_app.raster.geoserver import GeoServerRasterPublisher
from eolab_app.raster.pixel_service import RasterPixelService
from eolab_app.raster.publication import (
    RasterPublicationService,
    is_temporal_raster_layer,
)
from eolab_app.raster.source_access import RasterSourceAccess
from eolab_app.raster.source_authorization import CatalogRasterSourceAuthorizer
from eolab_app.raster.source_models import RasterSourceRequest
from eolab_app.raster.sources import MountedRasterResolver, PublishedRasterRegistry
from eolab_app.raster.statistics_service import RasterStatisticsService
from eolab_app.rendering.composite import CompositeMapRenderingService
from eolab_app.rendering.render_queue import GeoServerRenderQueue
from eolab_app.rendering.sld import SLD_NAMESPACE
from eolab_app.routes.composite_map import create_composite_map_router
from eolab_app.routes.raster_analysis import create_raster_analysis_router
from eolab_app.routes.rasters import create_raster_feature
from eolab_app.routes.wms_proxy import create_wms_proxy_router
from tests.test_catalog_temporal import (
    ITEM_KEY,
    PRECIPITATION,
    TEMPERATURE,
    create_scanner,
    observation_path,
    era5_archive,
    scan,
)
from tests.test_composite_map import _tile_url
from tests.test_temporal_source_access import populate_month
from tests.test_temporary_raster_publication import (
    OutputGeoServer,
    map_query,
    plan_request,
)

SOURCE = {
    "collectionId": ITEM_KEY[0],
    "itemId": ITEM_KEY[1],
    "variable": TEMPERATURE,
    "time": "2000-02-01T00:00:00Z",
}


@pytest.fixture
def temporal_rendering(
    era5_archive: Path,
) -> Iterator[
    tuple[TestClient, RasterPublicationService, OutputGeoServer, ScanManager, Path]
]:
    """Compose original-source analysis and rendering around a real admitted archive.

    Args:
        era5_archive: Partial monthly archive with published per-variable coverage.

    Yields:
        API client, publication service, external GeoServer double, scanner and
        source archive directory. Only external Catalog/GeoServer HTTP
        are replaced; reads, subprocesses, source authority and map routes are real.
    """
    populate_month(era5_archive, TEMPERATURE, (10, 20, 30))
    scanner, writer = create_scanner(era5_archive)
    asyncio.run(scan(scanner))
    assert scanner.status()["errors"] == []

    def catalog_response(request: httpx2.Request) -> httpx2.Response:
        """Return the current Item persisted by the test scanner.

        Args:
            request: Real Catalog adapter's Item request.

        Returns:
            Authoritative source metadata or a missing-Item response.
        """
        parts = request.url.path.split("/")
        item = writer.write_session.items.get((parts[-3], parts[-1]))
        return httpx2.Response(404) if item is None else httpx2.Response(200, json=item)

    catalog_client = httpx2.AsyncClient(
        transport=httpx2.MockTransport(catalog_response)
    )
    upstream = OutputGeoServer()
    geoserver = httpx2.AsyncClient(transport=httpx2.MockTransport(upstream))
    catalog = StacRasterCatalog(catalog_client, "http://catalog")
    resolver = MountedRasterResolver(era5_archive.parent)
    sources = RasterSourceAccess(CatalogRasterSourceAuthorizer(catalog, resolver))
    registry = PublishedRasterRegistry()
    publication = RasterPublicationService(
        catalog,
        resolver,
        GeoServerRasterPublisher(geoserver, "http://geoserver/geoserver"),
        registry,
        source_access=sources,
    )
    scanner.items_updated = publication.invalidate_temporal_items
    app = FastAPI()
    app.include_router(create_raster_feature(publication, registry).router)
    app.include_router(
        create_raster_analysis_router(
            RasterPixelService(sources, 1),
            RasterStatisticsService(sources, 1, 2),
            source_access=sources,
        )
    )
    tracker, queue = GetMapRequestTracker(2), GeoServerRenderQueue(2)
    app.include_router(
        create_wms_proxy_router(
            geoserver,
            "http://geoserver/geoserver",
            (registry,),
            tracker,
            queue,
            hidden_layer=is_temporal_raster_layer,
            use_layers=publication.use_layers,
        )
    )
    app.include_router(
        create_composite_map_router(
            CompositeMapRenderingService((registry,)),
            geoserver,
            "http://geoserver/geoserver",
            tracker,
            queue,
            use_layers=publication.use_layers,
        )
    )
    with TestClient(app) as client:
        yield client, publication, upstream, scanner, era5_archive
        client.portal.call(queue.close)
        client.portal.call(geoserver.aclose)
        client.portal.call(catalog_client.aclose)


def test_observations_publish_original_files_and_refresh_without_gating_analysis(
    temporal_rendering: tuple[
        TestClient, RasterPublicationService, OutputGeoServer, ScanManager, Path
    ],
) -> None:
    """Style two views of one observation and preserve files through source refresh.

    Args:
        temporal_rendering: Real source, publication and rendering services.
    """
    api, publication, upstream, scanner, archive = temporal_rendering
    original_files = set(archive.rglob("*.tif"))
    path = observation_path(archive, TEMPERATURE, 2, 0)
    first = api.post("/api/rendering/layers", json={"source": SOURCE})
    assert first.status_code == 200, first.text
    layer = first.json()["layerName"]
    assert first.json()["bbox"] == [-180, -90, 180, 90]
    assert str(archive) not in first.text
    writes = [
        request
        for request in upstream.requests
        if request.url.path.endswith("/external.geotiff")
    ]
    assert len(writes) == 1 and writes[0].content.decode() == path.as_uri()
    before = len(upstream.requests)
    equivalent = {**SOURCE, "time": "2000-01-31T16:00:00-08:00"}
    assert (
        api.post("/api/rendering/layers", json={"source": equivalent}).json()
        == first.json()
    )
    assert len(upstream.requests) == before
    assert set(archive.rglob("*.tif")) == original_files
    assert api.get("/geoserver/eolab/wms", params=map_query(layer)).content == b"tile"
    top = {**plan_request(layer)["layers"][0], "opacity": 0.25}
    bottom = {
        **top,
        "opacity": 0.75,
        "styleEnvironment": (
            "min:10;med:20;max:30;cmin:#ff0000;cmed:#00ff00;cmax:#0000ff"
        ),
    }
    plan = api.post("/api/map-rendering/plans", json={"layers": [top, bottom]})
    assert plan.status_code == 200, plan.text
    tile = _tile_url(plan.json()["wmsUrl"])
    assert api.get(tile).content == b"tile"
    document = ElementTree.fromstring(upstream.requests[-1].content)
    named_layers = document.findall(f".//{{{SLD_NAMESPACE}}}NamedLayer")
    assert [entry.findtext(f"{{{SLD_NAMESPACE}}}Name") for entry in named_layers] == [
        layer,
        layer,
    ]
    assert [
        entry.findtext(f".//{{{SLD_NAMESPACE}}}Opacity") for entry in named_layers
    ] == ["0.75", "0.25"]
    assert [
        [
            (stop.attrib["quantity"], stop.attrib["color"])
            for stop in entry.findall(f".//{{{SLD_NAMESPACE}}}ColorMapEntry")
        ]
        for entry in named_layers
    ] == [
        [("10", "#ff0000"), ("20", "#00ff00"), ("30", "#0000ff")],
        [("0", "#000000"), ("8", "#888888"), ("16", "#ffffff")],
    ]
    capabilities = api.get(
        "/geoserver/eolab/wms", params={"service": "WMS", "request": "GetCapabilities"}
    )
    assert layer not in capabilities.text
    missing = api.post(
        "/api/rendering/layers",
        json={
            "source": {
                **SOURCE,
                "variable": PRECIPITATION,
                "time": "2000-02-01T01:00:00Z",
            }
        },
    )
    assert missing.status_code == 409 and "No observation" in missing.text
    api.portal.call(publication.invalidate_temporal_items, ((ITEM_KEY[0], "other"),))
    assert api.get(tile).status_code == 200
    upstream.fail_delete = True
    api.portal.call(scan, scanner)
    assert scanner.status()["errors"] == []
    assert api.get(tile).status_code == 400
    assert api.get("/geoserver/eolab/wms", params=map_query(layer)).status_code == 400
    pixel = api.post(
        "/api/raster-analysis/pixels",
        json={"source": SOURCE, "longitude": 0, "latitude": 0},
    )
    assert pixel.status_code == 200 and pixel.json()["value"] == 10
    with pytest.raises(Exception):
        api.portal.call(publication.cleanup)
    upstream.fail_delete = False
    api.portal.call(publication.cleanup)
    assert not upstream.names and set(archive.rglob("*.tif")) == original_files
    with rasterio.open(path) as dataset:
        assert tuple(dataset.bounds) == (-180.125, -90.125, 179.875, 90.125)
        assert next(dataset.sample([(0, 0)]))[0] == 10
    replacement = api.post("/api/rendering/layers", json={"source": SOURCE})
    assert replacement.status_code == 200, replacement.text
    assert replacement.json()["layerName"] != layer


def test_browsing_dates_keeps_existing_maps_and_restart_preserves_source_files(
    temporal_rendering: tuple[
        TestClient, RasterPublicationService, OutputGeoServer, ScanManager, Path
    ],
) -> None:
    """Keep published observations across browsing and remove only restart resources.

    Args:
        temporal_rendering: Real source and rendering services around GeoTIFFs.
    """
    api, publication, upstream, _, archive = temporal_rendering
    original_files = set(archive.rglob("*.tif"))
    first = api.post("/api/rendering/layers", json={"source": SOURCE})
    layer = first.json()["layerName"]
    plan = api.post("/api/map-rendering/plans", json=plan_request(layer))
    tile = _tile_url(plan.json()["wmsUrl"])
    assert api.get(tile).content == b"tile"
    layers = [layer]
    for hour in (1, 2):
        published = api.post(
            "/api/rendering/layers",
            json={"source": {**SOURCE, "time": f"2000-02-01T0{hour}:00:00Z"}},
        )
        assert published.status_code == 200, published.text
        layers.append(published.json()["layerName"])
    api.portal.call(publication.cleanup)
    assert upstream.names == {name.split(":", 1)[1] for name in layers}
    assert api.get(tile).content == b"tile"
    assert api.get("/geoserver/eolab/wms", params=map_query(layer)).content == b"tile"
    composite = api.post(
        "/api/map-rendering/plans",
        json={"layers": [plan_request(name)["layers"][0] for name in layers]},
    )
    assert composite.status_code == 200, composite.text
    assert api.get(_tile_url(composite.json()["wmsUrl"])).content == b"tile"
    assert set(archive.rglob("*.tif")) == original_files

    fresh_client = httpx2.AsyncClient(transport=httpx2.MockTransport(upstream))
    restarted = RasterPublicationService(
        None,
        None,
        GeoServerRasterPublisher(fresh_client, "http://geoserver/geoserver"),
        PublishedRasterRegistry(),
    )
    api.portal.call(restarted.cleanup)
    assert not upstream.names and set(archive.rglob("*.tif")) == original_files
    api.portal.call(restarted.cleanup)
    api.portal.call(fresh_client.aclose)


def test_active_render_survives_disconnect_and_refresh_rejects_queued_identity(
    temporal_rendering: tuple[
        TestClient, RasterPublicationService, OutputGeoServer, ScanManager, Path
    ],
) -> None:
    """Keep an active publication through cancellation while revoking queued names.

    Args:
        temporal_rendering: Real publication lifecycle around external GeoServer.
    """
    api, publication, upstream, _, archive = temporal_rendering
    first = api.post("/api/rendering/layers", json={"source": SOURCE})
    layer = first.json()["layerName"]
    name = layer.split(":", 1)[1]
    path = observation_path(archive, TEMPERATURE, 2, 0)

    async def scenario() -> None:
        """Exercise active publication retention at the actual render queue boundary."""
        queue = GeoServerRenderQueue(1)
        entered, finish = asyncio.Event(), asyncio.Event()

        async def active_render() -> httpx2.Response:
            """Keep the GeoServer layer until its simulated response completes.

            Returns:
                Completed controlled map response.
            """
            async with publication.use_layers((layer,)):
                entered.set()
                await finish.wait()
                assert path.exists() and name in upstream.names
                return httpx2.Response(200, content=b"tile")

        async def queued_render() -> httpx2.Response:
            """Attempt to use an identity revoked while this render was queued.

            Returns:
                A response only if the revoked identity was incorrectly accepted.
            """
            async with publication.use_layers((layer,)):
                return httpx2.Response(200)

        task = asyncio.create_task(queue.run(active_render, request_key="active"))
        await entered.wait()
        queued = asyncio.create_task(queue.run(queued_render, request_key="queued"))
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await publication.invalidate_temporal_items((ITEM_KEY,))
        await publication.cleanup()
        assert path.exists() and upstream.names == {name}
        finish.set()
        with pytest.raises(RasterRequestError, match="no longer available"):
            await queued
        await queue.close()
        assert path.exists() and not upstream.names

    api.portal.call(scenario)
