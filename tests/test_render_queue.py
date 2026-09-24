"""Exercise rendering admission independently of GeoServer speed."""

import asyncio

import httpx2
import pytest

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


def test_duplicate_burst_uses_one_waiting_slot_and_cancels_individually() -> None:
    """A hundred identical requests share capacity without canceling one another."""

    async def scenario() -> None:
        """Hold the worker, fill its queue with duplicates, then release it."""
        queue = GeoServerRenderQueue(1, capacity=1)
        starts: list[str] = []
        blocker = ControlledRender("blocker", starts)
        shared = ControlledRender("shared", starts)
        other = ControlledRender("other", starts)
        active = asyncio.create_task(queue.run(blocker))
        await blocker.started.wait()
        duplicates = [
            asyncio.create_task(queue.run(shared, request_key="same tile"))
            for _ in range(100)
        ]
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        with pytest.raises(RenderQueueUnavailableError, match="busy"):
            await queue.run(other, request_key="different tile")
        duplicates[0].cancel()
        with pytest.raises(asyncio.CancelledError):
            await duplicates[0]
        blocker.release.set()
        await active
        await shared.started.wait()
        shared.release.set()
        responses = await asyncio.gather(*duplicates[1:])
        assert all(response.content == b"shared" for response in responses)
        assert starts == ["blocker", "shared"]
        # Completed results are not a new application-level tile cache.
        await queue.run(shared, request_key="same tile")
        assert starts == ["blocker", "shared", "shared"]
        await queue.close()

    asyncio.run(asyncio.wait_for(scenario(), 3))


def test_last_queued_caller_cancellation_frees_slot_for_new_work() -> None:
    """Removing every duplicate prevents dispatch and releases queue capacity."""

    async def scenario() -> None:
        """Cancel both queued callers and reuse their key before the worker frees."""
        queue = GeoServerRenderQueue(1, capacity=1)
        starts: list[str] = []
        blocker = ControlledRender("blocker", starts)
        abandoned = ControlledRender("abandoned", starts)
        replacement = ControlledRender("replacement", starts)
        active = asyncio.create_task(queue.run(blocker))
        await blocker.started.wait()
        callers = [
            asyncio.create_task(queue.run(abandoned, request_key="tile"))
            for _ in range(2)
        ]
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        for caller in callers:
            caller.cancel()
        await asyncio.gather(*callers, return_exceptions=True)
        fresh = asyncio.create_task(queue.run(replacement, request_key="tile"))
        blocker.release.set()
        await active
        await replacement.started.wait()
        replacement.release.set()
        await fresh
        assert starts == ["blocker", "replacement"]
        await queue.close()

    asyncio.run(asyncio.wait_for(scenario(), 3))


def test_late_caller_rejoins_abandoned_running_render() -> None:
    """A render keeps its identity and slot after its initial callers leave."""

    async def scenario() -> None:
        """Join the same running operation even when waiting capacity is zero."""
        queue = GeoServerRenderQueue(1, capacity=0)
        starts: list[str] = []
        render = ControlledRender("tile", starts)
        original = asyncio.create_task(queue.run(render, request_key="tile"))
        await render.started.wait()
        original.cancel()
        with pytest.raises(asyncio.CancelledError):
            await original
        late = asyncio.create_task(queue.run(render, request_key="tile"))
        await asyncio.sleep(0)
        assert not late.done()
        assert not render.cancelled
        render.release.set()
        assert (await late).content == b"tile"
        assert starts == ["tile"]
        await queue.close()

    asyncio.run(asyncio.wait_for(scenario(), 3))


@pytest.mark.parametrize("failure", ["queue_timeout", "execution_timeout", "shutdown"])
def test_shared_renders_release_all_callers_on_failure(failure: str) -> None:
    """Every caller observes the shared lifecycle failure; retries can start fresh.

    Args:
        failure: Queue lifecycle failure to exercise.
    """

    async def scenario() -> None:
        """Hold a render until its chosen deadline or shutdown interrupts it."""
        queue = GeoServerRenderQueue(
            1,
            wait_seconds=0.05 if failure == "queue_timeout" else 60,
            execution_seconds=0.05 if failure == "execution_timeout" else 30,
        )
        starts: list[str] = []
        blocker = ControlledRender("blocker", starts)
        render = ControlledRender("shared", starts)
        active = None
        if failure == "queue_timeout":
            active = asyncio.create_task(queue.run(blocker))
            await blocker.started.wait()
        callers = [
            asyncio.create_task(queue.run(render, request_key="tile"))
            for _ in range(2)
        ]
        if failure == "shutdown":
            await render.started.wait()
            await queue.close()
        outcomes = await asyncio.gather(*callers, return_exceptions=True)
        expected = {
            "queue_timeout": RenderQueueUnavailableError,
            "execution_timeout": RenderExecutionTimeoutError,
            "shutdown": asyncio.CancelledError,
        }[failure]
        assert all(isinstance(outcome, expected) for outcome in outcomes)
        if active is not None:
            blocker.release.set()
            await active
        if failure != "shutdown":
            render.release.set()
            assert (await queue.run(render, request_key="tile")).content == b"shared"
        await queue.close()

    asyncio.run(asyncio.wait_for(scenario(), 3))
