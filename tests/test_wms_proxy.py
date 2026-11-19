"""Test the restricted public WMS proxy contract."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlencode

import httpx2
import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from starlette.types import Message, Scope

from eolab_app.main import create_app
from eolab_app.rendering.render_queue import GeoServerRenderQueue
from eolab_app.diagnostics.tracker import GetMapRequestTracker
from eolab_app.rendering.errors import (
    PublishedLayerNotAuthorizedError,
    PublishedLayerRequestError,
)
from eolab_app.routes.wms_proxy import (
    MAX_FEATURE_INFO_RESPONSE_BYTES,
    create_wms_proxy_router,
)
from tests.app_support import (
    GeoServerPublicationMock,
    RASTER_STYLE_ENVIRONMENT_ERROR,
    TEST_GEOTIFF_ITEM_ID,
    VALID_GEOSERVER_METRICS,
    mounted_geotiff_item as _mounted_geotiff_item,
    write_geotiff as _write_geotiff,
)


class _NoRasterAuthorization:
    """Reject every data layer as an unapproved raster."""

    def require_current(self, layer_name: str) -> None:
        """Reject one candidate raster layer.

        Args:
            layer_name: Requested workspace-qualified layer name.

        Raises:
            PublishedLayerNotAuthorizedError: Always, because this registry is empty.
        """
        raise PublishedLayerNotAuthorizedError("not an approved raster")


class _FixedVectorAuthorization:
    """Authorize exactly one fixed-style vector layer."""

    def is_style_authorized(self, style_name: str) -> bool:
        """Accept the fixture's fixed appearance.

        Args:
            style_name: Requested style.

        Returns:
            Whether the style is approved.
        """
        return style_name == "vector-polygon"

    def require_current(self, layer_name: str) -> "_FixedVectorAuthorization":
        """Return the fixed vector authorization.

        Args:
            layer_name: Requested workspace-qualified layer name.

        Returns:
            Authorization exposing the fixed style name.

        Raises:
            PublishedLayerNotAuthorizedError: If a different layer is requested.
        """
        if layer_name != "eolab:parcels":
            raise PublishedLayerNotAuthorizedError("not an approved vector")
        return self

    def prepare_query(self, operation, query):
        """Forward validated fixed-style queries unchanged.

        Args:
            operation: Normalized WMS operation.
            query: Validated public query entries.

        Returns:
            Unmodified upstream entries.
        """
        return query

    def validate_parameters(
        self,
        operation: str,
        query: Mapping[str, str],
    ) -> None:
        """Reject dynamic substitutions for this fixed-style test layer.

        Args:
            operation: Normalized WMS operation.
            query: Normalized, globally bounded query parameters.

        Raises:
            PublishedLayerRequestError: If a dynamic environment is supplied.
        """
        del operation
        if "env" in query:
            raise PublishedLayerRequestError(
                "env is not supported for vector layers"
            )


def test_wms_proxy_drains_get_map_after_client_disconnect() -> None:
    """Return promptly on disconnect, retain the slot, and close on shutdown."""

    async def exercise_disconnect() -> tuple[
        list[dict[str, object]],
        bool,
        GetMapRequestTracker,
    ]:
        """Run one controlled GetMap request through an ASGI disconnect.

        Returns:
            Response messages, upstream cancellation state, and diagnostics
            tracker after cancellation.
        """
        upstream_started = asyncio.Event()
        upstream_canceled = asyncio.Event()

        async def geoserver_response(
            request: httpx2.Request,
        ) -> httpx2.Response:
            """Block the render until cancellation closes its operation.

            Args:
                request: Controlled internal GeoServer request.

            Raises:
                asyncio.CancelledError: When application shutdown closes the queue.
                AssertionError: If the controlled operation resumes normally.
            """
            del request
            upstream_started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                upstream_canceled.set()
                raise
            raise AssertionError("The controlled render must be canceled")

        tracker = GetMapRequestTracker(2)
        geoserver_client = httpx2.AsyncClient(
            transport=httpx2.MockTransport(geoserver_response)
        )
        render_queue = GeoServerRenderQueue(2)
        application = FastAPI()
        application.include_router(
            create_wms_proxy_router(
                geoserver_client,
                "http://geoserver:8080/geoserver",
                (_NoRasterAuthorization(), _FixedVectorAuthorization()),
                tracker,
                render_queue,
            )
        )
        query_string = (
            "service=WMS&version=1.3.0&request=GetMap"
            "&layers=eolab%3Aparcels&styles=vector-polygon"
            "&crs=EPSG%3A3857&bbox=0%2C0%2C1%2C1"
            "&width=256&height=256&format=image%2Fpng&transparent=true"
        ).encode()
        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/geoserver/eolab/wms",
            "raw_path": b"/geoserver/eolab/wms",
            "query_string": query_string,
            "headers": [(b"host", b"testserver")],
            "client": ("127.0.0.1", 12345),
            "server": ("testserver", 80),
            "root_path": "",
            "state": {},
        }
        request_messages: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        await request_messages.put(
            {"type": "http.request", "body": b"", "more_body": False}
        )
        response_messages: list[dict[str, object]] = []

        async def receive() -> dict[str, object]:
            """Return the next controlled request message.

            Returns:
                Initial empty request body or client-disconnect message.
            """
            return await request_messages.get()

        async def send(message: dict[str, object]) -> None:
            """Record one response message emitted by FastAPI.

            Args:
                message: ASGI response message emitted by the application.

            Returns:
                None.
            """
            response_messages.append(message)

        request_task = asyncio.create_task(application(scope, receive, send))
        await asyncio.wait_for(upstream_started.wait(), 1)
        await request_messages.put({"type": "http.disconnect"})
        await asyncio.wait_for(request_task, 1)
        assert not upstream_canceled.is_set()
        await render_queue.close()
        await geoserver_client.aclose()
        return response_messages, upstream_canceled.is_set(), tracker

    response_messages, upstream_canceled, tracker = asyncio.run(
        exercise_disconnect()
    )

    assert upstream_canceled is True
    assert next(
        message["status"]
        for message in response_messages
        if message["type"] == "http.response.start"
    ) == 499
    snapshot = tracker.snapshot()
    assert snapshot.active == 0
    assert snapshot.completed == 0
    assert snapshot.latest_seconds is None
    assert snapshot.recent_failures == 0
    assert snapshot.recent_window_size == 0



class _FeatureInspectionRequest:
    """Send one feature inspection through ASGI with an explicit disconnect."""

    def __init__(
        self, application: FastAPI, index: int = 0, *, owner: str = "allowed"
    ) -> None:
        """Start a distinct query without relying on a test client's cancellation.

        Args:
            application: Actual WMS router under test.
            index: Pixel coordinate distinguishing the upstream query.
            owner: Test-only authorization header checked by the source boundary.
        """
        self.messages: asyncio.Queue[Message] = asyncio.Queue()
        self.messages.put_nowait(
            {"type": "http.request", "body": b"", "more_body": False}
        )
        self.responses: list[Message] = []
        scope: Scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/geoserver/eolab/wms",
            "raw_path": b"/geoserver/eolab/wms",
            "query_string": (
                "service=WMS&version=1.3.0&request=GetFeatureInfo"
                "&layers=eolab:parcels&query_layers=eolab:parcels"
                "&styles=vector-polygon&crs=EPSG:3857&bbox=0,0,1,1"
                "&width=256&height=256&format=image/png"
                f"&info_format=application/json&i={index}&j=1"
            ).encode(),
            "headers": [(b"host", b"testserver"), (b"x-test-owner", owner.encode())],
            "client": ("127.0.0.1", 12345),
            "server": ("testserver", 80),
            "root_path": "",
            "state": {},
        }
        self.task = asyncio.create_task(
            application(scope, self.messages.get, self.send)
        )

    async def send(self, message: Message) -> None:
        """Record an HTTP response message.

        Args:
            message: ASGI output emitted by the actual route.
        """
        self.responses.append(message)

    def disconnect(self) -> None:
        """Tell the server that this browser no longer needs its query."""
        self.messages.put_nowait({"type": "http.disconnect"})

    async def response(self) -> tuple[int, dict[str, str]]:
        """Wait for completion and return the HTTP status and headers.

        Returns:
            Status and decoded headers from the ASGI response start.
        """
        await self.task
        start = next(
            message
            for message in self.responses
            if message["type"] == "http.response.start"
        )
        return start["status"], {
            key.decode(): value.decode() for key, value in start["headers"]
        }


def test_feature_inspection_disconnect_bounds_work_and_retains_source_leases() -> None:
    """Discard twelve users' superseded queries while started reads retain files."""

    async def scenario() -> None:
        """Exercise three pointer waves through real HTTP admission and leases."""
        started: list[int] = []
        leases: set[int] = set()
        both_started = asyncio.Event()
        released = asyncio.Event()
        release_upstream = asyncio.Event()
        tracker = GetMapRequestTracker(2)
        queue = GeoServerRenderQueue(2)

        @asynccontextmanager
        async def use_layers(
            names: tuple[str, ...], request: Request
        ) -> AsyncIterator[None]:
            """Track source retention until its admitted query actually finishes.

            Args:
                names: Authorized publication identities.
                request: HTTP query whose private source is retained.

            Yields:
                Control while the controlled upstream read owns the source.
            """
            assert names == ("eolab:parcels",)
            index = int(request.query_params["i"])
            leases.add(index)
            try:
                yield
            finally:
                leases.remove(index)
                if not leases:
                    released.set()

        async def upstream(request: httpx2.Request) -> httpx2.Response:
            """Hold the first two upstream responses until the test releases them.

            Args:
                request: Admitted GeoServer request.

            Returns:
                Small valid feature collection.
            """
            started.append(int(request.url.params["i"]))
            if len(started) == 2:
                both_started.set()
            await release_upstream.wait()
            return httpx2.Response(
                200, json={"type": "FeatureCollection", "features": []}
            )

        async with httpx2.AsyncClient(
            transport=httpx2.MockTransport(upstream)
        ) as client:
            application = FastAPI()
            application.include_router(
                create_wms_proxy_router(
                    client,
                    "http://geoserver/geoserver",
                    (_FixedVectorAuthorization(),),
                    tracker,
                    queue,
                    use_layers=use_layers,
                )
            )
            for wave in range(3):
                requests = [
                    _FeatureInspectionRequest(application, wave * 12 + user)
                    for user in range(12)
                ]
                if wave == 0:
                    await both_started.wait()
                for request in requests:
                    request.disconnect()
                responses = await asyncio.gather(
                    *(request.response() for request in requests)
                )
                assert all(status == 499 for status, _headers in responses)
                assert len(started) == len(leases) == 2
            assert tracker.snapshot().active == tracker.snapshot().completed == 0
            assert tracker.snapshot().recent_failures == 0
            release_upstream.set()
            await released.wait()
            assert not leases
            final_status, _headers = await _FeatureInspectionRequest(
                application, 100
            ).response()
            assert final_status == 200
            assert len(started) == 3
            await queue.close()

    asyncio.run(asyncio.wait_for(scenario(), 5))


