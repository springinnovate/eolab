"""Bound the GeoServer renders sent by this application process."""

import asyncio
import math
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import httpx2


class RenderQueueUnavailableError(Exception):
    """Report a full, expired, or closed map-rendering queue."""


class RenderExecutionTimeoutError(Exception):
    """Report that GeoServer did not finish within the execution deadline."""


@dataclass
class _SharedRender:
    """Track a render's callers and whether it has reached GeoServer.

    Attributes:
        task: Shared queue wait and upstream response operation.
        callers: Requests still waiting for this result.
        started: Whether the render has acquired an upstream slot.
    """

    task: asyncio.Task[httpx2.Response]
    callers: int = 0
    started: bool = False


class GeoServerRenderQueue:
    """Schedule distinct WMS requests in FIFO order across both tile routes.

    Requests with the same caller-supplied key share one queued or running render.
    Composite callers also cache and coalesce tiles before entering this queue.
    Cancelling the last queued caller removes its work. A started operation drains
    to its response or deadline, retaining its slot even if its caller leaves:
    closing a connection does not establish that GeoServer stopped rendering.
    """

    def __init__(
        self,
        concurrency: int,
        capacity: int = 64,
        wait_seconds: float = 60,
        execution_seconds: float = 30,
    ) -> None:
        """Set process-local limits without changing GeoServer's own limits.

        Args:
            concurrency: Maximum simultaneous upstream GetMap requests.
            capacity: Additional distinct requests allowed to wait.
            wait_seconds: Maximum time waiting for an upstream slot.
            execution_seconds: Maximum time from dispatch through response body.

        Raises:
            ValueError: If capacity is negative or another limit is not positive
                and finite.
        """
        if concurrency < 1 or capacity < 0:
            raise ValueError(
                "Render concurrency must be positive and capacity nonnegative"
            )
        if any(
            not math.isfinite(value) or value <= 0
            for value in (
                wait_seconds,
                execution_seconds,
            )
        ):
            raise ValueError("Render deadlines must be positive and finite")
        self._slots = asyncio.Semaphore(concurrency)
        self._capacity = capacity
        self._wait_seconds = wait_seconds
        self._execution_seconds = execution_seconds
        self._waiting: set[asyncio.Task[object]] = set()
        self._running: set[asyncio.Task[httpx2.Response]] = set()
        self._shared: dict[str, _SharedRender] = {}
        self._closed = False

    async def run(
        self,
        request: Callable[[], Awaitable[httpx2.Response]],
        *,
        request_key: str | None = None,
    ) -> httpx2.Response:
        """Share an outstanding matching render or queue a new GeoServer request.

        Args:
            request: Authorized HTTP operation, created only after admission.
            request_key: Identity of the fully authorized upstream request,
                including representation-affecting parameters and headers.
                None gives this caller its own operation. Completed results
                are not cached. Each caller must authorize before joining.

        Returns:
            Completed upstream response, including non-success responses.

        Raises:
            RenderQueueUnavailableError: If closed, full, or the wait expires.
            RenderExecutionTimeoutError: If the upstream deadline expires.
            httpx2.RequestError: If the upstream HTTP transport fails.
            asyncio.CancelledError: If the caller cancels or the queue closes.
        """
        if self._closed:
            raise RenderQueueUnavailableError("Map rendering is shutting down")
        if request_key is None:
            return await self._wait_and_render(request)
        work = self._shared.get(request_key)
        if work is None or work.task.done():
            task = asyncio.create_task(self._wait_and_render(request, request_key))
            work = _SharedRender(task)
            self._shared[request_key] = work
            task.add_done_callback(
                lambda finished: self._forget_shared_render(request_key, finished)
            )
        work.callers += 1
        try:
            return await asyncio.shield(work.task)
        finally:
            work.callers -= 1
            if work.callers == 0 and not work.started and not work.task.done():
                if self._shared.get(request_key) is work:
                    del self._shared[request_key]
                work.task.cancel()
                await asyncio.gather(work.task, return_exceptions=True)

    def _forget_shared_render(
        self,
        request_key: str,
        task: asyncio.Task[httpx2.Response],
    ) -> None:
        """Remove finished shared work without removing a newer matching request.

        Args:
            request_key: Identity used to find the shared render.
            task: Completed operation, possibly with no remaining callers.

        Returns:
            None after releasing the key and retrieving abandoned errors.
        """
        work = self._shared.get(request_key)
        if work is not None and work.task is task:
            del self._shared[request_key]
        if not task.cancelled():
            task.exception()

    async def _wait_and_render(
        self,
        request: Callable[[], Awaitable[httpx2.Response]],
        request_key: str | None = None,
    ) -> httpx2.Response:
        """Acquire one slot and retain it until the upstream operation finishes.

        Args:
            request: Deferred authorized GeoServer request.
            request_key: Shared-work identity, or None for independent work.

        Returns:
            Completed upstream response, including error responses.

        Raises:
            RenderQueueUnavailableError: If closed, full, or the wait expires.
            RenderExecutionTimeoutError: If the upstream deadline expires.
            httpx2.RequestError: If the upstream transport fails.
            asyncio.CancelledError: If queued work is abandoned or shutdown occurs.
        """
        if self._closed:
            raise RenderQueueUnavailableError("Map rendering is shutting down")
        if self._slots.locked() and len(self._waiting) >= self._capacity:
            raise RenderQueueUnavailableError(
                "Map rendering is busy; try again shortly"
            )
        caller = asyncio.current_task()
        if caller is None:
            raise RuntimeError("Render requests require an asyncio task")
        self._waiting.add(caller)
        try:
            try:
                async with asyncio.timeout(self._wait_seconds):
                    await self._slots.acquire()
            except TimeoutError as error:
                raise RenderQueueUnavailableError(
                    "Map rendering waited too long for capacity; try again"
                ) from error
        finally:
            self._waiting.discard(caller)
        if request_key is not None:
            self._shared[request_key].started = True
        operation = asyncio.create_task(self._send_request(request))
        self._running.add(operation)
        operation.add_done_callback(self._finish_request)
        return await asyncio.shield(operation)

    async def _send_request(
        self,
        request: Callable[[], Awaitable[httpx2.Response]],
    ) -> httpx2.Response:
        """Send a render with a wall-clock deadline after it gets a slot.

        Args:
            request: Deferred authorized upstream HTTP request.

        Returns:
            Completed GeoServer response.

        Raises:
            RenderExecutionTimeoutError: If the execution deadline expires.
            httpx2.RequestError: If the HTTP request fails.
            asyncio.CancelledError: If application shutdown cancels the request.
        """
        try:
            async with asyncio.timeout(self._execution_seconds):
                return await request()
        except TimeoutError as error:
            raise RenderExecutionTimeoutError(
                "Map rendering exceeded its time limit"
            ) from error

    def _finish_request(self, operation: asyncio.Task[httpx2.Response]) -> None:
        """Release a finished render's slot and retrieve abandoned exceptions.

        Args:
            operation: Finished upstream request, possibly without a caller.

        Returns:
            None after releasing capacity for the next FIFO waiter.
        """
        self._running.discard(operation)
        self._slots.release()
        if not operation.cancelled():
            operation.exception()

    async def close(self) -> None:
        """Reject new work and cancel queued and active HTTP work on shutdown.

        Returns:
            None once every owned operation has settled.
        """
        self._closed = True
        tasks = tuple(
            self._waiting
            | self._running
            | {work.task for work in self._shared.values()}
        )
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
