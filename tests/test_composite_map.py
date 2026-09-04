"""Test bounded GeoServer-composed map plan and tile delivery."""

import asyncio
from collections.abc import Mapping
from pathlib import Path
from xml.etree import ElementTree

import httpx2
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eolab_app.diagnostics.tracker import GetMapRequestTracker
from eolab_app.raster.source_identity import RasterSourceIdentity
from eolab_app.raster.wms_authorization import PublishedRasterAuthorization
from eolab_app.rendering.composite import (
    AuthorizedCompositeMapPlan,
    CompositeMapRenderingService,
)
from eolab_app.rendering.errors import (
    PublishedLayerChangedError,
    PublishedLayerNotAuthorizedError,
)
from eolab_app.rendering.sld import SLD_NAMESPACE
from eolab_app.routes.composite_map import create_composite_map_router
from eolab_app.vector.styles import default_vector_style
from eolab_app.vector.wms_authorization import PublishedVectorAuthorization


class _TestAuthorization:
    """Authorize one fixed test style and emit its requested layer identity."""

    style_name = "test-style"

    def validate_parameters(
        self,
        operation: str,
        query: Mapping[str, str],
    ) -> None:
        """Accept the unused ordinary WMS contract.

        Args:
            operation: Unused normalized WMS operation.
            query: Unused normalized query.
        """
        del operation, query

    def build_composite_sld(
        self,
        layer_name: str,
        style_name: str,
        style_environment: str | None,
        style_definition: Mapping[str, object] | None,
        opacity: float,
    ) -> bytes:
        """Build one inspectable single-layer SLD.

        Args:
            layer_name: Requested published layer.
            style_name: Requested fixed style.
            style_environment: Unused raster representation.
            style_definition: Required test representation.
            opacity: Neutral layer opacity.

        Returns:
            Complete one-layer SLD containing the opacity as its title.
        """
        del style_name, style_environment, style_definition
        root = ElementTree.Element(
            f"{{{SLD_NAMESPACE}}}StyledLayerDescriptor",
            {"version": "1.0.0"},
        )
        named_layer = ElementTree.SubElement(
            root,
            f"{{{SLD_NAMESPACE}}}NamedLayer",
        )
        ElementTree.SubElement(
            named_layer,
            f"{{{SLD_NAMESPACE}}}Name",
        ).text = layer_name
        ElementTree.SubElement(
            named_layer,
            f"{{{SLD_NAMESPACE}}}Title",
        ).text = str(opacity)
        return ElementTree.tostring(root, encoding="utf-8")


class _TestRegistry:
    """Authorize test layers through one shared policy."""

    def __init__(self) -> None:
        """Create a registry whose currentness can be changed by a test."""
        self.changed = False

    def require_current(self, layer_name: str) -> _TestAuthorization:
        """Authorize only names in the test workspace.

        Args:
            layer_name: Candidate workspace-qualified layer.

        Returns:
            Fixed test authorization.

        Raises:
            PublishedLayerNotAuthorizedError: If the layer is not a test layer.
            PublishedLayerChangedError: If the controlled source changed.
        """
        if not layer_name.startswith("eolab:test-"):
            raise PublishedLayerNotAuthorizedError("not a test layer")
        if self.changed:
            raise PublishedLayerChangedError("test layer changed")
        return _TestAuthorization()


def _plan_layer(layer_name: str, opacity: float) -> dict[str, object]:
    """Build one public test layer request.

    Args:
        layer_name: Workspace-qualified test identity.
        opacity: Neutral layer opacity.

    Returns:
        JSON-compatible generic vector-style plan entry.
    """
    return {
        "layerName": layer_name,
        "styleName": "test-style",
        "styleDefinition": {"test": True},
        "opacity": opacity,
    }