def test_feature_inspection_authorizes_every_coalesced_caller() -> None:
    """Share identical authorized reads without granting private access to others."""

    async def scenario() -> None:
        """Hold one shared query while rejecting an unauthorized matching request."""
        started = asyncio.Event()
        release = asyncio.Event()
        starts = 0
        checks: list[str] = []
        second_admission = asyncio.Event()

        class ObservedQueue(GeoServerRenderQueue):
            """Expose admission at the public queue boundary without altering it."""

            async def run(
                self,
                request: Callable[[], Awaitable[httpx2.Response]],
                *,
                request_key: str | None = None,
            ) -> httpx2.Response:
                """Signal the second admitted caller before yielding to its read.

                Args:
                    request: Authorized deferred upstream operation.
                    request_key: Prepared query identity supplied by the route.

                Returns:
                    Response from the real shared queue.
                """
                if started.is_set():
                    second_admission.set()
                return await super().run(request, request_key=request_key)

        queue = ObservedQueue(1)

        async def authorize(names: tuple[str, ...], request: Request) -> bool:
            """Enforce independent source ownership before shared queue admission.

            Args:
                names: Requested publication identities.
                request: Browser request carrying the fixture owner.

            Returns:
                True to mark the authorized response private.

            Raises:
                HTTPException: When the fixture owner is not allowed access.
            """
            assert names == ("eolab:parcels",)
            owner = request.headers["x-test-owner"]
            checks.append(owner)
            if owner != "allowed":
                raise HTTPException(404, "This upload is unavailable.")
            return True

        async def upstream(request: httpx2.Request) -> httpx2.Response:
            """Count actual upstream operations while their callers overlap.

            Args:
                request: Authorized feature-info query.

            Returns:
                Valid private feature collection.
            """
            nonlocal starts
            assert request.url.params["request"] == "GetFeatureInfo"
            starts += 1
            started.set()
            await release.wait()
            return httpx2.Response(
                200, json={"type": "FeatureCollection", "features": []}
            )

        async with httpx2.AsyncClient(
            transport=httpx2.MockTransport(upstream)
        ) as client:
            application = FastAPI()
            application.include_router(
                create_wms_proxy_router(
                    client,
                    "http://geoserver/geoserver",
                    (_FixedVectorAuthorization(),),
                    GetMapRequestTracker(1),
                    queue,
                    authorize_layers=authorize,
                )
            )
            first = _FeatureInspectionRequest(application)
            await started.wait()
            second = _FeatureInspectionRequest(application)
            denied = _FeatureInspectionRequest(application, owner="other")
            assert (await denied.response())[0] == 404
            await second_admission.wait()
            first.disconnect()
            assert (await first.response())[0] == 499
            release.set()
            status, headers = await second.response()
            assert status == 200
            assert headers["cache-control"] == "private, no-store"
            assert checks == ["allowed", "allowed", "other"]
            assert starts == 1
            await queue.close()

    asyncio.run(asyncio.wait_for(scenario(), 5))


