"""Exercise rendering admission independently of GeoServer speed."""

import asyncio
import json
import logging

import httpx2
import pytest


def test_queue_logs_duplicates_cancellation_and_upstream_timing(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Observe saturation without changing duplicate execution or cancellation rules."""
    caplog.set_level(logging.INFO, logger="eolab_app.rendering.render_queue")

    async def scenario() -> None:
        """Exercise waiting, rejection, cancellation and a completed cache hit."""
        queue = GeoServerRenderQueue(1, capacity=1)
        starts: list[str] = []
        first = ControlledRender("first", starts)
        second = ControlledRender("second", starts)
        active = asyncio.create_task(queue.run(first, tile_key="direct:abc"))
        await first.started.wait()
        waiting = asyncio.create_task(queue.run(second, tile_key="direct:abc"))
        await asyncio.sleep(0)
        with pytest.raises(RenderQueueUnavailableError, match="busy"):
            await queue.run(second, tile_key="direct:abc")
        waiting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiting
        active.cancel()
        with pytest.raises(asyncio.CancelledError):
            await active
        assert not first.cancelled
        first.release.set()
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        async def cache_hit() -> httpx2.Response:
            """Return a completed upstream cache hit.

            Returns:
                PNG response with its GeoWebCache result header.
            """
            return httpx2.Response(200, headers={"geowebcache-cache-result": "HIT"})

        await queue.run(cache_hit, tile_key="direct:abc")
        await queue.close()

    asyncio.run(asyncio.wait_for(scenario(), 3))
    events = [
        json.loads(record.getMessage().removeprefix("render_queue "))
        for record in caplog.records
        if record.name == "eolab_app.rendering.render_queue"
    ]
    rejected = next(event for event in events if event["event"] == "full")
    assert (rejected["waiting"], rejected["running"], rejected["same_tile"]) == (
        1,
        1,
        2,
    )
    assert any(event["event"] == "canceled_queued" for event in events)
    assert any(event["event"] == "canceled_running" for event in events)
    finished = [event for event in events if event["event"] == "finished"]
    assert len(finished) == 2
    assert finished[0]["caller_canceled"] is True
    assert finished[1]["cache"] == "HIT"
    assert finished[1]["same_tile"] == 0
    assert all(
        event["wait_seconds"] >= 0 and event["upstream_seconds"] >= 0
        for event in finished
    )


from eolab_app.rendering.render_queue import (
    GeoServerRenderQueue,
    RenderExecutionTimeoutError,
    RenderQueueUnavailableError,
)


class ControlledRender:
    """Hold a fake upstream response until the test releases it."""

    def __init__(self, name: str, starts: list[str]) -> None:
        """Create an observable request.

        Args:
            name: Identifier recorded on dispatch.
            starts: Shared dispatch-order log.
        """
        self.name = name
        self.starts = starts
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.cancelled = False

    async def __call__(self) -> httpx2.Response:
        """Wait for release and return a named PNG.

        Returns:
            Successful fake image response.

        Raises:
            asyncio.CancelledError: If shutdown or execution timeout interrupts.
        """
        self.starts.append(self.name)
        self.started.set()
        try:
            await self.release.wait()
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        return httpx2.Response(
            200,
            content=self.name.encode(),
            headers={
                "Content-Type": "image/png",
            },
        )


def test_fifo_capacity_and_queued_cancellation() -> None:
    """Reject excess work, remove a cancelled waiter, and preserve FIFO order."""

    async def scenario() -> None:
        """Run the queue through observable request completion."""
        queue = GeoServerRenderQueue(1, capacity=2)
        starts: list[str] = []
        first, removed, third, fourth = [
            ControlledRender(name, starts)
            for name in ("first", "removed", "third", "fourth")
        ]
        active = asyncio.create_task(queue.run(first))
        await first.started.wait()
        cancelled = asyncio.create_task(queue.run(removed))
        await asyncio.sleep(0)
        waiting = asyncio.create_task(queue.run(third))
        await asyncio.sleep(0)
        with pytest.raises(RenderQueueUnavailableError, match="busy"):
            await queue.run(fourth)
        cancelled.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cancelled
        replacement = asyncio.create_task(queue.run(fourth))
        await asyncio.sleep(0)
        first.release.set()
        await active
        await third.started.wait()
        assert starts == ["first", "third"]
        third.release.set()
        await waiting
        await fourth.started.wait()
        fourth.release.set()
        await replacement
        assert starts == ["first", "third", "fourth"]
        await queue.close()

    asyncio.run(asyncio.wait_for(scenario(), 3))


def test_cancelled_active_request_retains_capacity_until_response() -> None:
    """Do not send extra renders just because an active viewer disconnected."""

    async def scenario() -> None:
        """Keep one slot occupied while its abandoned response drains."""
        queue = GeoServerRenderQueue(1)
        starts: list[str] = []
        first = ControlledRender("abandoned", starts)
        second = ControlledRender("next", starts)
        active = asyncio.create_task(queue.run(first))
        await first.started.wait()
        active.cancel()
        with pytest.raises(asyncio.CancelledError):
            await active
        waiting = asyncio.create_task(queue.run(second))
        await asyncio.sleep(0)
        assert not first.cancelled
        assert not second.started.is_set()
        first.release.set()
        await second.started.wait()
        second.release.set()
        await waiting
        await queue.close()

    asyncio.run(asyncio.wait_for(scenario(), 3))


def test_wait_timeout_never_dispatches_expired_work() -> None:
    """Expire queued work without affecting the active render."""

    async def scenario() -> None:
        """Expire one waiter, then admit fresh work after capacity returns."""
        queue = GeoServerRenderQueue(1, wait_seconds=0.01)
        starts: list[str] = []
        first = ControlledRender("first", starts)
        expired = ControlledRender("expired", starts)
        active = asyncio.create_task(queue.run(first))
        await first.started.wait()
        with pytest.raises(RenderQueueUnavailableError, match="waited too long"):
            await queue.run(expired)
        first.release.set()
        await active
        assert starts == ["first"]
        expired.release.set()
        assert (await queue.run(expired)).content == b"expired"
        await queue.close()

    asyncio.run(asyncio.wait_for(scenario(), 3))


def test_execution_deadline_releases_capacity() -> None:
    """Bound a stuck response and allow the next request to run."""

    async def scenario() -> None:
        """Observe transport cancellation at the execution deadline."""
        queue = GeoServerRenderQueue(1, execution_seconds=0.01)
        starts: list[str] = []
        stuck = ControlledRender("stuck", starts)
        with pytest.raises(RenderExecutionTimeoutError):
            await queue.run(stuck)
        assert stuck.cancelled
        next_render = ControlledRender("next", starts)
        next_render.release.set()
        assert (await queue.run(next_render)).content == b"next"
        await queue.close()

    asyncio.run(asyncio.wait_for(scenario(), 3))


def test_shutdown_cancels_active_and_queued_work() -> None:
    """Shutdown leaves no queued dispatch or active HTTP operation behind."""

    async def scenario() -> None:
        """Close while an abandoned active request still holds its slot."""
        queue = GeoServerRenderQueue(1)
        starts: list[str] = []
        first, second = [ControlledRender(name, starts) for name in ("first", "second")]
        active = asyncio.create_task(queue.run(first))
        await first.started.wait()
        waiting = asyncio.create_task(queue.run(second))
        await asyncio.sleep(0)
        await queue.close()
        for task in (active, waiting):
            with pytest.raises(asyncio.CancelledError):
                await task
        assert first.cancelled
        assert not second.started.is_set()
        with pytest.raises(RenderQueueUnavailableError, match="shutting down"):
            await queue.run(second)

    asyncio.run(asyncio.wait_for(scenario(), 3))