def _tile_url(
    wms_url: str,
    bbox: str = "0,0,256,256",
) -> str:
    """Build one valid public composite tile URL.

    Args:
        wms_url: Plan-specific public WMS route.
        bbox: Projected tile extent as four comma-separated numbers.

    Returns:
        Valid transparent EPSG:3857 tile URL.
    """
    return (
        f"{wms_url}?service=WMS&version=1.1.1&request=GetMap"
        "&layers=composite&styles=&srs=EPSG%3A3857"
        f"&bbox={bbox}&width=256&height=256"
        "&format=image%2Fpng&transparent=true"
    )


def test_composite_map_posts_one_bottom_first_get_map_document() -> None:
    """Render a top-first browser plan as one bottom-first GeoServer request."""
    forwarded_requests: list[httpx2.Request] = []

    def geoserver_response(request: httpx2.Request) -> httpx2.Response:
        """Capture one internal GeoServer POST and return a PNG.

        Args:
            request: Internal WMS request.

        Returns:
            Controlled transparent PNG response.
        """
        forwarded_requests.append(request)
        return httpx2.Response(
            200,
            content=b"composite png",
            headers={"Content-Type": "image/png", "Cache-Control": "max-age=30"},
        )

    tracker = GetMapRequestTracker(4)
    application = FastAPI()
    application.include_router(create_composite_map_router(
        CompositeMapRenderingService((_TestRegistry(),)),
        httpx2.AsyncClient(transport=httpx2.MockTransport(geoserver_response)),
        "http://geoserver:8080/geoserver",
        tracker,
    ))
    client = TestClient(application)
    plan_response = client.post("/api/map-rendering/plans", json={
        "layers": [
            _plan_layer("eolab:test-top", 0.75),
            _plan_layer("eolab:test-bottom", 0.25),
        ]
    })

    assert plan_response.status_code == 200
    plan = plan_response.json()
    tile_response = client.get(_tile_url(plan["wmsUrl"]))

    assert tile_response.status_code == 200
    assert tile_response.content == b"composite png"
    assert tile_response.headers["cache-control"] == "max-age=30"
    assert len(forwarded_requests) == 1
    assert forwarded_requests[0].method == "POST"
    request_root = ElementTree.fromstring(forwarded_requests[0].content)
    layer_names = [
        element.text
        for element in request_root.findall(
            f".//{{{SLD_NAMESPACE}}}NamedLayer/{{{SLD_NAMESPACE}}}Name"
        )
    ]
    assert layer_names == ["eolab:test-bottom", "eolab:test-top"]
    assert request_root.findtext(".//Width") == "256"
    assert request_root.findtext(".//Transparent") == "true"
    assert tracker.snapshot().completed == 1


def test_composite_map_caches_normalized_tiles_and_preserves_diagnostics() -> None:
    """Reuse equivalent tile coordinates while observing both public requests."""
    forwarded_requests: list[httpx2.Request] = []

    def geoserver_response(request: httpx2.Request) -> httpx2.Response:
        """Capture a cache miss and return one cacheable PNG.

        Args:
            request: Internal WMS request.

        Returns:
            Controlled cacheable PNG response.
        """
        forwarded_requests.append(request)
        return httpx2.Response(
            200,
            content=b"cached composite png",
            headers={
                "Content-Type": "image/png",
                "Cache-Control": "no-cache, no-store",
                "ETag": '"tile-version"',
            },
        )

    tracker = GetMapRequestTracker(4)
    application = FastAPI()
    application.include_router(create_composite_map_router(
        CompositeMapRenderingService((_TestRegistry(),)),
        httpx2.AsyncClient(transport=httpx2.MockTransport(geoserver_response)),
        "http://geoserver:8080/geoserver",
        tracker,
    ))
    client = TestClient(application)
    plan = client.post(
        "/api/map-rendering/plans",
        json={"layers": [_plan_layer("eolab:test-layer", 1)]},
    ).json()

    first_response = client.get(_tile_url(plan["wmsUrl"]))
    cached_response = client.get(
        _tile_url(plan["wmsUrl"], "0.0,0e0,256.00,2.56e2")
    )

    assert first_response.content == b"cached composite png"
    assert cached_response.content == first_response.content
    assert cached_response.headers["cache-control"] == "no-cache, no-store"
    assert cached_response.headers["etag"] == '"tile-version"'
    assert len(forwarded_requests) == 1
    assert tracker.snapshot().completed == 2


