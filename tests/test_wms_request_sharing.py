"""Verify request sharing at the public WMS authorization and queue boundary."""

import asyncio
from collections.abc import Mapping

import httpx2
import pytest
from fastapi import FastAPI

from eolab_app.diagnostics.tracker import GetMapRequestTracker
from eolab_app.rendering.errors import PublishedLayerNotAuthorizedError
from eolab_app.rendering.render_queue import GeoServerRenderQueue
from eolab_app.routes.wms_proxy import create_wms_proxy_router

QUERY = {
    "service": "WMS",
    "request": "GetMap",
    "version": "1.3.0",
    "layers": "eolab:parcels",
    "styles": "vector-polygon",
    "bbox": "0,0,1,1",
    "crs": "EPSG:3857",
    "width": "256",
    "height": "256",
    "format": "image/png",
    "transparent": "true",
}


class TestLayerRegistry:
    """Model current layer authorization and server-owned filter translation."""

    __test__ = False
    style_name = "vector-polygon"

    def __init__(self) -> None:
        """Start with authorized layers and record every authorization lookup."""
        self.allowed = True
        self.lookups: list[str] = []

    def require_current(self, layer_name: str) -> "TestLayerRegistry":
        """Authorize each caller independently of outstanding render work.

        Args:
            layer_name: Public layer identity supplied by this caller.

        Returns:
            This controlled layer policy.

        Raises:
            PublishedLayerNotAuthorizedError: When the test revokes authorization.
        """
        self.lookups.append(layer_name)
        if not self.allowed:
            raise PublishedLayerNotAuthorizedError("Layer no longer authorized")
        return self

    def validate_parameters(self, operation: str, query: Mapping[str, str]) -> None:
        """Allow rendering variations after the real public WMS validation.

        Args:
            operation: Validated operation name.
            query: Parameters accepted by the public request boundary.

        Returns:
            None; this fixture imposes no additional layer-specific restrictions.
        """

    def prepare_query(
        self,
        operation: str,
        query: list[tuple[str, str]],
    ) -> list[tuple[str, str]]:
        """Translate filtered view identities onto one physical layer.

        Args:
            operation: Validated operation name.
            query: Authorized public query entries.

        Returns:
            Upstream entries, including the server-owned predicate when filtered.
        """
        normalized = {key.lower(): value for key, value in query}
        layer = normalized["layers"]
        if layer.startswith("eolab:filtered-"):
            return [
                (key, "eolab:parcels" if key.lower() == "layers" else value)
                for key, value in query
            ] + [("cql_filter", f"name = '{layer}'")]
        return query


class WmsSharingFixture:
    """Exercise real WMS routes and scheduling while controlling GeoServer latency."""

    def __init__(self) -> None:
        """Create a one-slot queue with one waiting position and a held transport."""
        self.registry = TestLayerRegistry()
        self.tracker = GetMapRequestTracker(1)
        self.queue = GeoServerRenderQueue(1, capacity=1)
        self.release = asyncio.Event()
        self.started = asyncio.Event()
        self.requests: list[httpx2.Request] = []
        self.status_code = 200
        self.upstream = httpx2.AsyncClient(transport=httpx2.MockTransport(self.render))
        app = FastAPI()
        app.include_router(
            create_wms_proxy_router(
                self.upstream,
                "http://geoserver/geoserver",
                (self.registry,),
                self.tracker,
                self.queue,
            )
        )
        self.client = httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=app),
            base_url="http://testserver",
        )

    async def render(self, request: httpx2.Request) -> httpx2.Response:
        """Hold one upstream response so other callers can join or queue.

        Args:
            request: Validated upstream GetMap request.

        Returns:
            Controlled response echoing its complete URL and headers.

        Raises:
            httpx2.ConnectError: When status_code is zero to simulate transport failure.
        """
        self.requests.append(request)
        self.started.set()
        await self.release.wait()
        if self.status_code == 0:
            raise httpx2.ConnectError("GeoServer disconnected", request=request)
        return httpx2.Response(
            self.status_code,
            content=(str(request.url) + str(sorted(request.headers.items()))).encode(),
            headers={"Content-Type": "image/png"},
        )

    async def wait_for_callers(self, count: int) -> None:
        """Wait until callers have passed authorization and reached rendering.

        Args:
            count: Number of outstanding HTTP requests to observe.

        Returns:
            None once the public diagnostic count reaches the requested value.
        """
        while self.tracker.snapshot().active < count:
            await asyncio.sleep(0)
        await asyncio.sleep(0)
        await asyncio.sleep(0)

    async def close(self) -> None:
        """Close the render queue and both clients after the scenario settles.

        Returns:
            None after all owned resources close.
        """
        await self.queue.close()
        await self.client.aclose()
        await self.upstream.aclose()


