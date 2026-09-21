"""Verify count waiting, cancellation, and overload through the Vector boundary."""

import asyncio
from collections.abc import Callable
from pathlib import Path
from threading import Event, Lock

import httpx2
import pytest
from fastapi import FastAPI
from starlette.requests import Request

from eolab_app.routes.vectors import create_vector_feature
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.filters import VectorFilter, VectorFilterCount
from eolab_app.vector.models import ResolvedVectorSource
from eolab_app.vector.publication import VectorPublicationService
from tests.test_vector_filters import context, predicate, request_for


class ControlledCountReader:
    """Hold native reads until the test releases them, recording concurrency."""

    def __init__(self) -> None:
        """Create a blocked reader with no requests started."""
        self.release = Event()
        self.lock = Lock()
        self.active = 0
        self.maximum_active = 0
        self.calls: list[int] = []
        self.cancellations: list[Event] = []
        self.result = VectorFilterCount(matched=5, total=8, complete=True)
        self.failure: Exception | None = None

    def count_filter(
        self,
        source: ResolvedVectorSource,
        candidate: VectorFilter,
        feature_limit: int,
        cancel_event: Event,
    ) -> VectorFilterCount:
        """Model a read that retains capacity until native code returns.

        Args:
            source: Authorized mounted fixture source.
            candidate: Filter whose scalar value identifies the test request.
            feature_limit: Maximum rows the service allows a reader to scan.
            cancel_event: Cooperative cancellation, which does not end this fake read.

        Returns:
            The configured exact or unavailable count.

        Raises:
            Exception: A configured reader failure.
            AssertionError: If a read is unbounded or test cleanup never releases it.
        """
        assert source.source_path and feature_limit == 1_000_000
        with self.lock:
            self.calls.append(candidate.rules[0].value)
            self.cancellations.append(cancel_event)
            self.active += 1
            self.maximum_active = max(self.maximum_active, self.active)
        try:
            assert self.release.wait(5), "Test did not release the native reader"
            if self.failure:
                raise self.failure
            return self.result
        finally:
            with self.lock:
                self.active -= 1


async def wait_until(condition: Callable[[], bool]) -> None:
    """Wait briefly for a controlled reader or request to reach the test checkpoint.

    Args:
        condition: Predicate that becomes true when test work reaches the checkpoint.

    Raises:
        TimeoutError: If the checkpoint is never reached.
    """
    async with asyncio.timeout(3):
        while not condition():
            await asyncio.sleep(0.001)


def test_counts_wait_in_order_without_blocking_filters_or_cached_counts(
    tmp_path: Path,
) -> None:
    """Count six concurrent filters through HTTP using only two native readers.

    Args:
        tmp_path: Mounted fixture directory.
    """
    reader = ControlledCountReader()
    service, registry, item, _, _ = context(tmp_path, reader)
    app = FastAPI()
    app.include_router(create_vector_feature(None, service, None, registry).router)

    async def exercise() -> None:
        """Warm one cache entry, then queue a burst while rendering remains usable."""
        request = request_for(item, predicate(("score", "ge", 99)))
        reader.release.set()
        cached = await service.count_filter(request)
        reader.release.clear()
        reader.calls.clear()
        async with httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=app), base_url="http://app"
        ) as http:
            tasks = []
            try:
                for value in range(6):
                    body = request_for(
                        item, predicate(("score", "ge", value))
                    ).model_dump(by_alias=True)
                    tasks.append(
                        asyncio.create_task(
                            http.post("/api/vector-rendering/filter-counts", json=body)
                        )
                    )
                    await wait_until(
                        lambda: len(reader.calls) + service._waiting_filter_counts
                        == value + 1
                    )
                assert reader.calls == [0, 1]
                assert not any(task.done() for task in tasks)
                assert (
                    await asyncio.wait_for(service.count_filter(request), 1) == cached
                )
                assert await asyncio.wait_for(
                    service.count_filter(request_for(item, VectorFilter())), 1
                ) == VectorFilterCount(matched=8, total=8, complete=True)
                applied = await http.post("/api/vector-rendering/filters", json=body)
                assert applied.status_code == 200
                reader.release.set()
                responses = await asyncio.wait_for(asyncio.gather(*tasks), 3)
                assert all(
                    response.status_code == 200
                    and response.json() == cached.model_dump()
                    for response in responses
                )
                assert reader.calls == list(range(6))
                assert reader.maximum_active == 2
                assert service._waiting_filter_counts == 0
            finally:
                reader.release.set()
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

    asyncio.run(exercise())


