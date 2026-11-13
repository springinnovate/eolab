"""Schedule missing Habitat tiles and slow Earth Engine requests on HTTP 429."""

from collections import deque
from collections.abc import Callable, Generator, Iterator
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from random import uniform
from time import monotonic, sleep

from googleapiclient.errors import HttpError

from eolab_app.processing.raster_preparation import RasterGrid

_MAX_CONCURRENT_TILES = 4
_SUCCESSES_TO_GROW = 2
_MAX_THROTTLE_RETRIES = 3
_CANCEL_CHECK_INTERVAL = 0.1


@dataclass(frozen=True)
class HabitatTileDownload:
    """Identify a missing tile without changing its scientific grid.

    Attributes:
        index: Position in the original ordered grid selection.
        grid: Exact georeferenced tile to request.
        entry: Persistent cache directory where the caller can publish the tile.
    """

    index: int
    grid: RasterGrid
    entry: Path


def get_provider_http_error(error: Exception) -> HttpError | None:
    """Find an HTTP error even when the Earth Engine SDK wraps it.

    Args:
        error: Exception from an Earth Engine request.

    Returns:
        HTTP error from the request, if the SDK retained one.
    """
    http_error = (
        error if isinstance(error, HttpError) else error.__cause__ or error.__context__
    )
    return http_error if isinstance(http_error, HttpError) else None


def _retry_after_seconds(error: HttpError) -> float:
    """Read the wait requested by Earth Engine in an HTTP Retry-After header.

    Args:
        error: Earth Engine response with status 429.

    Returns:
        Nonnegative delay in seconds, or zero if the header is absent or invalid.
    """
    value = error.resp.get("retry-after", "").strip()
    if value.isascii() and value.isdecimal() and len(value) <= 10:
        return float(value)
    try:
        date = parsedate_to_datetime(value)
        if date.tzinfo is None:
            date = date.replace(tzinfo=timezone.utc)
        return max(0.0, (date - datetime.now(timezone.utc)).total_seconds())
    except (ValueError, OverflowError):
        return 0.0


def _throttle_delay(retry_after: float, backoff: float) -> float:
    """Choose the longer of the provider's delay and local backoff with jitter.

    Args:
        retry_after: Provider's requested delay in seconds.
        backoff: Current exponential delay in seconds before adding jitter.

    Returns:
        Delay in seconds before another tile request can start.
    """
    return max(retry_after, uniform(backoff, min(30.0, 1.5 * backoff)))


def download_habitat_tiles(
    tiles: Iterator[HabitatTileDownload],
    fetch: Callable[[RasterGrid], bytes],
    check_cancelled: Callable[[], None],
) -> Generator[tuple[HabitatTileDownload, bytes | Exception | None], None, None]:
    """Download small groups of tiles and adjust the next group's request count.

    Start with one request. Grow after successful downloads and halve the group size
    after any 429. Wait for the active group and the cooldown before dispatching
    more requests. A repeatedly throttled tile eventually returns its error.
    Close this iterator on early exit so no request outlives the native attempt.

    Args:
        tiles: Missing tiles in grid order.
        fetch: Fetch one tile through the initialized, thread-safe Earth Engine transport.
        check_cancelled: Raise if the attempt should stop before dispatching or while waiting.

    Yields:
        A completed tile and its bytes, terminal error, or None if another
        attempt already cached it. Completion order can differ from grid order.
    """
    retries: deque[tuple[HabitatTileDownload, int]] = deque()
    width, successes = 1, 0
    backoff, resume_at = 1.0, 0.0
    pool = ThreadPoolExecutor(max_workers=_MAX_CONCURRENT_TILES)
    try:
        while True:
            check_cancelled()
            active: dict[Future[bytes], tuple[HabitatTileDownload, int]] = {}
            while len(active) < width:
                check_cancelled()
                if retries:
                    tile, attempt = retries.popleft()
                elif (tile := next(tiles, None)) is not None:
                    attempt = 0
                else:
                    break
                while (
                    remaining := resume_at - monotonic()
                ) > 0 and not tile.entry.exists():
                    sleep(min(remaining, _CANCEL_CHECK_INTERVAL))
                    check_cancelled()
                if tile.entry.exists():
                    yield tile, None
                else:
                    active[pool.submit(fetch, tile.grid)] = tile, attempt
            if not active:
                return

            throttled = False
            while active:
                check_cancelled()
                done, _ = wait(
                    active, timeout=_CANCEL_CHECK_INTERVAL, return_when=FIRST_COMPLETED
                )
                for request in done:
                    tile, attempt = active.pop(request)
                    error = request.exception()
                    if error is None:
                        successes += 1
                        yield tile, request.result()
                        continue
                    if not isinstance(error, Exception):
                        raise error
                    http_error = get_provider_http_error(error)
                    if http_error is not None and http_error.status_code == 429:
                        throttled = True
                        delay = _throttle_delay(
                            _retry_after_seconds(http_error), backoff
                        )
                        resume_at = max(resume_at, monotonic() + delay)
                        if attempt < _MAX_THROTTLE_RETRIES:
                            retries.append((tile, attempt + 1))
                            continue
                    yield tile, error
            if throttled:
                width = max(1, width // 2)
                successes = 0
                backoff = min(30.0, backoff * 2)
            elif successes >= _SUCCESSES_TO_GROW:
                width = min(_MAX_CONCURRENT_TILES, width + 1)
                successes = 0
                backoff = 1.0
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
