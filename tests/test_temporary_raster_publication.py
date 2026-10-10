"""Temporary output publication through ordinary GeoServer, WMS and composite routes."""

import asyncio
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import httpx2
import pytest
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.testclient import TestClient

from eolab_app.diagnostics.tracker import GetMapRequestTracker
from eolab_app.raster.geoserver import GeoServerRasterPublisher
from eolab_app.raster.publication import (
    RasterPublicationService,
    temporary_raster_source,
)
from eolab_app.raster.sources import PublishedRasterRegistry
from eolab_app.raster.source_access import RasterSourceAccess
from eolab_app.rendering.composite import CompositeMapRenderingService
from eolab_app.rendering.render_queue import GeoServerRenderQueue
from eolab_app.rendering.errors import PublishedLayerNotAuthorizedError
from eolab_app.routes.rasters import create_raster_feature
from eolab_app.routes.wms_proxy import create_wms_proxy_router
from eolab_app.routes.composite_map import create_composite_map_router
from eolab_app.source_files import SourceFileError
from test_raster_source_access import FileAuthority, PRIVATE, write_source
from test_composite_map import _tile_url

ENV = "min:0;med:8;max:16;cmin:#000000;cmed:#888888;cmax:#ffffff"


class OutputGeoServer:
    """Emulate only external GeoServer REST state and tile responses for boundary tests."""

    def __init__(self) -> None:
        """Start without private coverage stores and record all upstream requests."""
        self.names: set[str] = set()
        self.requests: list[httpx2.Request] = []
        self.fail_delete = False

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        """Respond to publication, discovery, cleanup and ordinary map rendering.

        Args:
            request: Authenticated REST or internal WMS request.

        Returns:
            Controlled external response with no application behavior mocked.
        """
        self.requests.append(request)
        path = request.url.path
        if path.endswith("/eolab/wms"):
            if request.url.params.get("request", "").lower() == "getcapabilities":
                layers = "".join(
                    f"<Layer><Name>eolab:{name}</Name></Layer>" for name in self.names
                )
                return httpx2.Response(
                    200,
                    content=f"<WMS_Capabilities><Capability><Layer><Layer><Name>eolab:catalog</Name></Layer>{layers}</Layer></Capability></WMS_Capabilities>",
                    headers={"Content-Type": "application/xml"},
                )
            return httpx2.Response(
                200,
                content=b"tile",
                headers={"Content-Type": "image/png", "Cache-Control": "max-age=3600"},
            )
        if path.endswith("/coveragestores.json"):
            return httpx2.Response(
                200,
                json={
                    "coverageStores": {
                        "coverageStore": [{"name": name} for name in sorted(self.names)]
                    }
                },
            )
        if request.method == "DELETE":
            if self.fail_delete:
                return httpx2.Response(503)
            if "/coveragestores/" in path:
                self.names.discard(path.rsplit("/", 1)[-1])
            return httpx2.Response(200)
        if path.endswith("/external.geotiff"):
            self.names.add(path.split("/coveragestores/")[1].split("/")[0])
            return httpx2.Response(201)
        if request.method == "PUT":
            return httpx2.Response(200)
        if path.endswith("/workspaces/eolab.json") or path.endswith(
            "/styles/dynamic-raster.sld"
        ):
            return httpx2.Response(200)
        name = path.rsplit("/", 1)[-1].removesuffix(".json")
        return httpx2.Response(200 if name in self.names else 404)


def attach_output_rendering(
    app: FastAPI,
    sources: RasterSourceAccess,
    available: Callable[[str, str], Awaitable[bool]],
    session_owner: Callable[[Request, Response], str],
    upstream: OutputGeoServer,
) -> tuple[RasterPublicationService, PublishedRasterRegistry]:
    """Compose the real publication, WMS and tile services with external HTTP replaced.

    Args:
        app: Test HTTP application.
        sources: Real owner-checked original source resolver.
        available: Authoritative result-lifetime callback.
        session_owner: Server-side session identity boundary.
        upstream: External GeoServer REST and WMS responses.

    Returns:
        Publication lifecycle and ordinary raster registry.
    """
    client = httpx2.AsyncClient(transport=httpx2.MockTransport(upstream))
    registry = PublishedRasterRegistry()
    publication = RasterPublicationService(
        None,
        None,
        GeoServerRasterPublisher(client, "http://geoserver/geoserver"),
        registry,
        source_access=sources,
        source_available=available,
    )
    app.include_router(
        create_raster_feature(publication, registry, session_owner).router
    )

    async def authorize(names: tuple[str, ...], request: Request) -> bool:
        """Check the requesting owner before any normal tile cache or upstream read.

        Args:
            names: Server-issued layer names.
            request: Browser request with session identity.

        Returns:
            Whether this response requires private cache headers.

        Raises:
            HTTPException: When access or lifetime rejects a temporary layer.
        """
        try:
            return await publication.authorize_layers(
                names, session_owner(request, Response())
            )
        except SourceFileError as error:
            raise HTTPException(
                error.status, str(error), headers={"Cache-Control": "private, no-store"}
            ) from error

    tracker = GetMapRequestTracker(2)
    queue = GeoServerRenderQueue(2)
    app.include_router(
        create_wms_proxy_router(
            client,
            "http://geoserver/geoserver",
            (registry,),
            tracker,
            queue,
            authorize_layers=authorize,
            hidden_layer=lambda name: temporary_raster_source(name) is not None,
        )
    )
    app.include_router(
        create_composite_map_router(
            CompositeMapRenderingService((registry,)),
            client,
            "http://geoserver/geoserver",
            tracker,
            queue,
            authorize_layers=authorize,
        )
    )
    return publication, registry