def test_count_queue_full_and_timeout_are_distinct_http_failures(
    tmp_path: Path,
) -> None:
    """Keep queue overload separate from a successful but incomplete source read.

    Args:
        tmp_path: Mounted fixture directory.
    """
    reader = ControlledCountReader()
    service, registry, item, _, _ = context(tmp_path, reader)
    service._filter_count_queue_capacity = 1
    service._filter_count_queue_wait_seconds = 0.15
    app = FastAPI()
    app.include_router(create_vector_feature(None, service, None, registry).router)
    body = request_for(item, predicate(("score", "ge", 1))).model_dump(by_alias=True)

    async def exercise() -> None:
        """Fill active readers and the queue, observe both failures, then recover."""
        async with httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=app), base_url="http://app"
        ) as http:
            active = [
                asyncio.create_task(
                    http.post("/api/vector-rendering/filter-counts", json=body)
                )
                for _ in range(2)
            ]
            waiting = None
            try:
                await wait_until(lambda: reader.active == 2)
                waiting = asyncio.create_task(
                    http.post("/api/vector-rendering/filter-counts", json=body)
                )
                await wait_until(lambda: service._waiting_filter_counts == 1)
                rejected = await http.post(
                    "/api/vector-rendering/filter-counts", json=body
                )
                assert rejected.status_code == 429
                assert (
                    rejected.json()["detail"]["category"] == "filter_count_queue_full"
                )
                expired = await waiting
                assert expired.status_code == 503
                assert (
                    expired.json()["detail"]["category"] == "filter_count_queue_timeout"
                )
                assert (
                    rejected.headers["Retry-After"]
                    == expired.headers["Retry-After"]
                    == "2"
                )
                assert service._waiting_filter_counts == 0
                assert len(reader.calls) == 2
                reader.release.set()
                assert all(
                    response.status_code == 200
                    for response in await asyncio.gather(*active)
                )
                reader.result = VectorFilterCount()
                body["filter"]["rules"][0]["value"] = 2
                incomplete = await http.post(
                    "/api/vector-rendering/filter-counts", json=body
                )
                assert incomplete.status_code == 200
                assert incomplete.json() == {
                    "matched": None,
                    "total": None,
                    "complete": False,
                }
            finally:
                reader.release.set()
                for task in active + ([waiting] if waiting else []):
                    task.cancel()
                await asyncio.gather(*active, return_exceptions=True)

    asyncio.run(exercise())


def test_disconnect_removes_waiting_count_without_starting_a_read(
    tmp_path: Path,
) -> None:
    """Disconnect a queued HTTP owner and immediately reuse its waiting space.

    Args:
        tmp_path: Mounted fixture directory.
    """
    reader = ControlledCountReader()
    service, registry, item, _, _ = context(tmp_path, reader)
    service._filter_count_queue_capacity = 1
    router = create_vector_feature(None, service, None, registry).router
    endpoint = next(
        route.endpoint
        for route in router.routes
        if route.path.endswith("/filter-counts")
    )
    request = request_for(item, predicate(("score", "ge", 1)))

    async def exercise() -> None:
        """Cancel the route through ASGI disconnect, then finish another queued count."""
        from fastapi import HTTPException

        messages: asyncio.Queue[dict] = asyncio.Queue()
        active = [asyncio.create_task(service.count_filter(request)) for _ in range(2)]
        waiting = replacement = None
        try:
            await wait_until(lambda: reader.active == 2)
            waiting = asyncio.create_task(
                endpoint(request, Request({"type": "http"}, messages.get))
            )
            await wait_until(lambda: service._waiting_filter_counts == 1)
            await messages.put({"type": "http.disconnect"})
            with pytest.raises(HTTPException) as failure:
                await waiting
            assert failure.value.status_code == 499
            assert service._waiting_filter_counts == 0
            replacement = asyncio.create_task(service.count_filter(request))
            await wait_until(lambda: service._waiting_filter_counts == 1)
            assert len(reader.calls) == 2
            reader.release.set()
            assert (await replacement).complete
            assert all(result.complete for result in await asyncio.gather(*active))
            assert len(reader.calls) == 3
        finally:
            reader.release.set()
            tasks = active + [
                task for task in (waiting, replacement) if task is not None
            ]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    asyncio.run(exercise())


def test_reader_failure_releases_capacity_and_does_not_cache_partial_counts(
    tmp_path: Path,
) -> None:
    """A native failure does not consume a slot or leave a reusable result.

    Args:
        tmp_path: Mounted fixture directory.
    """
    reader = ControlledCountReader()
    reader.release.set()
    reader.failure = VectorConflictError("Source could not be read")
    service, _, item, _, _ = context(tmp_path, reader)
    request = request_for(item, predicate(("score", "ge", 1)))

    async def exercise() -> None:
        """Fail once, return incomplete once, then obtain a fresh exact count."""
        with pytest.raises(VectorConflictError, match="could not be read"):
            await service.count_filter(request)
        reader.failure = None
        reader.result = VectorFilterCount()
        assert await service.count_filter(request) == VectorFilterCount()
        reader.result = VectorFilterCount(matched=5, total=8, complete=True)
        assert (await service.count_filter(request)).complete
        assert len(reader.calls) == 3
        assert not service._filter_slots.locked()

    asyncio.run(exercise())


@pytest.mark.parametrize(
    "options",
    [
        {"filter_count_queue_capacity": -1},
        {"filter_count_queue_wait_seconds": 0},
        {"filter_count_queue_wait_seconds": float("inf")},
        {"filter_count_queue_wait_seconds": float("nan")},
    ],
)
def test_invalid_count_queue_limits(options: dict[str, float]) -> None:
    """Reject invalid admission configuration when constructing the service.

    Args:
        options: One invalid queue configuration.
    """
    with pytest.raises(ValueError, match="Filter count queue"):
        VectorPublicationService(None, None, None, None, **options)
