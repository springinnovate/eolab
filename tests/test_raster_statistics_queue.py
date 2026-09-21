"""Exercise histogram admission with controlled readers and real HTTP routes."""

import asyncio
import logging
import threading
from pathlib import Path

import pytest
import httpx2
from fastapi import FastAPI

from eolab_app.raster.errors import (
    RasterConflictError,
    RasterStatisticsCapacityError,
    RasterStatisticsQueueTimeoutError,
)
from eolab_app.raster.models import (
    CatalogRasterStatisticsRequest,
    CatalogRasterPairRequest,
)
from eolab_app.raster.statistics_service import RasterStatisticsService
from eolab_app.routes.raster_analysis import create_raster_analysis_router
from eolab_app.routes.raster_http import raster_http_exception
from eolab_app.settings import load_settings
from test_raster_statistics_service import (
    _PairSourceAuthorizer,
    _statistics,
    _paired_statistics,
)


def ordinary_request(index: int = 0) -> CatalogRasterStatisticsRequest:
    """Build a distinct box on the controlled X source.

    Args:
        index: Longitude of the western edge of a one-degree box.

    Returns:
        Validated ordinary request with a distinct sampling identity.
    """
    return CatalogRasterStatisticsRequest(
        collectionId="eolab-mounted-geotiffs",
        itemId="geotiff-0123456789abcdef01234567",
        selectedBounds={"west": index, "south": 0, "east": index + 1, "north": 1},
    )


def paired_request() -> CatalogRasterPairRequest:
    """Build the controlled raster pair.

    Returns:
        Validated request for X and Y over their whole overlap.
    """
    return CatalogRasterPairRequest(
        xRaster={
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-0123456789abcdef01234567",
        },
        yRaster={
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-abcdef0123456789abcdef01",
        },
    )


class ControlledReaders:
    """Hold native work to test FIFO ordering, cancellation, and shared capacity."""

    def __init__(self) -> None:
        """Create gates and record each native read's kind and cancellation check."""
        self.started = threading.Event()
        self.release = threading.Event()
        self.calls: list[str] = []

    def read(self, *args: object) -> object:
        """Block a normal or paired reader until released by the test.

        Args:
            args: Reader arguments; paired calls contain two paths and bounds.

        Returns:
            A valid result of the matching statistics type.

        Raises:
            AssertionError: If the test never releases the native reader.
        """
        paired = len(args) == 4
        self.calls.append("paired" if paired else "ordinary")
        self.started.set()
        assert self.release.wait(5)
        return _paired_statistics(1) if paired else _statistics(1)

    def service(self, **limits: object) -> RasterStatisticsService:
        """Create the real scheduler around the controlled source and readers.

        Args:
            limits: Queue and waiter configuration overrides for this scenario.

        Returns:
            A service with one native reader and a combined statistics cache.
        """
        return RasterStatisticsService(
            _PairSourceAuthorizer(Path(".")),
            1,
            8,
            statistics_reader=self.read,
            paired_statistics_reader=self.read,
            **limits,
        )


async def let_requests_join() -> None:
    """Allow authorization and admission tasks to run without releasing readers."""
    for _ in range(12):
        await asyncio.sleep(0)


@pytest.mark.parametrize("paired_first", [False, True])
def test_ordinary_and_paired_share_fifo_and_coalesce_queued_work(
    paired_first: bool, caplog: pytest.LogCaptureFixture
) -> None:
    """Queue both read types and let duplicate callers share one pending read.

    Args:
        paired_first: Which kind occupies the native reader first.
        caplog: Capture queue and read timing diagnostics.
    """
    readers = ControlledReaders()
    service = readers.service(queue_capacity=1)
    caplog.set_level(logging.INFO)

    async def exercise() -> None:
        """Hold the first request while duplicates join the next request."""
        ordinary = lambda: service.get(ordinary_request())
        paired = lambda: service.get_paired(paired_request())
        first, second = (paired, ordinary) if paired_first else (ordinary, paired)
        active = asyncio.create_task(first())
        assert await asyncio.to_thread(readers.started.wait, 2)
        queued = asyncio.create_task(second())
        duplicate = asyncio.create_task(second())
        await let_requests_join()
        assert not queued.done() and not duplicate.done()
        assert len(readers.calls) == 1
        with pytest.raises(RasterStatisticsCapacityError, match="queue is full"):
            await service.get(ordinary_request(2))
        queued.cancel()
        with pytest.raises(asyncio.CancelledError):
            await queued
        readers.release.set()
        await asyncio.gather(active, duplicate)
        assert await second() is duplicate.result()

    try:
        asyncio.run(exercise())
    finally:
        readers.release.set()
    assert readers.calls == (
        ["paired", "ordinary"] if paired_first else ["ordinary", "paired"]
    )
    assert "queue_wait_seconds=" in caplog.text and "read_seconds=" in caplog.text


