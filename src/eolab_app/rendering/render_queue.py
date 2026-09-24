"""Bound the GeoServer renders sent by this application process."""

import asyncio
import math
from collections.abc import Awaitable, Callable

import httpx2


class RenderQueueUnavailableError(Exception):
    """Report a full, expired, or closed map-rendering queue."""


class RenderExecutionTimeoutError(Exception):
    """Report that GeoServer did not finish within the execution deadline."""


class GeoServerRenderQueue:
    """Schedule distinct WMS requests in FIFO order across both tile routes.

    Composite callers coalesce identical tiles before entering this queue.
    Cancelling a queued caller removes its work. A started HTTP operation drains
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
        self._closed = False

    async def run(
        self,
        request: Callable[[], Awaitable[httpx2.Response]],
    ) -> httpx2.Response:
        """Wait for capacity, then send one deferred GeoServer request.

        Args:
            request: Authorized HTTP operation, created only after admission.

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
        tasks = tuple(self._waiting | self._running)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
