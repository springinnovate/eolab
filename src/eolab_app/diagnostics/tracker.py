"""Bounded process-local tracking for public WMS GetMap requests."""

import time
from collections import deque
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass


RECENT_GET_MAP_LIMIT = 100


@dataclass(frozen=True)
class GetMapSnapshot:
    """One consistent snapshot of the in-process GetMap observations."""

    active: int
    concurrency_limit: int
    completed: int
    latest_seconds: float | None
    recent_failures: int
    recent_window_size: int
    latest_failed: bool


@dataclass
class _TrackedGetMap:
    """Mutable outcome owned by one tracker context."""

    succeeded: bool = False
    canceled: bool = False


class GetMapRequestTracker:
    """Track the bounded GetMap facts available at EOLab's proxy boundary."""

    def __init__(self, concurrency_limit: int) -> None:
        """Initialize a tracker with the effective GeoServer request limit.

        Args:
            concurrency_limit: Maximum simultaneous GetMap renders configured
                for GeoServer.

        Raises:
            ValueError: If the configured concurrency limit is not positive.
        """
        if concurrency_limit < 1:
            raise ValueError("GetMap concurrency limit must be greater than zero")
        self._concurrency_limit = concurrency_limit
        self._active = 0
        self._completed = 0
        self._latest_seconds: float | None = None
        self._recent_successes: deque[bool] = deque(maxlen=RECENT_GET_MAP_LIMIT)

    @contextmanager
    def track(self) -> Iterator[_TrackedGetMap]:
        """Record one valid GetMap request through its response or cancellation.

        Yields:
            Mutable request outcome for the WMS proxy to mark successful or
            canceled.
        """
        started_at = time.perf_counter()
        outcome = _TrackedGetMap()
        self._active += 1
        try:
            yield outcome
        finally:
            self._active -= 1
            if not outcome.canceled:
                self._completed += 1
                self._latest_seconds = time.perf_counter() - started_at
                self._recent_successes.append(outcome.succeeded)

    def snapshot(self) -> GetMapSnapshot:
        """Return the current request state without exposing request details.

        Returns:
            A consistent snapshot of active, completed, recent, and latest
            GetMap observations.
        """
        recent_window_size = len(self._recent_successes)
        return GetMapSnapshot(
            active=self._active,
            concurrency_limit=self._concurrency_limit,
            completed=self._completed,
            latest_seconds=self._latest_seconds,
            recent_failures=recent_window_size - sum(self._recent_successes),
            recent_window_size=recent_window_size,
            latest_failed=(
                bool(self._recent_successes) and not self._recent_successes[-1]
            ),
        )