def test_queued_cancellation_and_timeout_free_backlog_without_starting_reads() -> None:
    """Remove abandoned and expired requests while preserving the active reader."""
    readers = ControlledReaders()
    service = readers.service(queue_capacity=1, queue_wait_seconds=0.08)

    async def exercise() -> None:
        """Cancel one pending request and expire its replacement."""
        active = asyncio.create_task(service.get(ordinary_request()))
        assert await asyncio.to_thread(readers.started.wait, 2)
        pending = asyncio.create_task(service.get(ordinary_request(1)))
        await let_requests_join()
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
        with pytest.raises(RasterStatisticsQueueTimeoutError):
            await service.get_paired(paired_request())
        current = asyncio.create_task(service.get(ordinary_request(2)))
        await let_requests_join()
        assert readers.calls == ["ordinary"]
        assert not current.done()
        readers.release.set()
        await asyncio.gather(active, current)

    try:
        asyncio.run(exercise())
    finally:
        readers.release.set()
    assert readers.calls == ["ordinary", "ordinary"]


def test_canceled_active_identity_can_be_queued_again_without_overlapping_reads() -> (
    None
):
    """A new caller waits for the abandoned native read to exit before retrying."""
    readers = ControlledReaders()
    service = readers.service()

    async def exercise() -> None:
        """Cancel the final waiter and immediately request the same identity."""
        active = asyncio.create_task(service.get(ordinary_request()))
        assert await asyncio.to_thread(readers.started.wait, 2)
        active.cancel()
        with pytest.raises(asyncio.CancelledError):
            await active
        replacement = asyncio.create_task(service.get(ordinary_request()))
        await let_requests_join()
        assert not replacement.done() and len(readers.calls) == 1
        readers.release.set()
        await replacement
        assert await service.get(ordinary_request()) is replacement.result()

    try:
        asyncio.run(exercise())
    finally:
        readers.release.set()
    assert len(readers.calls) == 2


def test_duplicate_waiter_limit_does_not_block_cached_results() -> None:
    """Bound even identical callers, while cache hits bypass full read capacity."""
    readers = ControlledReaders()
    service = readers.service(queue_capacity=0, max_waiters=2)

    async def exercise() -> None:
        """Prime a cache entry, then fill the caller limit with a different read."""
        readers.release.set()
        cached = await service.get(ordinary_request())
        readers.release.clear()
        readers.started.clear()
        active = asyncio.create_task(service.get(ordinary_request(1)))
        assert await asyncio.to_thread(readers.started.wait, 2)
        duplicate = asyncio.create_task(service.get(ordinary_request(1)))
        await let_requests_join()
        with pytest.raises(RasterStatisticsCapacityError, match="Too many"):
            await service.get(ordinary_request(1))
        assert await service.get(ordinary_request()) is cached
        readers.release.set()
        await asyncio.gather(active, duplicate)

    try:
        asyncio.run(exercise())
    finally:
        readers.release.set()


@pytest.mark.parametrize("paired", [False, True])
def test_route_disconnect_removes_queued_histogram(paired: bool) -> None:
    """Use real routes and scheduler to abandon queued work on HTTP disconnect.

    Args:
        paired: Which route is waiting behind the controlled native read.
    """
    readers = ControlledReaders()
    service = readers.service(queue_capacity=1)
    app = FastAPI()
    app.include_router(create_raster_analysis_router(None, service))

    async def exercise() -> None:
        """Disconnect one independent HTTP client and admit its replacement."""
        active = asyncio.create_task(service.get(ordinary_request()))
        assert await asyncio.to_thread(readers.started.wait, 2)
        request = paired_request() if paired else ordinary_request(1)
        body = request.model_dump_json(by_alias=True, exclude_none=True).encode()
        endpoint = "paired-statistics" if paired else "statistics"
        messages = asyncio.Queue()
        await messages.put({"type": "http.request", "body": body, "more_body": False})
        responses: list[dict] = []

        async def send(message: dict) -> None:
            """Collect a response after the simulated disconnect.

            Args:
                message: ASGI response emitted by the application.
            """
            responses.append(message)

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": f"/api/raster-analysis/{endpoint}",
            "query_string": b"",
            "headers": [(b"content-type", b"application/json")],
        }
        route = asyncio.create_task(app(scope, messages.get, send))
        await let_requests_join()
        assert not route.done()
        await messages.put({"type": "http.disconnect"})
        await asyncio.wait_for(route, 2)
        assert (
            next(m["status"] for m in responses if m["type"] == "http.response.start")
            == 499
        )
        next_request = asyncio.create_task(service.get(ordinary_request(2)))
        await let_requests_join()
        readers.release.set()
        await asyncio.gather(active, next_request)

    try:
        asyncio.run(exercise())
    finally:
        readers.release.set()
    assert readers.calls == ["ordinary", "ordinary"]