def test_composite_map_rechecks_currentness_before_a_cache_hit() -> None:
    """Reject a cached tile after its feature-owned source becomes stale."""
    forwarded_requests: list[httpx2.Request] = []

    def geoserver_response(request: httpx2.Request) -> httpx2.Response:
        """Capture the only permitted render.

        Args:
            request: Internal WMS request.

        Returns:
            Controlled cacheable PNG response.
        """
        forwarded_requests.append(request)
        return httpx2.Response(
            200,
            content=b"current tile",
            headers={"Content-Type": "image/png"},
        )

    registry = _TestRegistry()
    application = FastAPI()
    application.include_router(create_composite_map_router(
        CompositeMapRenderingService((registry,)),
        httpx2.AsyncClient(transport=httpx2.MockTransport(geoserver_response)),
        "http://geoserver:8080/geoserver",
        GetMapRequestTracker(2),
    ))
    client = TestClient(application)
    plan = client.post(
        "/api/map-rendering/plans",
        json={"layers": [_plan_layer("eolab:test-layer", 1)]},
    ).json()

    assert client.get(_tile_url(plan["wmsUrl"])).status_code == 200
    registry.changed = True
    stale_response = client.get(_tile_url(plan["wmsUrl"]))

    assert stale_response.status_code == 409
    assert stale_response.json()["detail"] == "test layer changed"
    assert len(forwarded_requests) == 1


@pytest.mark.parametrize(
    ("failure_status", "failure_content_type"),
    ((503, "text/plain"), (200, "text/plain")),
)
def test_composite_map_does_not_cache_failed_or_non_png_responses(
    failure_status: int,
    failure_content_type: str,
) -> None:
    """Retry a non-cacheable response and retain the later successful PNG.

    Args:
        failure_status: Controlled first upstream status.
        failure_content_type: Controlled first upstream media type.
    """
    request_count = 0

    def geoserver_response(_: httpx2.Request) -> httpx2.Response:
        """Return one non-cacheable response followed by cacheable PNGs.

        Args:
            _: Ignored internal WMS request.

        Returns:
            Response selected by the current request count.
        """
        nonlocal request_count
        request_count += 1
        if request_count == 1:
            return httpx2.Response(
                failure_status,
                content=b"not a tile",
                headers={"Content-Type": failure_content_type},
            )
        return httpx2.Response(
            200,
            content=b"successful tile",
            headers={"Content-Type": "image/png"},
        )

    application = FastAPI()
    application.include_router(create_composite_map_router(
        CompositeMapRenderingService((_TestRegistry(),)),
        httpx2.AsyncClient(transport=httpx2.MockTransport(geoserver_response)),
        "http://geoserver:8080/geoserver",
        GetMapRequestTracker(2),
    ))
    client = TestClient(application)
    plan = client.post(
        "/api/map-rendering/plans",
        json={"layers": [_plan_layer("eolab:test-layer", 1)]},
    ).json()
    tile_url = _tile_url(plan["wmsUrl"])

    assert client.get(tile_url).status_code == failure_status
    assert client.get(tile_url).content == b"successful tile"
    assert client.get(tile_url).content == b"successful tile"
    assert request_count == 2


