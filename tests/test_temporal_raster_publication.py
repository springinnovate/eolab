"""Exercise temporal display publication through real source and rendering services."""

import asyncio
from collections.abc import Iterator
from pathlib import Path

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
from eolab_app.routes.composite_map import create_composite_map_router
from eolab_app.routes.raster_analysis import create_raster_analysis_router
from eolab_app.routes.rasters import create_raster_feature
from eolab_app.routes.wms_proxy import create_wms_proxy_router
from tests.test_catalog_temporal import (
    ITEM_KEY,
    PRECIPITATION,
    TEMPERATURE,
    create_scanner,
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
        isolated display-cache directory. Only external Catalog/GeoServer HTTP
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
    cache = era5_archive.parent / "display-cache"
    publication = RasterPublicationService(
        catalog,
        resolver,
        GeoServerRasterPublisher(geoserver, "http://geoserver/geoserver"),
        registry,
        source_access=sources,
        slice_cache_path=cache,
        slice_cache_entries=2,
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
        yield client, publication, upstream, scanner, cache
        client.portal.call(queue.close)
        client.portal.call(geoserver.aclose)
        client.portal.call(catalog_client.aclose)


def test_observations_reuse_rendering_and_refresh_without_gating_analysis(
    temporal_rendering: tuple[
        TestClient, RasterPublicationService, OutputGeoServer, ScanManager, Path
    ],
) -> None:
    """Reuse exact frames, render normally, and revoke only explicitly refreshed Items.

    Args:
        temporal_rendering: Real composed services with isolated source and cache files.
    """
    api, publication, upstream, scanner, cache = temporal_rendering
    first = api.post("/api/rendering/layers", json={"source": SOURCE})
    assert first.status_code == 200, first.text
    layer = first.json()["layerName"]
    assert first.json()["bbox"] == [-180, -90, 180, 90]
    assert str(cache) not in first.text
    path = cache / f"{layer.split(':')[1]}.tif"
    with rasterio.open(path) as dataset:
        assert (
            dataset.read(1, window=rasterio.windows.Window(720, 360, 1, 1))[0, 0] == 10
        )
    before = len(upstream.requests)
    equivalent = {**SOURCE, "time": "2000-01-31T16:00:00-08:00"}
    assert (
        api.post("/api/rendering/layers", json={"source": equivalent}).json()
        == first.json()
    )
    assert len(upstream.requests) == before
    assert list(cache.glob("*.tif")) == [path]
    assert api.get("/geoserver/eolab/wms", params=map_query(layer)).content == b"tile"
    plan = api.post("/api/map-rendering/plans", json=plan_request(layer))
    assert plan.status_code == 200, plan.text
    tile = _tile_url(plan.json()["wmsUrl"])
    assert api.get(tile).content == b"tile"
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
    assert scanner.status()["errors"] == []  # Invalidation never calls GeoServer.
    assert api.get(tile).status_code == 400
    assert api.get("/geoserver/eolab/wms", params=map_query(layer)).status_code == 400
    pixel = api.post(
        "/api/raster-analysis/pixels",
        json={"source": SOURCE, "longitude": 0, "latitude": 0},
    )
    assert pixel.status_code == 200 and pixel.json()["value"] == 10
    with pytest.raises(Exception):
        api.portal.call(publication.cleanup)
    assert path.exists()  # GeoServer might still be using it.
    upstream.fail_delete = False
    api.portal.call(publication.cleanup)
    assert not path.exists() and not upstream.names
    replacement = api.post("/api/rendering/layers", json={"source": SOURCE})
    assert replacement.status_code == 200, replacement.text
    assert replacement.json()["layerName"] != layer


def test_recent_frames_evict_and_restart_removes_leftovers(
    temporal_rendering: tuple[
        TestClient, RasterPublicationService, OutputGeoServer, ScanManager, Path
    ],
) -> None:
    """Bound recent frames and clean old files only after GeoServer unpublication.

    Args:
        temporal_rendering: Real services with a two-observation cache.
    """
    api, publication, upstream, _, cache = temporal_rendering
    layers = []
    for hour in range(2):
        response = api.post(
            "/api/rendering/layers",
            json={"source": {**SOURCE, "time": f"2000-02-01T0{hour}:00:00Z"}},
        )
        assert response.status_code == 200, response.text
        layers.append(response.json()["layerName"])
    api.post(
        "/api/rendering/layers", json={"source": SOURCE}
    )  # Retain first as most recent.
    upstream.fail_delete = True
    third = api.post(
        "/api/rendering/layers",
        json={"source": {**SOURCE, "time": "2000-02-01T02:00:00Z"}},
    )
    assert third.status_code == 502, third.text
    before_retry = len(upstream.requests)
    third = api.post(
        "/api/rendering/layers",
        json={"source": {**SOURCE, "time": "2000-02-01T02:00:00Z"}},
    )
    assert third.status_code == 200, third.text
    assert len(upstream.requests) == before_retry
    assert (
        api.get("/geoserver/eolab/wms", params=map_query(layers[0])).status_code == 200
    )
    assert len(list(cache.glob("*.tif"))) == 3
    upstream.fail_delete = False
    api.portal.call(publication.cleanup)
    assert len(list(cache.glob("*.tif"))) == 2
    recovered = api.get("/geoserver/eolab/wms", params=map_query(layers[1]))
    assert recovered.status_code == 200 and recovered.content == b"tile"
    assert len(list(cache.glob("*.tif"))) == 2
    orphan = cache / f"slice_{'a' * 32}.tif"
    orphan.write_bytes(b"interrupted native write")
    unrelated = cache / "operator-note.txt"
    unrelated.write_text("keep", encoding="utf-8")
    fresh_client = httpx2.AsyncClient(transport=httpx2.MockTransport(upstream))
    restarted = RasterPublicationService(
        None,
        None,
        GeoServerRasterPublisher(fresh_client, "http://geoserver/geoserver"),
        PublishedRasterRegistry(),
        slice_cache_path=cache,
    )
    api.portal.call(restarted.cleanup)
    assert not upstream.names and not list(cache.glob("*.tif"))
    assert unrelated.read_text(encoding="utf-8") == "keep"
    api.portal.call(restarted.cleanup)
    api.portal.call(fresh_client.aclose)


def test_cancelled_materialization_releases_every_acquired_frame(
    temporal_rendering: tuple[
        TestClient, RasterPublicationService, OutputGeoServer, ScanManager, Path
    ],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stop native restoration before deleting its partial file or releasing its lock.

    Args:
        temporal_rendering: Real source authority and publication service.
        monkeypatch: Replace only the already-tested native-process boundary.
    """
    api, publication, upstream, _, cache = temporal_rendering

    async def scenario() -> None:
        """Cancel one restoration after protecting both its missing and resident frames."""
        started, cancelled, exited = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def completed_write(
            reader: object, observation: object, path: Path
        ) -> tuple[float, float, float, float]:
            """Emulate a successful native write for lifecycle-only assertions.

            Args:
                reader: Trusted materialization function.
                observation: Authorized temporal observation.
                path: File owned by the publication service.

            Returns:
                Geographic bounds for the completed stand-in file.
            """
            path.write_bytes(b"completed")
            return (-180, -90, 180, 90)

        monkeypatch.setattr(
            "eolab_app.raster.publication.read_private_raster", completed_write
        )
        layers = []
        for hour in range(3):
            published = await publication.publish(
                RasterSourceRequest(
                    source={**SOURCE, "time": f"2000-02-01T0{hour}:00:00Z"}
                )
            )
            layers.append(published.layer_name)
        restored_path = cache / f"{layers[0].split(':')[1]}.tif"
        assert not restored_path.exists()

        async def native_read(reader: object, observation: object, path: Path) -> None:
            """Emulate a process that must finish stopping before its caller returns.

            Args:
                reader: Trusted materialization function.
                observation: Authorized temporal source.
                path: Cache file owned by the publication service.

            Raises:
                asyncio.CancelledError: After simulated native exit.
            """
            path.write_bytes(b"partial")
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                await exited.wait()
                raise

        async def restore_frames() -> None:
            """Use two frames, with the first requiring native reconstruction."""
            async with publication.use_layers(tuple(layers[:2])):
                pass

        monkeypatch.setattr(
            "eolab_app.raster.publication.read_private_raster", native_read
        )
        task = asyncio.create_task(restore_frames())
        await started.wait()

        async def ordinary_render() -> None:
            """Enter an ordinary render while temporal materialization holds its lock."""
            async with publication.use_layers(("eolab:ordinary",)):
                pass

        await asyncio.wait_for(ordinary_render(), timeout=1)
        task.cancel()
        await cancelled.wait()
        cleanup = asyncio.create_task(publication.cleanup())
        await asyncio.sleep(0)
        assert not cleanup.done() and restored_path.exists()
        exited.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        await cleanup
        assert not restored_path.exists() and len(list(cache.glob("*.tif"))) == 2
        monkeypatch.setattr(
            "eolab_app.raster.publication.read_private_raster", completed_write
        )
        async with publication.use_layers((layers[0],)):
            assert restored_path.exists()
        await publication.invalidate_temporal_items((ITEM_KEY,))
        await publication.cleanup()
        assert not list(cache.glob("*.tif")) and not upstream.names

    api.portal.call(scenario)


def test_other_browser_eviction_preserves_direct_and_composite_maps(
    temporal_rendering: tuple[
        TestClient, RasterPublicationService, OutputGeoServer, ScanManager, Path
    ],
) -> None:
    """Restore one browser's unchanged layer after another browses additional dates.

    Args:
        temporal_rendering: Real source and rendering services with a two-frame cache.
    """
    api, publication, upstream, _, cache = temporal_rendering

    async def scenario() -> None:
        """Browse with independent clients sharing the same backend cache."""
        transport = httpx2.ASGITransport(app=api.app)
        async with (
            httpx2.AsyncClient(transport=transport, base_url="http://test") as first,
            httpx2.AsyncClient(transport=transport, base_url="http://test") as second,
        ):
            published = await first.post(
                "/api/rendering/layers", json={"source": SOURCE}
            )
            assert published.status_code == 200, published.text
            layer = published.json()["layerName"]
            path = cache / f"{layer.split(':')[1]}.tif"
            registered = await first.post(
                "/api/map-rendering/plans", json=plan_request(layer)
            )
            assert registered.status_code == 200, registered.text
            plan_url = registered.json()["wmsUrl"]
            cached_tile = _tile_url(plan_url)
            assert (await first.get(cached_tile)).content == b"tile"
            for hour in (1, 2):
                response = await second.post(
                    "/api/rendering/layers",
                    json={"source": {**SOURCE, "time": f"2000-02-01T0{hour}:00:00Z"}},
                )
                assert response.status_code == 200, response.text
            assert not path.exists()
            requests = len(upstream.requests)
            assert (await first.get(cached_tile)).content == b"tile"
            assert len(upstream.requests) == requests and not path.exists()
            recovered = await first.get("/geoserver/eolab/wms", params=map_query(layer))
            assert recovered.status_code == 200 and recovered.content == b"tile"
            with rasterio.open(path) as dataset:
                assert (
                    dataset.read(1, window=rasterio.windows.Window(720, 360, 1, 1))[
                        0, 0
                    ]
                    == 10
                )
            for hour in (1, 2):
                response = await second.post(
                    "/api/rendering/layers",
                    json={"source": {**SOURCE, "time": f"2000-02-01T0{hour}:00:00Z"}},
                )
                assert response.status_code == 200, response.text
            assert not path.exists()
            recovered = await first.get(_tile_url(plan_url, "256,0,512,256"))
            assert recovered.status_code == 200 and recovered.content == b"tile"
            assert path.exists() and len(list(cache.glob("*.tif"))) == 2
            same = await first.post("/api/rendering/layers", json={"source": SOURCE})
            assert same.json() == published.json()
            pixel = await first.post(
                "/api/raster-analysis/pixels",
                json={"source": SOURCE, "longitude": 0, "latitude": 0},
            )
            assert pixel.status_code == 200 and pixel.json()["value"] == 10
            for hour in (1, 2):
                response = await second.post(
                    "/api/rendering/layers",
                    json={"source": {**SOURCE, "time": f"2000-02-01T0{hour}:00:00Z"}},
                )
                assert response.status_code == 200, response.text
            assert not path.exists()
            await publication.invalidate_temporal_items((ITEM_KEY,))
            assert (await first.get(cached_tile)).status_code == 400
            assert (
                await first.get("/geoserver/eolab/wms", params=map_query(layer))
            ).status_code == 400

    api.portal.call(scenario)


def test_composite_holds_more_frames_than_the_idle_cache(
    temporal_rendering: tuple[
        TestClient, RasterPublicationService, OutputGeoServer, ScanManager, Path
    ],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep every composite member until GeoServer finishes, then trim idle files.

    Args:
        temporal_rendering: Real rendering services with a two-frame cache.
        monkeypatch: Observe only the external GeoServer operation.
    """
    api, _, upstream, _, cache = temporal_rendering
    layers = []
    for hour in range(3):
        response = api.post(
            "/api/rendering/layers",
            json={"source": {**SOURCE, "time": f"2000-02-01T0{hour}:00:00Z"}},
        )
        assert response.status_code == 200, response.text
        layers.append(response.json()["layerName"])
    paths = [cache / f"{layer.split(':')[1]}.tif" for layer in layers]
    assert sum(path.exists() for path in paths) == 2
    external_request = OutputGeoServer.__call__
    observed = False

    def verify_active_files(
        server: OutputGeoServer, request: httpx2.Request
    ) -> httpx2.Response:
        """Require all frame files during the real composite route's upstream request.

        Args:
            server: Controlled external GeoServer state.
            request: Actual REST or WMS request made by the application.

        Returns:
            Existing controlled upstream response.
        """
        nonlocal observed
        if request.url.path.endswith("/eolab/wms"):
            observed = True
            assert all(path.exists() for path in paths)
            assert all(layer.split(":")[1] in upstream.names for layer in layers)
        return external_request(server, request)

    monkeypatch.setattr(OutputGeoServer, "__call__", verify_active_files)
    response = api.post(
        "/api/map-rendering/plans",
        json={"layers": [plan_request(layer)["layers"][0] for layer in layers]},
    )
    assert response.status_code == 200, response.text
    tile = api.get(_tile_url(response.json()["wmsUrl"]))
    assert tile.status_code == 200 and tile.content == b"tile" and observed
    assert sum(path.exists() for path in paths) == 2


def test_active_render_survives_disconnect_and_refresh_rejects_queued_identity(
    temporal_rendering: tuple[
        TestClient, RasterPublicationService, OutputGeoServer, ScanManager, Path
    ],
) -> None:
    """Protect an active frame through cancellation while revoking queued old names.

    Args:
        temporal_rendering: Real publication/source lifecycle around external GeoServer.
    """
    api, publication, upstream, _, cache = temporal_rendering
    first = api.post("/api/rendering/layers", json={"source": SOURCE})
    layer = first.json()["layerName"]
    path = cache / f"{layer.split(':')[1]}.tif"

    async def scenario() -> None:
        """Exercise the existing queue's active-work cancellation contract."""
        queue = GeoServerRenderQueue(1)
        entered, finish = asyncio.Event(), asyncio.Event()

        async def active_render() -> httpx2.Response:
            """Keep the frame open until the simulated GeoServer response completes.

            Returns:
                Completed controlled map response.
            """
            async with publication.use_layers((layer,)):
                entered.set()
                await finish.wait()
                assert path.exists()
                return httpx2.Response(200, content=b"tile")

        async def queued_render() -> httpx2.Response:
            """Attempt to use the old identity after it waited behind another render.

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
        for hour in (1, 2):
            await publication.publish(
                RasterSourceRequest(
                    source={**SOURCE, "time": f"2000-02-01T0{hour}:00:00Z"}
                )
            )
        assert path.exists() and len(list(cache.glob("*.tif"))) == 3
        await publication.invalidate_temporal_items((ITEM_KEY,))
        await publication.cleanup()
        assert path.exists() and list(cache.glob("*.tif")) == [path]
        finish.set()
        with pytest.raises(RasterRequestError, match="no longer available"):
            await queued
        await queue.close()
        assert not path.exists() and not upstream.names

    api.portal.call(scenario)