def test_independent_http_clients_wait_and_receive_their_histograms() -> None:
    """A second browser can wait behind the first browser's read without retries."""
    readers = ControlledReaders()
    service = readers.service()
    app = FastAPI()
    app.include_router(create_raster_analysis_router(None, service))

    async def exercise() -> None:
        """Send requests through separate HTTP clients sharing the service."""
        async with (
            httpx2.AsyncClient(
                transport=httpx2.ASGITransport(app), base_url="http://test"
            ) as first,
            httpx2.AsyncClient(
                transport=httpx2.ASGITransport(app), base_url="http://test"
            ) as second,
        ):
            active = asyncio.create_task(
                first.post(
                    "/api/raster-analysis/statistics",
                    json=paired_request().x_raster.model_dump(by_alias=True),
                )
            )
            assert await asyncio.to_thread(readers.started.wait, 2)
            pending = asyncio.create_task(
                second.post(
                    "/api/raster-analysis/paired-statistics",
                    json=paired_request().model_dump(by_alias=True, exclude_none=True),
                )
            )
            await let_requests_join()
            assert not pending.done() and readers.calls == ["ordinary"]
            readers.release.set()
            ordinary, paired = await asyncio.gather(active, pending)
            assert ordinary.status_code == paired.status_code == 200
            assert (
                ordinary.json()["validSampleCount"]
                == paired.json()["pairedSampleCount"]
                == 1
            )

    try:
        asyncio.run(exercise())
    finally:
        readers.release.set()


def test_queue_timeout_has_explicit_http_error() -> None:
    """Expose an expired wait distinctly from true saturation and invalid areas."""
    error = raster_http_exception(RasterStatisticsQueueTimeoutError("Wait expired"))
    assert error.status_code == 503
    assert error.detail == {
        "code": "statistics_queue_timeout",
        "message": "Wait expired",
    }
    assert error.headers == {"Retry-After": "1"}


def test_fifo_survives_a_failed_read_and_a_canceled_middle_request() -> None:
    """Keep admission order when a reader fails and an intervening caller leaves."""
    readers = ControlledReaders()
    order: list[int] = []

    def read(path: Path, area: object, canceled: object) -> object:
        """Record each box and fail the first read after the queue is populated.

        Args:
            path: Controlled source path, unused by this fake.
            area: Normalized selected box whose west coordinate identifies it.
            canceled: Cancellation predicate, unused by this fake.

        Returns:
            A valid ordinary histogram for surviving queued reads.

        Raises:
            ValueError: For the first request, simulating an invalid raster read.
        """
        index = int(area.bounds[0])
        order.append(index)
        readers.started.set()
        assert readers.release.wait(5)
        if index == 0:
            raise ValueError("Controlled read failure")
        return _statistics(1)

    service = RasterStatisticsService(
        _PairSourceAuthorizer(Path(".")), 1, 8, statistics_reader=read
    )

    async def exercise() -> None:
        """Queue boxes in a known order and cancel one before releasing the reader."""
        active = asyncio.create_task(service.get(ordinary_request()))
        assert await asyncio.to_thread(readers.started.wait, 2)
        pending = []
        for index in (1, 2, 3):
            pending.append(asyncio.create_task(service.get(ordinary_request(index))))
            await let_requests_join()
        pending[1].cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending[1]
        readers.release.set()
        with pytest.raises(RasterConflictError, match="Controlled read failure"):
            await active
        await asyncio.gather(pending[0], pending[2])

    try:
        asyncio.run(exercise())
    finally:
        readers.release.set()
    assert order == [0, 1, 3]


def test_queue_configuration_defaults_and_overrides(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    version_file_path: Path,
) -> None:
    """Load separate reader, queue and caller settings from deployment variables.

    Args:
        configured_environment: Required application configuration fixture.
        monkeypatch: Override deployment environment variables.
        version_file_path: Temporary build version file.
    """
    defaults = load_settings(version_file_path)
    assert (
        defaults.raster_statistics_queue_capacity,
        defaults.raster_statistics_queue_wait_seconds,
        defaults.raster_statistics_max_waiters,
    ) == (32, 30, 256)
    monkeypatch.setenv("RASTER_STATISTICS_QUEUE_CAPACITY", "0")
    monkeypatch.setenv("RASTER_STATISTICS_QUEUE_WAIT_SECONDS", "2.5")
    monkeypatch.setenv("RASTER_STATISTICS_MAX_WAITERS", "7")
    settings = load_settings(version_file_path)
    assert (
        settings.raster_statistics_queue_capacity,
        settings.raster_statistics_queue_wait_seconds,
        settings.raster_statistics_max_waiters,
    ) == (0, 2.5, 7)