def test_composite_map_evicts_least_recently_used_tiles_by_bytes() -> None:
    """Bound retained PNG and header bytes with deterministic LRU eviction."""
    requested_documents: list[bytes] = []

    def geoserver_response(request: httpx2.Request) -> httpx2.Response:
        """Capture each cache miss and return a fixed-size PNG.

        Args:
            request: Internal WMS request.

        Returns:
            Controlled 100-byte PNG response.
        """
        requested_documents.append(request.content)
        return httpx2.Response(
            200,
            content=b"x" * 100,
            headers={"Content-Type": "image/png"},
        )

    application = FastAPI()
    application.include_router(create_composite_map_router(
        CompositeMapRenderingService((_TestRegistry(),)),
        httpx2.AsyncClient(transport=httpx2.MockTransport(geoserver_response)),
        "http://geoserver:8080/geoserver",
        GetMapRequestTracker(2),
        maximum_tile_cache_bytes=300,
    ))
    client = TestClient(application)
    plan = client.post(
        "/api/map-rendering/plans",
        json={"layers": [_plan_layer("eolab:test-layer", 1)]},
    ).json()
    tile_a = _tile_url(plan["wmsUrl"], "0,0,256,256")
    tile_b = _tile_url(plan["wmsUrl"], "256,0,512,256")
    tile_c = _tile_url(plan["wmsUrl"], "512,0,768,256")

    for tile_url in (tile_a, tile_b, tile_a, tile_c, tile_b):
        assert client.get(tile_url).status_code == 200

    assert len(requested_documents) == 4


def test_composite_map_coalesces_misses_when_one_waiter_is_cancelled() -> None:
    """Preserve one shared render and its cache when another waiter leaves."""
    upstream_started = asyncio.Event()
    release_upstream = asyncio.Event()
    second_current_check = asyncio.Event()
    upstream_request_count = 0

    async def geoserver_response(_: httpx2.Request) -> httpx2.Response:
        """Hold one shared upstream render until cancellation is observed.

        Args:
            _: Ignored internal WMS request.

        Returns:
            Controlled cacheable PNG response.
        """
        nonlocal upstream_request_count
        upstream_request_count += 1
        upstream_started.set()
        await release_upstream.wait()
        return httpx2.Response(
            200,
            content=b"shared tile",
            headers={"Content-Type": "image/png"},
        )

    async def exercise_requests() -> None:
        """Cancel one route request while another shares its render.

        Returns:
            None after the remaining and cached requests complete.
        """
        service = CompositeMapRenderingService((_TestRegistry(),))
        original_require_current = service.require_current
        current_check_count = 0

        async def observed_require_current(
            plan_id: str,
        ) -> AuthorizedCompositeMapPlan:
            """Observe when the second tile request finishes authorization.

            Args:
                plan_id: Content-addressed plan identity.

            Returns:
                Current authorized plan.
            """
            nonlocal current_check_count
            plan = await original_require_current(plan_id)
            current_check_count += 1
            if current_check_count == 2:
                second_current_check.set()
            return plan

        service.require_current = observed_require_current  # type: ignore[method-assign]
        tracker = GetMapRequestTracker(2)
        application = FastAPI()
        application.include_router(create_composite_map_router(
            service,
            httpx2.AsyncClient(
                transport=httpx2.MockTransport(geoserver_response)
            ),
            "http://geoserver:8080/geoserver",
            tracker,
        ))
        async with httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=application),
            base_url="http://test",
        ) as client:
            plan = (await client.post(
                "/api/map-rendering/plans",
                json={"layers": [_plan_layer("eolab:test-layer", 1)]},
            )).json()
            tile_url = _tile_url(plan["wmsUrl"])
            first_waiter = asyncio.create_task(client.get(tile_url))
            await upstream_started.wait()
            second_waiter = asyncio.create_task(client.get(tile_url))
            await second_current_check.wait()
            await asyncio.sleep(0)

            first_waiter.cancel()
            with pytest.raises(asyncio.CancelledError):
                await first_waiter
            assert upstream_request_count == 1

            release_upstream.set()
            assert (await second_waiter).content == b"shared tile"
            assert (await client.get(tile_url)).content == b"shared tile"

        snapshot = tracker.snapshot()
        assert snapshot.completed == 3
        assert snapshot.recent_failures == 1

    asyncio.run(exercise_requests())
    assert upstream_request_count == 1


