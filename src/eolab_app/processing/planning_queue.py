"""Cancellable Processing plan requests backed by the existing PostgreSQL store."""

import asyncio
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager, suppress
import logging
import time
from typing import Any, AsyncIterator

from eolab_app.processing.models import ProcessingError, ProcessingLimits
from eolab_app.processing.ports import JobStore

LOGGER = logging.getLogger(__name__)


class PlanningQueue:
    """Retain asynchronous plan requests and serialize their native preparation."""

    def __init__(self, store: JobStore, limits: ProcessingLimits) -> None:
        """Connect planning storage and the limits shared by both raster operations.

        Args:
            store: Processing's owner-scoped plan records and atomic planner claims.
            limits: Queue, execution and retention limits.
        """
        self.store = store
        self.limits = limits
        self.tasks: set[asyncio.Task[None]] = set()
        self.closed = False
        self.changed = asyncio.Event()

    async def start(
        self,
        identifier: str,
        owner: str,
        request: dict[str, Any],
        prepare: Callable[[float], Awaitable[dict[str, Any]]],
    ) -> dict[str, Any]:
        """Accept an idempotent request and return immediately with its current state.

        Args:
            identifier: Client-generated opaque ID reused after a lost response.
            owner: Browser-session hash.
            request: Validated operation and inputs used to detect conflicting retries.
            prepare: Preparation callback receiving record-admission time in seconds.

        Returns:
            Public planning snapshot. Work survives an admission HTTP disconnect.

        Raises:
            ProcessingError: If shutdown, capacity or conflicting input prevents admission.
        """
        if self.closed:
            raise ProcessingError(
                "planning_unavailable",
                "Planning is restarting. Try again shortly.",
                503,
            )
        started = time.perf_counter()
        created = await asyncio.to_thread(
            self.store.enqueue_plan, identifier, owner, request
        )
        if created:
            if self.closed:
                await asyncio.to_thread(
                    self.store.settle_planning,
                    identifier,
                    owner,
                    None,
                    {
                        "code": "planning_interrupted",
                        "detail": "Planning stopped during server shutdown. Start a new request.",
                    },
                )
                return await self.get(identifier, owner)
            reservation_seconds = time.perf_counter() - started
            task = asyncio.create_task(
                self._prepare(identifier, owner, lambda: prepare(reservation_seconds))
            )
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)
        return await self.get(identifier, owner)

    async def get(self, identifier: str, owner: str) -> dict[str, Any]:
        """Return authoritative status without exposing stored source inputs.

        Args:
            identifier: Opaque planning ID.
            owner: Current browser-session hash.

        Returns:
            Status, completed plan and sanitized error for this owner only.

        Raises:
            ProcessingError: If the request expired, is not owned, or storage fails.
        """
        row = await asyncio.to_thread(self.store.get_planning, identifier, owner)
        return {
            "planId": identifier,
            "status": row["state"],
            "result": row["result"],
            "error": row["error"],
        }

    async def _watch_cancellation(self, identifier: str, owner: str) -> None:
        """Wait until cancellation or an expired lease stops one admitted request.

        Args:
            identifier: Admitted plan ID.
            owner: Original session hash.

        Raises:
            ProcessingError: If the request failed or storage is unavailable.
        """
        while True:
            snapshot = await self.get(identifier, owner)
            if snapshot["status"] in {"cancelled", "cancelling", "failed"}:
                if snapshot["error"]:
                    raise ProcessingError(**snapshot["error"])
                return
            await asyncio.sleep(0.25)

    async def _prepare(
        self,
        identifier: str,
        owner: str,
        prepare: Callable[[], Awaitable[dict[str, Any]]],
    ) -> None:
        """Run preparation while observing cancellation, then publish its outcome.

        Args:
            identifier: Admitted plan ID.
            owner: Original session hash.
            prepare: The operation's bounded preparation routine.
        """
        operation = asyncio.create_task(prepare())
        cancellation = asyncio.create_task(self._watch_cancellation(identifier, owner))
        result = error = None
        try:
            async with asyncio.timeout(
                self.limits.plan_queue_seconds + 2 * self.limits.plan_timeout_seconds
            ):
                done, _ = await asyncio.wait(
                    (operation, cancellation), return_when=asyncio.FIRST_COMPLETED
                )
                if cancellation in done:
                    cancellation.result()
                else:
                    result = operation.result()
        except ProcessingError as failure:
            error = {
                "code": failure.code,
                "detail": failure.detail,
                "status": failure.status,
            }
        except asyncio.CancelledError:
            error = {
                "code": "planning_interrupted",
                "detail": "Planning stopped during server shutdown. Start a new request.",
            }
        except TimeoutError:
            error = {
                "code": "planning_timeout",
                "detail": "Planning exceeded its time limit. Try again.",
            }
        except Exception:
            LOGGER.exception("Processing plan preparation failed")
            error = {
                "code": "planning_failed",
                "detail": "Planning could not finish. Try again.",
            }
        finally:
            operation.cancel()
            cancellation.cancel()
            # The native runner joins a cancelled child before this gather returns.
            await asyncio.gather(operation, cancellation, return_exceptions=True)
            with suppress(ProcessingError):
                await asyncio.to_thread(
                    self.store.settle_planning, identifier, owner, result, error
                )
            self.changed.set()

    @asynccontextmanager
    async def native_planner(self, identifier: str, owner: str) -> AsyncIterator[float]:
        """Wait in FIFO order, then apply the native timeout only to active work.

        Args:
            identifier: Admitted, authorized cache-miss plan.
            owner: Original session hash.

        Yields:
            Seconds spent queued before acquiring the one native planner.

        Raises:
            ProcessingError: If queue wait expires or storage is unavailable.
            TimeoutError: If active preparation exceeds the native planning deadline.
        """
        started = time.perf_counter()
        await asyncio.to_thread(self.store.queue_native_plan, identifier, owner)
        while True:
            self.changed.clear()
            if await asyncio.to_thread(self.store.claim_native_plan, identifier, owner):
                break
            if time.perf_counter() - started >= self.limits.plan_queue_seconds:
                raise ProcessingError(
                    "plan_queue_timeout",
                    "Planning waited too long for a free worker. Try again.",
                    429,
                )
            with suppress(TimeoutError):
                await asyncio.wait_for(self.changed.wait(), 0.5)
        async with asyncio.timeout(self.limits.plan_timeout_seconds):
            yield time.perf_counter() - started

    async def wait(self, identifier: str, owner: str) -> dict[str, Any]:
        """Support existing synchronous plan clients using the same queue.

        Args:
            identifier: Admitted plan ID.
            owner: Original session hash.

        Returns:
            Completed operation plan in the existing response format.

        Raises:
            ProcessingError: If planning fails or is cancelled.
            asyncio.CancelledError: After requesting cleanup when HTTP disconnects.
        """
        try:
            while True:
                snapshot = await self.get(identifier, owner)
                if snapshot["status"] == "ready":
                    return snapshot["result"]
                if snapshot["error"]:
                    raise ProcessingError(**snapshot["error"])
                if snapshot["status"] == "cancelled":
                    raise ProcessingError(
                        "plan_cancelled", "Planning was cancelled.", 409
                    )
                await asyncio.sleep(0.05)
        except asyncio.CancelledError:
            await asyncio.shield(
                asyncio.to_thread(self.store.discard_plan, identifier, owner)
            )
            raise

    async def close(self) -> None:
        """Stop accepting plans and await native cleanup before application shutdown."""
        self.closed = True
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