@pytest.mark.parametrize("status_code", [200, 503, 0])
def test_identical_wms_burst_shares_one_response(status_code: int) -> None:
    """One hundred authorized callers share a render, including upstream errors.

    Args:
        status_code: GeoServer response to share, or zero for a transport failure.
    """

    async def scenario() -> None:
        """Compare request count with the number of actual GeoServer operations."""
        fixture = WmsSharingFixture()
        fixture.status_code = status_code
        callers = [
            asyncio.create_task(
                fixture.client.get(
                    "/geoserver/eolab/wms",
                    params=QUERY,
                )
            )
            for _ in range(100)
        ]
        await fixture.wait_for_callers(100)
        await fixture.started.wait()
        assert len(fixture.requests) == 1
        assert len(fixture.registry.lookups) == 100
        fixture.release.set()
        responses = await asyncio.gather(*callers)
        expected_status = status_code or 502
        assert all(response.status_code == expected_status for response in responses)
        assert all(response.content == responses[0].content for response in responses)
        await fixture.client.get("/geoserver/eolab/wms", params=QUERY)
        assert len(fixture.requests) == 2  # Neither success nor failure is cached here.
        await fixture.close()

    asyncio.run(asyncio.wait_for(scenario(), 10))


@pytest.mark.parametrize(
    "changes",
    [
        {"layers": "eolab:other"},
        {"bbox": "1,1,2,2"},
        {"width": "512"},
        {"height": "512"},
        {"crs": "EPSG:4326"},
        {"srs": "EPSG:4326"},
        {"version": "1.1.1"},
        {"transparent": "false"},
        {"bgcolor": "0xff0000"},
        {"env": "color:red"},
        {"time": "2026-01-01"},
        {"elevation": "100"},
        {"tiled": "true"},
        {"tilesorigin": "0,0"},
        {"featureid": "parcels.2"},
        {"styles": "vector-highlight-polygon", "featureid": "parcels.1"},
        {"exceptions": "application/vnd.ogc.se_xml"},
    ],
)
def test_different_wms_parameters_do_not_share(changes: dict[str, str]) -> None:
    """Changing any supported rendering input creates distinct upstream work.

    Args:
        changes: Rendering parameter variations applied to the second caller.
    """
    asyncio.run(asyncio.wait_for(compare_two_requests(QUERY, QUERY | changes, 2), 5))


@pytest.mark.parametrize(
    "headers",
    [
        {"accept": "image/png"},
        {"x-forwarded-host": "other.example"},
        {"x-forwarded-proto": "https"},
        {"x-forwarded-port": "8443"},
    ],
)
def test_different_forwarded_headers_do_not_share(headers: dict[str, str]) -> None:
    """Response-affecting forwarded headers are part of the sharing identity.

    Args:
        headers: Header changes for the second caller.
    """
    asyncio.run(asyncio.wait_for(compare_two_requests(QUERY, QUERY, 2, headers), 5))


def test_query_order_and_parameter_name_case_share() -> None:
    """Equivalent parameter ordering and names share the same outstanding tile."""
    reordered = {key.upper(): value for key, value in reversed(QUERY.items())}
    asyncio.run(asyncio.wait_for(compare_two_requests(QUERY, reordered, 1), 5))


def test_server_owned_filters_do_not_share() -> None:
    """Filtered views of the same physical layer retain distinct predicates."""
    asyncio.run(
        asyncio.wait_for(
            compare_two_requests(
                QUERY | {"layers": "eolab:filtered-a"},
                QUERY | {"layers": "eolab:filtered-b"},
                2,
            ),
            5,
        )
    )


async def compare_two_requests(
    first: dict[str, str],
    second: dict[str, str],
    expected_renders: int,
    headers: dict[str, str] | None = None,
) -> None:
    """Send overlapping WMS requests and count independently rendered results.

    Args:
        first: First public WMS query.
        second: Second public WMS query.
        expected_renders: Number of distinct upstream requests expected.
        headers: Optional forwarded-header differences for the second request.

    Returns:
        None after checking dispatch count and response identity.
    """
    fixture = WmsSharingFixture()
    a = asyncio.create_task(fixture.client.get("/geoserver/eolab/wms", params=first))
    await fixture.started.wait()
    b = asyncio.create_task(
        fixture.client.get(
            "/geoserver/eolab/wms",
            params=second,
            headers=headers,
        )
    )
    await fixture.wait_for_callers(2)
    fixture.release.set()
    responses = await asyncio.gather(a, b)
    assert [response.status_code for response in responses] == [200, 200]
    assert len(fixture.requests) == expected_renders
    assert (responses[0].content == responses[1].content) == (expected_renders == 1)
    await fixture.close()


def test_authorization_cannot_be_bypassed_by_joining_existing_work() -> None:
    """A matching request cannot join after its layer authorization is revoked."""

    async def scenario() -> None:
        """Hold an authorized request while rejecting a subsequent identical one."""
        fixture = WmsSharingFixture()
        first = asyncio.create_task(
            fixture.client.get(
                "/geoserver/eolab/wms",
                params=QUERY,
            )
        )
        await fixture.started.wait()
        fixture.registry.allowed = False
        rejected = await fixture.client.get("/geoserver/eolab/wms", params=QUERY)
        assert rejected.status_code == 400
        assert len(fixture.registry.lookups) == 2
        fixture.release.set()
        assert (await first).status_code == 200
        assert len(fixture.requests) == 1
        await fixture.close()

    asyncio.run(asyncio.wait_for(scenario(), 5))