def test_composite_map_does_not_cache_a_cancelled_render() -> None:
    """Cancel unneeded upstream work and render the next request afresh."""
    upstream_started = asyncio.Event()
    upstream_cancelled = asyncio.Event()
    upstream_request_count = 0

    async def geoserver_response(_: httpx2.Request) -> httpx2.Response:
        """Block the first render and return a PNG for its replacement.

        Args:
            _: Ignored internal WMS request.

        Returns:
            Controlled cacheable PNG response for the replacement request.
        """
        nonlocal upstream_request_count
        upstream_request_count += 1
        if upstream_request_count == 1:
            upstream_started.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                upstream_cancelled.set()
                raise
        return httpx2.Response(
            200,
            content=b"replacement tile",
            headers={"Content-Type": "image/png"},
        )

    async def exercise_requests() -> None:
        """Cancel the sole owner before requesting and caching a replacement.

        Returns:
            None after the replacement is cached.
        """
        application = FastAPI()
        application.include_router(create_composite_map_router(
            CompositeMapRenderingService((_TestRegistry(),)),
            httpx2.AsyncClient(
                transport=httpx2.MockTransport(geoserver_response)
            ),
            "http://geoserver:8080/geoserver",
            GetMapRequestTracker(2),
        ))
        async with httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=application),
            base_url="http://test",
        ) as client:
            plan = (await client.post(
                "/api/map-rendering/plans",
                json={"layers": [_plan_layer("eolab:test-layer", 1)]},
            )).json()
            tile_url = _tile_url(plan["wmsUrl"])
            abandoned_request = asyncio.create_task(client.get(tile_url))
            await upstream_started.wait()

            abandoned_request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await abandoned_request
            await upstream_cancelled.wait()

            assert (await client.get(tile_url)).content == b"replacement tile"
            assert (await client.get(tile_url)).content == b"replacement tile"

    asyncio.run(exercise_requests())
    assert upstream_request_count == 2


def test_composite_map_rejects_unapproved_layers_before_rendering() -> None:
    """Do not create a plan for an arbitrary GeoServer layer name."""
    application = FastAPI()
    application.include_router(create_composite_map_router(
        CompositeMapRenderingService((_TestRegistry(),)),
        httpx2.AsyncClient(transport=httpx2.MockTransport(
            lambda request: httpx2.Response(500)
        )),
        "http://geoserver:8080/geoserver",
        GetMapRequestTracker(1),
    ))
    response = TestClient(application).post(
        "/api/map-rendering/plans",
        json={"layers": [_plan_layer("eolab:arbitrary", 1)]},
    )

    assert response.status_code == 400
    assert "approved" in response.json()["detail"]


def test_raster_composite_sld_preserves_stop_and_layer_opacity() -> None:
    """Apply neutral opacity outside the raster's three stop opacities."""
    authorization = PublishedRasterAuthorization(
        Path("prepared.tif"),
        RasterSourceIdentity(1, 2, 3, 4),
    )
    document = authorization.build_composite_sld(
        "eolab:prepared",
        "dynamic-raster",
        (
            "min:0;med:5;max:10;cmin:#000000;cmed:#888888;cmax:#ffffff;"
            "amin:0.1;amed:0.5;amax:0.9"
        ),
        None,
        0.4,
    )
    root = ElementTree.fromstring(document)

    assert root.findtext(f".//{{{SLD_NAMESPACE}}}Opacity") == "0.4"
    entries = root.findall(f".//{{{SLD_NAMESPACE}}}ColorMapEntry")
    assert [entry.attrib["opacity"] for entry in entries] == ["0.1", "0.5", "0.9"]


def test_vector_composite_sld_multiplies_symbol_opacity() -> None:
    """Apply neutral opacity without changing the authorized vector style."""
    style = default_vector_style("polygon")
    authorization = PublishedVectorAuthorization(
        source=object(),  # type: ignore[arg-type]
        source_signature=(),
        style_name="vector-polygon",
    )
    document = authorization.build_composite_sld(
        "eolab:polygon-item",
        "vector-polygon",
        None,
        style.model_dump(by_alias=True),
        0.5,
    )
    root = ElementTree.fromstring(document)
    css_parameters = {
        parameter.attrib["name"]: parameter.text
        for parameter in root.findall(f".//{{{SLD_NAMESPACE}}}CssParameter")
    }

    assert css_parameters["fill-opacity"] == "0.5"
    assert css_parameters["stroke-opacity"] == "0"
