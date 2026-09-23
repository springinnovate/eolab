"""Bound the GeoServer renders sent by this application process."""

import asyncio
import itertools
import json
import logging
import math
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import httpx2

LOGGER = logging.getLogger(__name__)


@dataclass
class _RenderTiming:
    """Identify one queued request and retain its monotonic timing boundaries."""

    request_id: int
    tile_key: str
    queued_at: float
    started_at: float | None = None
    caller_canceled: bool = False


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
        self._request_ids = itertools.count(1)
        self._observations: dict[int, _RenderTiming] = {}

    async def run(
        self,
        request: Callable[[], Awaitable[httpx2.Response]],
        *,
        tile_key: str = "unspecified",
    ) -> httpx2.Response:
        """Wait for capacity, then send one deferred GeoServer request.

        Args:
            request: Authorized HTTP operation, created only after admission.
            tile_key: Opaque diagnostic identity supplied by the owning route;
                it does not affect admission, ordering, or result sharing.

        Returns:
            Completed upstream response, including non-success responses.

        Raises:
            RenderQueueUnavailableError: If closed, full, or the wait expires.
            RenderExecutionTimeoutError: If the upstream deadline expires.
            httpx2.RequestError: If the upstream HTTP transport fails.
            asyncio.CancelledError: If the caller cancels or the queue closes.
        """
        timing = _RenderTiming(next(self._request_ids), tile_key, time.perf_counter())
        if self._closed:
            self._log_request("closed", timing)
            raise RenderQueueUnavailableError("Map rendering is shutting down")
        if self._slots.locked() and len(self._waiting) >= self._capacity:
            self._log_request("full", timing)
            raise RenderQueueUnavailableError(
                "Map rendering is busy; try again shortly"
            )
        caller = asyncio.current_task()
        if caller is None:
            raise RuntimeError("Render requests require an asyncio task")
        self._waiting.add(caller)
        self._observations[timing.request_id] = timing
        self._log_request("queued", timing)
        try:
            try:
                async with asyncio.timeout(self._wait_seconds):
                    await self._slots.acquire()
            except TimeoutError as error:
                self._log_request("queue_timeout", timing)
                self._observations.pop(timing.request_id)
                raise RenderQueueUnavailableError(
                    "Map rendering waited too long for capacity; try again"
                ) from error
            except asyncio.CancelledError:
                timing.caller_canceled = True
                self._log_request("canceled_queued", timing)
                self._observations.pop(timing.request_id)
                raise
        finally:
            self._waiting.discard(caller)
        timing.started_at = time.perf_counter()
        operation = asyncio.create_task(self._send_request(request, timing))
        self._running.add(operation)
        operation.add_done_callback(self._finish_request)
        self._log_request("started", timing)
        try:
            return await asyncio.shield(operation)
        except asyncio.CancelledError:
            timing.caller_canceled = True
            self._log_request("canceled_running", timing)
            raise

    async def _send_request(
        self,
        request: Callable[[], Awaitable[httpx2.Response]],
        timing: _RenderTiming,
    ) -> httpx2.Response:
        """Send a render with a wall-clock deadline after it gets a slot.

        Args:
            request: Deferred authorized upstream HTTP request.
            timing: Diagnostic identity and start time for this admitted render.

        Returns:
            Completed GeoServer response.

        Raises:
            RenderExecutionTimeoutError: If the execution deadline expires.
            httpx2.RequestError: If the HTTP request fails.
            asyncio.CancelledError: If application shutdown cancels the request.
        """
        try:
            async with asyncio.timeout(self._execution_seconds):
                response = await request()
                self._log_request("finished", timing, response=response)
                return response
        except TimeoutError as error:
            self._log_request("execution_timeout", timing)
            raise RenderExecutionTimeoutError(
                "Map rendering exceeded its time limit"
            ) from error
        except asyncio.CancelledError:
            self._log_request("execution_canceled", timing)
            raise
        except Exception as error:
            self._log_request("execution_error", timing, error=type(error).__name__)
            raise
        finally:
            self._observations.pop(timing.request_id, None)

    def _log_request(
        self,
        event: str,
        timing: _RenderTiming,
        *,
        response: httpx2.Response | None = None,
        error: str | None = None,
    ) -> None:
        """Log queue occupancy and timings without source URLs or credentials.

        Args:
            event: Queue or execution transition being observed.
            timing: Current request's opaque identity and timing boundaries.
            response: Completed upstream response, if available.
            error: Exception class name, without potentially sensitive text.

        Returns:
            None after emitting one structured diagnostic log record.
        """
        now = time.perf_counter()
        LOGGER.info(
            "render_queue %s",
            json.dumps(
                {
                    "event": event,
                    "request": timing.request_id,
                    "tile": timing.tile_key,
                    "waiting": len(self._waiting),
                    "running": len(self._running),
                    "capacity": self._capacity,
                    "same_tile": sum(
                        other.tile_key == timing.tile_key
                        for other in self._observations.values()
                        if other is not timing
                    ),
                    "wait_seconds": round(
                        (timing.started_at or now) - timing.queued_at, 6
                    ),
                    "upstream_seconds": (
                        None
                        if timing.started_at is None
                        else round(now - timing.started_at, 6)
                    ),
                    "caller_canceled": timing.caller_canceled,
                    "status": response.status_code if response is not None else None,
                    "cache": (
                        response.headers.get("geowebcache-cache-result")
                        if response is not None
                        else None
                    ),
                    "error": error,
                },
                separators=(",", ":"),
            ),
        )

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
