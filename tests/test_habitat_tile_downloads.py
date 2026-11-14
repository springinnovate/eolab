"""Exercise rolling Habitat downloads with controlled completion times."""

from collections import Counter
from collections.abc import Callable, Iterable, Iterator
from concurrent.futures import Future
from pathlib import Path
from threading import Event, Thread

from affine import Affine
from googleapiclient.errors import HttpError
from httplib2 import Response
import pytest
from rasterio.crs import CRS

from eolab_app.processing import habitat_tile_downloads as scheduler
from eolab_app.processing.habitat_tile_downloads import HabitatTileDownload
from eolab_app.processing.raster_preparation import RasterGrid


def _tiles(directory: Path, count: int) -> Iterator[HabitatTileDownload]:
    """Yield adjacent tile descriptors with their column as their test identity.

    Args:
        directory: Parent of the private cache-entry paths.
        count: Number of missing tiles to produce.

    Yields:
        Tile descriptors on a one-cell EPSG:6933 grid.
    """
    for index in range(count):
        yield HabitatTileDownload(
            index,
            RasterGrid(CRS.from_epsg(6933), Affine(1, 0, index, 0, -1, 1), 1, 1),
            directory / str(index),
        )


class DownloadSimulation:
    """Complete actual futures on a virtual clock instead of sleeping in threads."""

    def __init__(self) -> None:
        """Start an empty provider schedule with one-second successful requests."""
        self.now = 0.0
        self.durations: dict[tuple[int, int], float] = {}
        self.errors: dict[tuple[int, int], Exception] = {}
        self.attempts: Counter[int] = Counter()
        self.requests: dict[Future[bytes], tuple[float, int, int]] = {}
        self.started: list[tuple[int, int, float, int]] = []
        self.closed = False
        self.reverse_completions = False

    def submit(
        self, fetch: Callable[[RasterGrid], bytes], grid: RasterGrid
    ) -> Future[bytes]:
        """Schedule one response and record the number of concurrent requests.

        Args:
            fetch: Unused provider callback; configured results replace network I/O.
            grid: Tile whose western coordinate identifies its configured response.

        Returns:
            Future completed by the virtual wait operation.
        """
        index = int(grid.transform.c)
        self.attempts[index] += 1
        attempt = self.attempts[index]
        future: Future[bytes] = Future()
        duration = self.durations.get((index, attempt), 1.0)
        self.requests[future] = self.now + duration, index, attempt
        running = sum(not request.done() for request in self.requests)
        self.started.append((index, attempt, self.now, running))
        return future

    def wait(
        self, futures: Iterable[Future[bytes]], *, timeout: float, return_when: str
    ) -> tuple[list[Future[bytes]], set[Future[bytes]]]:
        """Advance to the next completion or poll deadline and settle its futures.

        Args:
            futures: Active requests currently owned by the scheduler.
            timeout: Maximum virtual wait until the next cancellation poll.
            return_when: Requested futures policy, expected to be FIRST_COMPLETED.

        Returns:
            Completed and still-pending requests at the new virtual time.
        """
        active = set(futures)
        assert return_when == scheduler.FIRST_COMPLETED
        self.now = min(
            self.now + timeout,
            max(self.now, min(self.requests[future][0] for future in active)),
        )
        for future in active:
            finish, index, attempt = self.requests[future]
            if not future.done() and finish <= self.now:
                error = self.errors.get((index, attempt))
                if error is None:
                    future.set_result(str(index).encode())
                else:
                    future.set_exception(error)
        done = {future for future in active if future.done()}
        ordered = sorted(
            done,
            key=lambda future: self.requests[future][1],
            reverse=self.reverse_completions,
        )
        return ordered, active - done

    def sleep(self, seconds: float) -> None:
        """Advance the idle clock by the scheduler's requested cooldown interval.

        Args:
            seconds: Nonnegative simulated delay.
        """
        assert seconds >= 0
        self.now += seconds

    def shutdown(self, *, wait: bool, cancel_futures: bool) -> None:
        """Record that the iterator retained the pool's draining shutdown contract.

        Args:
            wait: Whether shutdown waits for running requests.
            cancel_futures: Whether unstarted work should be cancelled.
        """
        assert wait and cancel_futures
        self.closed = True


@pytest.fixture
def simulation(monkeypatch: pytest.MonkeyPatch) -> DownloadSimulation:
    """Use a virtual provider for deterministic concurrency and cooldown checks.

    Args:
        monkeypatch: Replace only the scheduler's pool, wait and clock dependencies.

    Returns:
        Configurable virtual provider with a record of dispatched requests.
    """
    provider = DownloadSimulation()
    monkeypatch.setattr(scheduler, "ThreadPoolExecutor", lambda **_: provider)
    monkeypatch.setattr(scheduler, "wait", provider.wait)
    monkeypatch.setattr(scheduler, "monotonic", lambda: provider.now)
    monkeypatch.setattr(scheduler, "sleep", provider.sleep)
    monkeypatch.setattr(scheduler, "uniform", lambda start, end: start)
    return provider