@pytest.mark.parametrize("failure", ("capacity", "queue-timeout", "execution-timeout"))
def test_feature_inspection_translates_admission_and_execution_failures(
    failure: str,
) -> None:
    """Return bounded retryable busy responses or the upstream execution deadline.

    Args:
        failure: Queue failure exercised through the actual HTTP route.
    """

    async def scenario() -> None:
        """Block an upstream request and observe the public failure response."""
        started = asyncio.Event()
        release = asyncio.Event()
        queue = GeoServerRenderQueue(
            1,
            capacity=0 if failure == "capacity" else 1,
            wait_seconds=0.02 if failure == "queue-timeout" else 1,
            execution_seconds=0.02 if failure == "execution-timeout" else 1,
        )

        async def upstream(request: httpx2.Request) -> httpx2.Response:
            """Wait for release or the queue's execution deadline.

            Args:
                request: Admitted GeoServer query.

            Returns:
                Valid feature collection after release.
            """
            del request
            started.set()
            await release.wait()
            return httpx2.Response(
                200, json={"type": "FeatureCollection", "features": []}
            )

        async with httpx2.AsyncClient(
            transport=httpx2.MockTransport(upstream)
        ) as client:
            application = FastAPI()
            application.include_router(
                create_wms_proxy_router(
                    client,
                    "http://geoserver/geoserver",
                    (_FixedVectorAuthorization(),),
                    GetMapRequestTracker(1),
                    queue,
                )
            )
            first = _FeatureInspectionRequest(application)
            await started.wait()
            failing = (
                first
                if failure == "execution-timeout"
                else _FeatureInspectionRequest(application, 1)
            )
            status, headers = await failing.response()
            assert status == (504 if failure == "execution-timeout" else 503)
            assert headers["cache-control"] == "private, no-store"
            if status == 503:
                assert headers["retry-after"] == "1"
                release.set()
                assert (await first.response())[0] == 200
            await queue.close()

    asyncio.run(asyncio.wait_for(scenario(), 5))