def plan_request(layer_name: str) -> dict[str, Any]:
    """Build the standard raster composite descriptor.

    Args:
        layer_name: Returned WMS publication identity.

    Returns:
        Ordinary style and opacity request shared by all raster sources.
    """
    return {
        "layers": [
            {
                "layerName": layer_name,
                "styleName": "dynamic-raster",
                "styleEnvironment": ENV,
                "opacity": 1,
            }
        ]
    }


def map_query(layer_name: str) -> dict[str, str]:
    """Build an ordinary direct WMS tile query.

    Args:
        layer_name: Returned WMS layer identity.

    Returns:
        Valid normal raster style and tile parameters.
    """
    return dict(
        service="WMS",
        request="GetMap",
        layers=layer_name,
        styles="dynamic-raster",
        env=ENV,
        format="image/png",
        transparent="true",
        version="1.3.0",
        crs="EPSG:3857",
        bbox="0,0,256,256",
        width="256",
        height="256",
    )


def test_outputs_reuse_tiles_with_owner_expiry_and_retryable_cleanup(
    tmp_path: Path,
) -> None:
    """Use normal publication and cached tiles while rejecting foreign and expired access.

    Args:
        tmp_path: Isolated original raster storage.
    """
    authority = FileAuthority(write_source(tmp_path / "original.tif"))
    upstream = OutputGeoServer()
    app = FastAPI()

    async def available(run: str, file: str) -> bool:
        """Report controlled lifetime, preserving the real file for cleanup assertions.

        Args:
            run: Previously published run ID.
            file: Previously published file ID.

        Returns:
            Whether the controlled output is still available.
        """
        assert (run, file) == (PRIVATE["jobId"], PRIVATE["artifactId"])
        return authority.ready

    publication, registry = attach_output_rendering(
        app,
        RasterSourceAccess(None, authority.files()),
        available,
        lambda request, response: request.headers.get("Owner", "owner"),
        upstream,
    )
    with TestClient(app) as client:
        published = client.post("/api/rendering/layers", json={"source": PRIVATE})
        assert published.status_code == 200, published.text
        layer = published.json()["layerName"]
        assert str(authority.path) not in published.text
        assert layer == f"eolab:model_{PRIVATE['jobId']}_{PRIVATE['artifactId']}"
        assert not authority.leases
        assert any(
            request.method == "PUT" and b'"advertised":false' in request.content
            for request in upstream.requests
        )
        assert any(
            request.url.path.endswith("external.geotiff")
            and authority.path.as_uri().encode() in request.content
            for request in upstream.requests
        )
        capabilities = client.get(
            "/geoserver/eolab/wms",
            params={"service": "WMS", "request": "GetCapabilities"},
        )
        assert "eolab:catalog" in capabilities.text and layer not in capabilities.text
        direct = client.get("/geoserver/eolab/wms", params=map_query(layer))
        assert (
            direct.content == b"tile"
            and direct.headers["cache-control"] == "private, no-store"
        )
        response = client.post("/api/map-rendering/plans", json=plan_request(layer))
        assert response.status_code == 200, response.text
        tile = _tile_url(response.json()["wmsUrl"])
        for _ in range(2):
            rendered = client.get(tile)
            assert (
                rendered.content == b"tile"
                and rendered.headers["cache-control"] == "private, no-store"
            )
        composites = [
            request
            for request in upstream.requests
            if request.method == "POST" and request.url.path.endswith("/wms")
        ]
        assert len(composites) == 1  # The existing composite cache is reused.
        count = len(upstream.requests)
        for headers in ({"Owner": "foreign"},):
            assert (
                client.post(
                    "/api/rendering/layers", json={"source": PRIVATE}, headers=headers
                ).status_code
                == 404
            )
            assert (
                client.post(
                    "/api/map-rendering/plans",
                    json=plan_request(layer),
                    headers=headers,
                ).status_code
                == 404
            )
            assert client.get(tile, headers=headers).status_code == 404
            assert (
                client.get(
                    "/geoserver/eolab/wms", params=map_query(layer), headers=headers
                ).status_code
                == 404
            )
        assert len(upstream.requests) == count
        client.portal.call(publication.cleanup)
        assert upstream.names
        authority.ready = False
        assert client.get(tile).status_code == 409
        assert (
            client.get("/geoserver/eolab/wms", params=map_query(layer)).status_code
            == 409
        )
        upstream.fail_delete = True
        with pytest.raises(Exception):
            client.portal.call(publication.cleanup)
        assert upstream.names
        upstream.fail_delete = False
        client.portal.call(publication.cleanup)
        client.portal.call(publication.cleanup)
        assert not upstream.names and authority.path.exists()
        with pytest.raises(PublishedLayerNotAuthorizedError):
            registry.require_current(layer)
        deletes = [
            request for request in upstream.requests if request.method == "DELETE"
        ]
        assert any("/gwc/rest/layers/" in request.url.path for request in deletes)
        assert deletes[-1].url.params["purge"] == "none"
        assert deletes[-1].url.params["recurse"] == "true"