def test_free_slots_are_refilled_while_a_slow_request_remains(
    tmp_path: Path, simulation: DownloadSimulation
) -> None:
    """Keep downloading beyond a slow member and reach, but never exceed, eight slots.

    Args:
        tmp_path: Cache-entry parent.
        simulation: Deterministic provider schedule and dispatch history.
    """
    simulation.durations[(2, 1)] = 40
    results = list(
        scheduler.download_habitat_tiles(_tiles(tmp_path, 50), bytes, lambda: None)
    )
    assert len(results) == 50
    assert {tile.index for tile, _ in results} == set(range(50))
    assert max(running for _, _, _, running in simulation.started) == 8
    assert next(start for index, _, start, _ in simulation.started if index == 4) == 3
    assert results[-1][0].index == 2
    assert simulation.closed


@pytest.mark.parametrize(
    ("same_time_success", "reverse_completions"),
    [(False, False), (True, False), (True, True)],
    ids=["inflight-above-reduced-width", "throttle-first", "success-first"],
)
def test_throttling_reduces_width_and_collects_successes_during_cooldown(
    tmp_path: Path,
    simulation: DownloadSimulation,
    same_time_success: bool,
    reverse_completions: bool,
) -> None:
    """Pause refill and retain responses while requests above the new limit drain.

    Args:
        tmp_path: Cache-entry parent.
        simulation: Virtual request outcomes and clock.
        same_time_success: Complete one success alongside the throttled response.
        reverse_completions: Consume the success before the simultaneous throttle.
    """
    simulation.reverse_completions = reverse_completions
    simulation.errors[(7, 1)] = HttpError(
        Response({"status": "429", "retry-after": "7"}), b"limited"
    )
    simulation.durations[(8, 1)] = 1 if same_time_success else 16
    simulation.durations[(9, 1)] = 2
    simulation.durations[(10, 1)] = 26
    completed: list[tuple[int, float]] = []
    for tile, result in scheduler.download_habitat_tiles(
        _tiles(tmp_path, 14), bytes, lambda: None
    ):
        assert not isinstance(result, Exception)
        completed.append((tile.index, simulation.now))
    # At t=4 four requests start; t=5 throttling cuts width to two. Existing
    # requests can exceed that new width until their own responses arrive.
    assert simulation.started[7:11] == [
        (index, 1, 4, index - 6) for index in range(7, 11)
    ]
    after_throttle = simulation.started[11:]
    expected_retry_time = 12 if same_time_success else 20
    index, attempt, started, running = after_throttle[0]
    assert (index, attempt, running) == (7, 2, 2)
    assert expected_retry_time <= started <= expected_retry_time + 0.100001
    assert all(start >= expected_retry_time for _, _, start, _ in after_throttle)
    assert (9, 6) in completed  # Publish a response during the cooldown.
    assert len(completed) == 14


def test_cached_retry_skips_cooldown_without_another_request(
    tmp_path: Path, simulation: DownloadSimulation
) -> None:
    """Reuse an entry published by another attempt while this attempt is cooling.

    Args:
        tmp_path: Cache-entry parent.
        simulation: Provider that throttles the first request.
    """
    simulation.errors[(0, 1)] = HttpError(
        Response({"status": "429", "retry-after": "30"}), b"limited"
    )

    def check_cancelled() -> None:
        """Simulate a concurrent cache publication after the throttled response."""
        if simulation.now >= 1:
            (tmp_path / "0").mkdir(exist_ok=True)

    results = list(
        scheduler.download_habitat_tiles(_tiles(tmp_path, 1), bytes, check_cancelled)
    )
    assert results[0][1] is None
    assert simulation.attempts == {0: 1}
    assert simulation.now == 1


def test_cancellation_waits_for_inflight_requests_before_iterator_exits(
    tmp_path: Path,
) -> None:
    """Retain pool ownership until the active request exits after cancellation.

    Args:
        tmp_path: Cache-entry parent.
    """
    started, release, cancelled, finished = Event(), Event(), Event(), Event()
    cancellation_observed = Event()
    observed: list[Exception] = []

    def fetch(grid: RasterGrid) -> bytes:
        """Hold the provider response until the test permits native completion.

        Args:
            grid: Selected request grid.

        Returns:
            Controlled tile payload after release.
        """
        started.set()
        assert release.wait(5)
        return b"tile"

    def check_cancelled() -> None:
        """Raise at the scheduler's next cancellation poll when requested.

        Raises:
            RuntimeError: The test requested cancellation.
        """
        if cancelled.is_set():
            cancellation_observed.set()
            raise RuntimeError("cancelled")

    def run() -> None:
        """Consume the iterator and record its cancellation after pool shutdown."""
        try:
            list(
                scheduler.download_habitat_tiles(
                    _tiles(tmp_path, 2), fetch, check_cancelled
                )
            )
        except RuntimeError as error:
            observed.append(error)
        finally:
            finished.set()

    consumer = Thread(target=run)
    consumer.start()
    try:
        assert started.wait(5)
        cancelled.set()
        assert cancellation_observed.wait(5)
        assert not finished.wait(0.1)
    finally:
        release.set()
        consumer.join(5)
    assert finished.is_set()
    assert len(observed) == 1 and str(observed[0]) == "cancelled"