def test_wms_proxy_forwards_one_authorized_fixed_style_vector_layer() -> None:
    """Allow a bounded vector tile without accepting raster style controls."""
    forwarded_requests = []

    def geoserver_response(request: httpx2.Request) -> httpx2.Response:
        """Capture one exact forwarded WMS request.

        Args:
            request: Internal GeoServer WMS request.

        Returns:
            Controlled PNG response.
        """
        forwarded_requests.append(request)
        return httpx2.Response(
            200,
            content=b"vector png",
            headers={"Content-Type": "image/png"},
        )

    application = FastAPI()
    application.include_router(create_wms_proxy_router(
        httpx2.AsyncClient(transport=httpx2.MockTransport(geoserver_response)),
        "http://geoserver:8080/geoserver",
        (_NoRasterAuthorization(), _FixedVectorAuthorization()),
        GetMapRequestTracker(2),
        GeoServerRenderQueue(2),
    ))
    client = TestClient(application)
    query = (
        "?service=WMS&version=1.3.0&request=GetMap"
        "&layers=eolab%3Aparcels&styles=vector-polygon"
        "&crs=EPSG%3A3857&bbox=0%2C0%2C1%2C1"
        "&width=256&height=256&format=image%2Fpng&transparent=true"
    )

    response = client.get(f"/geoserver/eolab/wms{query}")
    highlight_response = client.get(
        f"/geoserver/eolab/wms{query.replace('vector-polygon', 'vector-highlight-polygon')}"
        "&featureid=parcels.42"
    )
    raster_style_response = client.get(
        f"/geoserver/eolab/wms{query.replace('vector-polygon', 'dynamic-raster')}"
    )
    env_response = client.get(
        f"/geoserver/eolab/wms{query}&env=min%3A0%3Bmed%3A1%3Bmax%3A2%3B"
        "cmin%3A%23000000%3Bcmed%3A%23888888%3Bcmax%3A%23ffffff"
        "%3Bamin%3A1%3Bamed%3A1%3Bamax%3A1"
    )
    unbounded_feature_response = client.get(
        "/geoserver/eolab/wms?service=WMS&version=1.3.0"
        "&request=GetFeatureInfo&layers=eolab%3Aparcels"
        "&query_layers=eolab%3Aparcels&styles=vector-polygon"
        "&crs=EPSG%3A3857&bbox=0%2C0%2C1%2C1"
        "&width=256&height=256&format=image%2Fpng"
        "&info_format=application%2Fjson&i=1&j=1&feature_count=100000"
    )

    assert response.status_code == 200
    assert response.content == b"vector png"
    assert highlight_response.status_code == 200
    assert len(forwarded_requests) == 2
    assert forwarded_requests[0].url.params.get_list("layers") == [
        "eolab:parcels"
    ]
    assert forwarded_requests[1].url.params["featureid"] == "parcels.42"
    assert forwarded_requests[1].url.params["styles"] == (
        "vector-highlight-polygon"
    )
    assert raster_style_response.status_code == 400
    assert raster_style_response.json() == {
        "detail": "WMS style is not authorized for this layer"
    }
    assert env_response.status_code == 400
    assert env_response.json() == {
        "detail": "env is not supported for vector layers"
    }
    assert unbounded_feature_response.status_code == 400
    assert unbounded_feature_response.json() == {
        "detail": "feature_count must be between 1 and 10"
    }


def test_wms_proxy_forwards_bounded_json_feature_information() -> None:
    """Authorize one small JSON feature response through the vector registry."""
    forwarded_requests = []
    feature_collection = b'{"type":"FeatureCollection","features":[]}'

    def geoserver_response(request: httpx2.Request) -> httpx2.Response:
        forwarded_requests.append(request)
        return httpx2.Response(
            200,
            content=feature_collection,
            headers={"Content-Type": "application/json;charset=UTF-8"},
        )

    application = FastAPI()
    application.include_router(create_wms_proxy_router(
        httpx2.AsyncClient(transport=httpx2.MockTransport(geoserver_response)),
        "http://geoserver:8080/geoserver",
        (_NoRasterAuthorization(), _FixedVectorAuthorization()),
        GetMapRequestTracker(2),
        GeoServerRenderQueue(2),
    ))
    response = TestClient(application).get(
        "/geoserver/eolab/wms?service=WMS&version=1.3.0"
        "&request=GetFeatureInfo&layers=eolab%3Aparcels"
        "&query_layers=eolab%3Aparcels&styles=vector-polygon"
        "&crs=EPSG%3A3857&bbox=0%2C0%2C1%2C1"
        "&width=256&height=256&format=image%2Fpng"
        "&info_format=application%2Fjson&i=1&j=1"
        "&feature_count=5&buffer=8"
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json;charset=UTF-8"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.content == feature_collection
    assert len(forwarded_requests) == 1
    assert forwarded_requests[0].url.params["feature_count"] == "5"
    assert forwarded_requests[0].url.params["buffer"] == "8"


@pytest.mark.parametrize(
    ("content", "content_type", "detail"),
    (
        (
            b"x" * (MAX_FEATURE_INFO_RESPONSE_BYTES + 1),
            "application/json",
            "The rendering service returned too much feature information",
        ),
        (
            b"<html>not JSON</html>",
            "text/html",
            "The rendering service returned invalid feature information",
        ),
    ),
    ids=("oversized-json", "invalid-content-type"),
)
def test_wms_proxy_rejects_unbounded_feature_information_response(
    content: bytes,
    content_type: str,
    detail: str,
) -> None:
    """Reject successful upstream feature responses outside the public contract."""

    def geoserver_response(request: httpx2.Request) -> httpx2.Response:
        del request
        return httpx2.Response(
            200,
            content=content,
            headers={"Content-Type": content_type},
        )

    application = FastAPI()
    application.include_router(create_wms_proxy_router(
        httpx2.AsyncClient(transport=httpx2.MockTransport(geoserver_response)),
        "http://geoserver:8080/geoserver",
        (_NoRasterAuthorization(), _FixedVectorAuthorization()),
        GetMapRequestTracker(2),
        GeoServerRenderQueue(2),
    ))
    response = TestClient(application).get(
        "/geoserver/eolab/wms?service=WMS&version=1.3.0"
        "&request=GetFeatureInfo&layers=eolab%3Aparcels"
        "&query_layers=eolab%3Aparcels&styles=vector-polygon"
        "&crs=EPSG%3A3857&bbox=0%2C0%2C1%2C1"
        "&width=256&height=256&format=image%2Fpng"
        "&info_format=application%2Fjson&i=1&j=1&feature_count=5"
    )

    assert response.status_code == 502
    assert response.json() == {"detail": detail}


def test_wms_proxy_forwards_supported_read_operation(
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Expose EOLab workspace WMS without exposing GeoServer itself."""

    def geoserver_response(request: httpx2.Request) -> httpx2.Response:
        assert request.method == "GET"
        assert "authorization" not in request.headers
        assert str(request.url) == (
            "http://geoserver:8080/geoserver/eolab/wms"
            "?service=WMS&version=1.3.0&request=GetCapabilities"
        )
        assert request.headers["x-forwarded-host"] == "testserver"
        assert request.headers["x-forwarded-proto"] == "http"
        return httpx2.Response(
            200,
            content=b'<WMS_Capabilities version="1.3.0"/>',
            headers={
                "Content-Type": "application/xml",
                "Cache-Control": "no-cache",
            },
        )

    response = TestClient(
        create_app(
            version_file_path,
            geoserver_transport=httpx2.MockTransport(geoserver_response),
        )
    ).get(
        "/geoserver/eolab/wms"
        "?service=WMS&version=1.3.0&request=GetCapabilities"
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/xml"
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.content == b'<WMS_Capabilities version="1.3.0"/>'


@pytest.mark.parametrize("style_environment", [
    None,
    "min:0;med:50;max:100;cmin:#2b83ba;cmed:#ffffbf;cmax:#d7191c;amin:0;amed:0.25;amax:1",
])
@pytest.mark.parametrize("style_name", ["dynamic-raster", "eolab:dynamic-raster"])
def test_wms_proxy_allows_bounded_png_rendering(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    version_file_path: Path,
    style_environment: str | None,
    style_name: str,
) -> None:
    """Allow tiles only after this app process approves the current source.

    Args:
        configured_environment: Applied baseline application environment.
        monkeypatch: Environment mutation fixture for the scan mount.
        tmp_path: Temporary directory containing the controlled raster.
        version_file_path: Baked application-version fixture path.
        style_environment: Full custom ramp, or None to request the named defaults.
        style_name: Accepted public style name, with or without its workspace.

    Returns:
        None.
    """

    source_path = tmp_path / "raster.tif"
    _write_geotiff(source_path)
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(tmp_path))
    monkeypatch.setenv("SCAN_PATHS_WITHIN_MOUNT", '["."]')
    item = _mounted_geotiff_item(source_path.as_uri())
    wms_requests = []
    publication_mock = GeoServerPublicationMock()

    def upstream_response(request: httpx2.Request) -> httpx2.Response:
        """Return the controlled catalog, publication, or WMS response.

        Args:
            request: Upstream request issued by the application.

        Returns:
            Catalog Item, publication state response, or WMS image response.

        Raises:
            AssertionError: If the proxied WMS request exceeds its contract.
        """
        if request.url.host == "stac-api":
            return httpx2.Response(200, json=item)
        if request.url.path.startswith((
            "/geoserver/rest/",
            "/geoserver/gwc/rest/",
        )):
            return publication_mock(request)
        wms_requests.append(request)
        assert request.url.params["request"] == "GetMap"
        assert request.url.params["styles"] == "eolab:dynamic-raster"
        assert request.url.params["format"] == "image/png"
        assert request.url.params["width"] == "256"
        assert request.url.params["height"] == "256"
        assert request.url.params.get("env") == style_environment
        if len(wms_requests) == 2:
            return httpx2.Response(
                200,
                content=b"<ServiceException>render failed</ServiceException>",
                headers={"Content-Type": "application/xml"},
            )
        return httpx2.Response(
            200,
            content=b"png bytes",
            headers={
                "Content-Type": "image/png",
                "GeoWebCache-Cache-Result": "MISS",
                "GeoWebCache-CRS": "EPSG:3857",
                "GeoWebCache-GridSet": "EPSG:3857",
                "X-Unsafe-Upstream": "private",
            },
        )

    def diagnostics_response(request: httpx2.Request) -> httpx2.Response:
        if request.url.port == 9404:
            return httpx2.Response(
                200,
                text=VALID_GEOSERVER_METRICS,
                headers={"content-type": "text/plain"},
            )
        return httpx2.Response(
            200,
            text="<WMS_Capabilities/>",
            headers={"content-type": "application/xml"},
        )

    with TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(upstream_response),
            geoserver_transport=httpx2.MockTransport(upstream_response),
            geoserver_diagnostics_transport=httpx2.MockTransport(
                diagnostics_response
            ),
        )
    ) as client:
        publication_response = client.post(
            "/api/rendering/layers",
            json={
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": TEST_GEOTIFF_ITEM_ID,
            },
        )
        tile_url = (
            "/geoserver/eolab/wms"
            "?service=WMS&version=1.3.0&request=GetMap"
            f"&layers=eolab%3A{TEST_GEOTIFF_ITEM_ID}"
            f"&styles={style_name}&crs=EPSG%3A3857"
            "&bbox=0%2C0%2C1%2C1&width=256&height=256"
            "&format=image%2Fpng&transparent=true"
            "&tiled=true&tilesorigin=-20037508.342789244%2C-20037508.342789244"
        )
        if style_environment is not None:
            tile_url += "&" + urlencode({"env": style_environment})
        response = client.get(tile_url)
        diagnostics = client.get("/api/rendering/diagnostics")
        exception_response = client.get(tile_url)
        failure_diagnostics = client.get("/api/rendering/diagnostics")
        wrong_style_response = client.get(
            tile_url.replace(f"styles={style_name}", "styles=expensive-style")
        )
        malformed_environment_response = client.get(
            f"{tile_url.partition('&env=')[0]}&env="
        )

    assert publication_response.status_code == 200
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["geowebcache-cache-result"] == "MISS"
    assert response.headers["geowebcache-crs"] == "EPSG:3857"
    assert response.headers["geowebcache-gridset"] == "EPSG:3857"
    assert "x-unsafe-upstream" not in response.headers
    assert response.content == b"png bytes"
    assert wms_requests[0].url.params["tiled"] == "true"
    assert wms_requests[0].url.params["tilesorigin"] == (
        "-20037508.342789244,-20037508.342789244"
    )
    assert len(wms_requests) == 2
    request_diagnostics = diagnostics.json()["metrics"]["requests"]
    assert request_diagnostics["latestGetMapSeconds"] >= 0
    assert request_diagnostics | {"latestGetMapSeconds": None} == {
        "activeGetMap": 0,
        "concurrencyLimit": 2,
        "completedGetMap": 1,
        "latestGetMapSeconds": None,
        "recentGetMapFailures": 0,
        "recentWindowSize": 1,
    }
    assert exception_response.status_code == 200
    assert exception_response.headers["content-type"] == "application/xml"
    assert wrong_style_response.status_code == 400
    assert wrong_style_response.json() == {
        "detail": "WMS style is not authorized for this layer"
    }
    assert malformed_environment_response.status_code == 400
    assert malformed_environment_response.json() == {
        "detail": RASTER_STYLE_ENVIRONMENT_ERROR
    }
    failure_document = failure_diagnostics.json()
    assert failure_document["state"] == "degraded"
    assert failure_document["metrics"]["requests"] | {"latestGetMapSeconds": None} == {
        "activeGetMap": 0,
        "concurrencyLimit": 2,
        "completedGetMap": 2,
        "latestGetMapSeconds": None,
        "recentGetMapFailures": 1,
        "recentWindowSize": 2,
    }


def test_wms_proxy_rejects_a_layer_not_approved_by_this_app_process(
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Keep layers persisted by an older deployment outside the public WMS."""
    geoserver_requests = []

    def geoserver_response(request: httpx2.Request) -> httpx2.Response:
        geoserver_requests.append(request)
        return httpx2.Response(500)

    response = TestClient(
        create_app(
            version_file_path,
            geoserver_transport=httpx2.MockTransport(geoserver_response),
        )
    ).get(
        "/geoserver/eolab/wms?service=WMS&request=GetMap"
        f"&layers=eolab%3A{TEST_GEOTIFF_ITEM_ID}"
        "&width=256&height=256&format=image%2Fpng"
    )

    assert response.status_code == 400
    assert response.json() == {
        "detail": "The WMS layer has not been approved for visualization"
    }
    assert geoserver_requests == []


@pytest.mark.parametrize(
    ("query", "detail"),
    (
        ("service=WFS&request=GetCapabilities", "service must be WMS"),
        ("service=WMS&request=DescribeLayer", "Unsupported WMS operation"),
        (
            "service=WMS&request=GetMap&sld=https://example.test/style.sld",
            "Unsupported WMS parameter: sld",
        ),
        (
            "service=WMS&request=GetMap&layers=eolab%3Afirst"
            "&LAYERS=eolab%3Asecond&format=image%2Fpng",
            "WMS parameters must not repeat",
        ),
        (
            "service=WMS&request=GetMap&layers=eolab%3Afirst%2Ceolab%3Asecond"
            "&format=image%2Fpng",
            "Exactly one WMS layer must be requested",
        ),
        (
            "service=WMS&request=GetFeatureInfo&layers=eolab%3Afirst"
            "&query_layers=eolab%3Asecond&info_format=application%2Fjson",
            "query_layers must match layers",
        ),
        (
            "service=WMS&request=GetLegendGraphic&format=image%2Fpng",
            "Exactly one WMS layer must be requested",
        ),
        (
            "service=WMS&request=GetMap&width=2049",
            "width must be between 1 and 2048",
        ),
        (
            "service=WMS&request=GetMap&format=application/openlayers",
            "WMS map and legend format must be image/png",
        ),
        (
            "service=WMS&request=GetMap&format=image%2Fpng"
            "&featureid=first.1%2Csecond.2",
            "featureid must identify exactly one safe feature",
        ),
        (
            "service=WMS&request=GetFeatureInfo&info_format=text/html",
            "WMS feature information format must be application/json",
        ),
        (
            "service=WMS&request=GetFeatureInfo&info_format=application%2Fjson"
            "&feature_count=1&buffer=21",
            "buffer must be between 0 and 20",
        ),
    ),
)
def test_wms_proxy_rejects_requests_outside_its_public_contract(
    configured_environment: None,
    version_file_path: Path,
    query: str,
    detail: str,
) -> None:
    """Reject non-WMS operations, remote styles, and oversized rendering."""
    response = TestClient(create_app(version_file_path)).get(
        f"/geoserver/eolab/wms?{query}"
    )

    assert response.status_code == 400
    assert response.json() == {"detail": detail}


@pytest.mark.parametrize("method", ["PUT", "PATCH", "DELETE"])
def test_wms_proxy_rejects_writes(
    configured_environment: None,
    version_file_path: Path,
    method: str,
) -> None:
    """Keep state-changing HTTP methods off the public rendering route.

    Args:
        configured_environment: Application settings fixture.
        version_file_path: Version file supplied to the application.
        method: Unsupported HTTP method.
    """
    response = TestClient(create_app(version_file_path)).request(
        method, "/geoserver/eolab/wms?service=WMS&request=GetCapabilities"
    )

    assert response.status_code == 405


@pytest.mark.parametrize("content,content_type,query,status", [
    (b"<GetMap/>", "application/xml", "", 415),
    (b"a=" + b"x" * (512 * 1024), "application/x-www-form-urlencoded", "", 413),
    (b"service=WMS&request=GetMap&layers=eolab:parcels", "application/x-www-form-urlencoded", "?layers=eolab:other", 400),
    (b"service=WMS&request=DeleteLayer", "application/x-www-form-urlencoded", "", 400),
    (b"service=WMS&request=GetMap&sld_body=arbitrary", "application/x-www-form-urlencoded", "", 400),
], ids=["xml", "oversized", "duplicate", "operation", "inline-xml"])
def test_wms_post_preserves_request_boundaries(
    configured_environment: None, version_file_path: Path,
    content: bytes, content_type: str, query: str, status: int,
) -> None:
    """Reject oversized, ambiguous or unsupported forms before contacting GeoServer.

    Args:
        configured_environment: Application settings fixture.
        version_file_path: Version file supplied to the application.
        content: Untrusted form or XML body.
        content_type: Submitted media type.
        query: Optional URL query parameters.
        status: Expected boundary rejection.
    """
    response = TestClient(create_app(version_file_path)).post(
        "/geoserver/eolab/wms" + query, content=content,
        headers={"Content-Type": content_type},
    )
    assert response.status_code == status


def test_unavailable_geoserver_does_not_change_app_health(
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Keep application liveness independent from rendering readiness."""

    def unavailable_geoserver(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("GeoServer unavailable", request=request)

    client = TestClient(
        create_app(
            version_file_path,
            geoserver_transport=httpx2.MockTransport(unavailable_geoserver),
        )
    )

    assert client.get("/healthz").status_code == 200
    response = client.get(
        "/geoserver/eolab/wms?service=WMS&request=GetCapabilities"
    )
    assert response.status_code == 502
    assert response.json() == {
        "detail": "The rendering service is unavailable"
    }
