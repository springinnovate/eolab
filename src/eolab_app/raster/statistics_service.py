"""Catalog-authorized application service for bounded raster statistics."""

from eolab_app.catalog_selection import (
    CatalogSelectionReader,
    SelectionUnavailableError,
)
import asyncio
import logging
import math
import threading
import time
from collections import OrderedDict
from collections.abc import AsyncIterator, Callable, Coroutine
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

import rasterio

from eolab_app.raster.errors import (
    RasterConflictError,
    RasterStatisticsCapacityError,
    RasterStatisticsQueueTimeoutError,
)
from eolab_app.raster.models import (
    AuthorizedRaster,
    CatalogRasterPairRequest,
    CatalogRasterStatisticsRequest,
    CanonicalWgs84Bounds,
    RasterPairedStatistics,
    RasterStatistics,
    RasterStatisticsCacheKey,
)
from eolab_app.raster.paired_statistics import (
    RASTER_PAIRED_STATISTICS_ALGORITHM,
    raster_paired_statistics_policy_parameters,
    read_raster_paired_statistics,
)
from eolab_app.raster.ports import RasterSourceAuthorizer
from eolab_app.raster.read_cancellation import (
    RasterReadCancellationCheck,
    RasterReadCancelled,
    require_active_raster_read,
)
from eolab_app.raster.statistics import (
    NoRasterBoundsOverlapError,
    NoValidRasterSamplesError,
    RASTER_STATISTICS_ALGORITHM,
    raster_statistics_policy_parameters,
    read_raster_statistics,
)
from eolab_app.sampling_area import (
    RasterSamplingArea,
    SelectedBoundsSamplingArea,
    CatalogSelectionSamplingArea,
    WholeRasterSamplingArea,
)

_StatisticsResult = RasterStatistics | RasterPairedStatistics
_LOGGER = logging.getLogger(__name__)


@dataclass
class _InflightStatistics:
    """Track one shared worker and the request waiters that still own it.

    Attributes:
        task: Shared queued or running computation around one Rasterio worker.
        cancellation_requested: Thread-safe last-waiter cancellation signal.
        waiter_count: Active callers awaiting this exact cache identity.
        started: Whether the task acquired bounded read capacity.
        finished: Whether computation completed its cache/error lifecycle.
    """

    task: asyncio.Task[_StatisticsResult]
    cancellation_requested: threading.Event
    waiter_count: int = 0
    started: bool = False
    finished: bool = False


class RasterStatisticsService:
    """Authorize, admit, coalesce, cache, and cancel statistics reads.

    Distinct computations wait in FIFO order for configured read capacity.
    Callers requesting an identical cache identity share one queued or active read.
    Ordinary and paired completed results share one configured cache budget.
    """

    def __init__(
        self,
        source_authorizer: RasterSourceAuthorizer,
        read_concurrency: int,
        cache_entries: int,
        catalog_selection_reader: CatalogSelectionReader | None = None,
        statistics_reader: Callable[
            [Path, RasterSamplingArea, RasterReadCancellationCheck],
            RasterStatistics,
        ] = read_raster_statistics,
        paired_statistics_reader: Callable[
            [
                Path,
                Path,
                CanonicalWgs84Bounds | None,
                RasterReadCancellationCheck,
            ],
            RasterPairedStatistics,
        ] = read_raster_paired_statistics,
        *,
        queue_capacity: int = 32,
        queue_wait_seconds: float = 30,
        max_waiters: int = 256,
    ) -> None:
        """Create a bounded analysis workflow over current catalog sources.

        Args:
            source_authorizer: Catalog-owned mounted-source authorization.
            read_concurrency: Maximum simultaneous Rasterio reads.
            cache_entries: Maximum completed ordinary and paired statistics
                documents retained in one combined cache.
            catalog_selection_reader: Narrow resolver for opaque ready catalog selections. It is
                optional only for compositions that reject catalog selection requests.
            statistics_reader: Synchronous bounded Rasterio reader boundary.
            paired_statistics_reader: Synchronous ordered-pair reader boundary.
            queue_capacity: Additional distinct reads allowed to wait for a reader.
            queue_wait_seconds: Maximum wait for read capacity, excluding reading.
            max_waiters: Maximum callers awaiting queued or active results,
                including callers sharing the same computation. Cache hits bypass it.

        Raises:
            ValueError: If capacity limits are invalid or the wait is not finite and positive.
        """
        if read_concurrency < 1:
            raise ValueError("Raster statistics concurrency must be positive")
        if cache_entries < 1:
            raise ValueError("Raster statistics cache size must be positive")
        if queue_capacity < 0 or max_waiters < 1:
            raise ValueError(
                "Statistics queue capacity must be nonnegative and max waiters positive"
            )
        if not math.isfinite(queue_wait_seconds) or queue_wait_seconds <= 0:
            raise ValueError("Statistics queue wait must be finite and positive")
        self._source_authorizer = source_authorizer
        self._read_semaphore = asyncio.Semaphore(read_concurrency)
        self._maximum_inflight = read_concurrency + queue_capacity
        self._queue_wait_seconds = queue_wait_seconds
        self._max_waiters = max_waiters
        self._waiter_count = 0
        self._tasks: set[asyncio.Task[_StatisticsResult]] = set()
        self._cache_entries = cache_entries
        self._catalog_selection_reader = catalog_selection_reader
        self._statistics_reader = statistics_reader
        self._paired_statistics_reader = paired_statistics_reader
        self._cache: OrderedDict[
            tuple[object, ...],
            _StatisticsResult,
        ] = OrderedDict()
        self._inflight: dict[tuple[object, ...], _InflightStatistics] = {}
        self._state_lock = asyncio.Lock()

    async def get(
        self,
        request: CatalogRasterStatisticsRequest,
    ) -> RasterStatistics:
        """Return current bounded statistics for one normalized sampling area.

        Args:
            request: Validated catalog identity and strict sampling-area union.

        Returns:
            Cached or newly computed rendering-independent statistics.

        Raises:
            RasterFeatureError: If catalog/source authorization fails.
            RasterConflictError: If raster, catalog selection, or bounded reading fails.
            RasterStatisticsCapacityError: If the pending-read or caller limit is full.
            RasterStatisticsQueueTimeoutError: If read capacity does not become available in time.
        """
        authorized_raster = await self._source_authorizer.authorize(request)
        try:
            sampling_area = await self._resolve_sampling_area(request)
        except SelectionUnavailableError as error:
            raise RasterConflictError(error.detail) from error
        cache_key: RasterStatisticsCacheKey = (
            request.collection_id,
            request.item_id,
            authorized_raster.source_signature,
            RASTER_STATISTICS_ALGORITHM,
            sampling_area.cache_identity(),
            raster_statistics_policy_parameters(),
        )
        async with self._state_lock:
            cached = self._cache.get(cache_key)
            if cached is not None:
                self._cache.move_to_end(cache_key)
                work = None
            else:
                work = self._join_or_queue_read(
                    cache_key,
                    lambda cancellation: self._compute(
                        authorized_raster,
                        cache_key,
                        sampling_area,
                        cancellation,
                    ),
                )

        if cached is not None:
            try:
                await self._require_current_sampling_area(sampling_area)
            except SelectionUnavailableError as error:
                raise RasterConflictError(error.detail) from error
            return cast(RasterStatistics, cached)

        if work is None:
            raise RuntimeError("Raster statistics work was not established")
        try:
            return cast(RasterStatistics, await asyncio.shield(work.task))
        except NoRasterBoundsOverlapError as error:
            detail = (
                "The catalog selection does not overlap the raster. Choose another "
                "catalog selection or use the whole raster."
                if isinstance(sampling_area, CatalogSelectionSamplingArea)
                else "The selected area does not overlap the raster"
            )
            raise RasterConflictError(detail) from error
        except NoValidRasterSamplesError as error:
            detail = (
                "The catalog selection overlaps the raster but contains no finite, "
                "non-nodata sampled pixels. Choose another catalog selection or raster."
                if isinstance(sampling_area, CatalogSelectionSamplingArea)
                else "No finite, non-nodata pixels were found in the bounded "
                "raster sample"
            )
            raise RasterConflictError(detail) from error
        except SelectionUnavailableError as error:
            raise RasterConflictError(error.detail) from error
        except RasterReadCancelled:
            raise
        except RasterConflictError:
            raise
        except ValueError as error:
            raise RasterConflictError(str(error)) from error
        except (OSError, rasterio.errors.RasterioError) as error:
            raise RasterConflictError(
                "The selected raster statistics could not be read"
            ) from error
        finally:
            await self._release_waiter(cache_key, work)

    async def get_paired(
        self,
        request: CatalogRasterPairRequest,
    ) -> RasterPairedStatistics:
        """Return bounded paired statistics for two current catalog sources.

        X and Y authorization is independent of rendering publication. The
        ordered identities, both source signatures, selected bounds, algorithm,
        and all fixed resource-policy parameters form one cache/coalescing key.

        Args:
            request: Validated ordered catalog pair and optional WGS 84 bounds.

        Returns:
            Cached or newly computed paired histogram on the X reference grid.

        Raises:
            RasterFeatureError: If either catalog/source authorization fails.
            RasterConflictError: If overlap, validity, source, or
                bounded-reading contracts fail.
            RasterStatisticsCapacityError: If the pending-read or caller limit is full.
            RasterStatisticsQueueTimeoutError: If read capacity does not become available in time.
        """
        authorized_x, authorized_y = await asyncio.gather(
            self._source_authorizer.authorize(request.x_raster),
            self._source_authorizer.authorize(request.y_raster),
        )
        selected_bounds = (
            request.selected_bounds.canonical_tuple()
            if request.selected_bounds is not None
            else None
        )
        try:
            sampling_area = await self._resolve_sampling_area(request)
        except SelectionUnavailableError as error:
            raise RasterConflictError(error.detail) from error
        cache_key: tuple[object, ...] = (
            "paired",
            request.x_raster.collection_id,
            request.x_raster.item_id,
            authorized_x.source_signature,
            request.y_raster.collection_id,
            request.y_raster.item_id,
            authorized_y.source_signature,
            RASTER_PAIRED_STATISTICS_ALGORITHM,
            sampling_area.cache_identity(),
            raster_paired_statistics_policy_parameters(),
        )
        async with self._state_lock:
            cached = self._cache.get(cache_key)
            if cached is not None:
                self._cache.move_to_end(cache_key)
                work = None
            else:
                work = self._join_or_queue_read(
                    cache_key,
                    lambda cancellation: self._compute_paired(
                        authorized_x,
                        authorized_y,
                        selected_bounds,
                        cache_key,
                        cancellation,
                        sampling_area,
                    ),
                )

        if cached is not None:
            try:
                await self._require_current_sampling_area(sampling_area)
            except SelectionUnavailableError as error:
                raise RasterConflictError(error.detail) from error
            return cast(RasterPairedStatistics, cached)
        if work is None:
            raise RuntimeError("Paired raster statistics work was not established")
        try:
            return cast(
                RasterPairedStatistics,
                await asyncio.shield(work.task),
            )
        except NoRasterBoundsOverlapError as error:
            raise RasterConflictError(
                "The selected rasters and bounds have no geographic overlap"
            ) from error
        except NoValidRasterSamplesError as error:
            raise RasterConflictError(
                "No finite, non-nodata paired pixels were found in the "
                "bounded raster sample"
            ) from error
        except RasterReadCancelled:
            raise
        except RasterConflictError:
            raise
        except ValueError as error:
            raise RasterConflictError(str(error)) from error
        except (OSError, rasterio.errors.RasterioError) as error:
            raise RasterConflictError(
                "The selected paired raster statistics could not be read"
            ) from error
        finally:
            await self._release_waiter(cache_key, work)

    def _join_or_queue_read(
        self,
        cache_key: tuple[object, ...],
        compute: Callable[[threading.Event], Coroutine[Any, Any, _StatisticsResult]],
    ) -> _InflightStatistics:
        """Join identical work or queue a new read while the state lock is held.

        Args:
            cache_key: Authorized source, area, algorithm and sampling policy.
            compute: Create the ordinary or paired calculation with its cancellation signal.

        Returns:
            Shared work with this caller counted as a waiter.

        Raises:
            RasterStatisticsCapacityError: If the backlog or caller limit is full.
        """
        if self._waiter_count >= self._max_waiters:
            raise RasterStatisticsCapacityError(
                "Too many histogram requests are waiting. Try again shortly."
            )
        work = self._inflight.get(cache_key)
        if work is None:
            if sum(not task.done() for task in self._tasks) >= self._maximum_inflight:
                raise RasterStatisticsCapacityError(
                    "The histogram request queue is full. Try again shortly."
                )
            cancellation = threading.Event()
            task = asyncio.create_task(compute(cancellation))
            task.add_done_callback(self._retrieve_task_exception)
            self._tasks.add(task)
            work = _InflightStatistics(task, cancellation)
            self._inflight[cache_key] = work
        work.waiter_count += 1
        self._waiter_count += 1
        return work

    @asynccontextmanager
    async def _wait_for_read_capacity(
        self,
        cache_key: tuple[object, ...],
    ) -> AsyncIterator[None]:
        """Wait in arrival order, then retain capacity until the reader returns.

        Args:
            cache_key: Identity of the queued ordinary or paired calculation.

        Yields:
            None when this calculation may start its bounded raster read.

        Raises:
            RasterStatisticsQueueTimeoutError: If capacity is not available in time.
            RasterReadCancelled: If all callers have left before reading starts.
            asyncio.CancelledError: If the queued calculation is canceled.
        """
        queued_at = time.perf_counter()
        try:
            async with asyncio.timeout(self._queue_wait_seconds):
                await self._read_semaphore.acquire()
        except TimeoutError as error:
            _LOGGER.info(
                "Histogram queue wait expired after %.3f seconds",
                time.perf_counter() - queued_at,
            )
            raise RasterStatisticsQueueTimeoutError(
                "The histogram request waited too long for a reader. Try again shortly."
            ) from error
        read_started = time.perf_counter()
        try:
            async with self._state_lock:
                work = self._inflight.get(cache_key)
                if work is None or work.task is not asyncio.current_task():
                    raise RasterReadCancelled
                work.started = True
            yield
        finally:
            self._read_semaphore.release()
            _LOGGER.info(
                "Histogram read finished: kind=%s queue_wait_seconds=%.3f read_seconds=%.3f",
                "paired" if cache_key[0] == "paired" else "ordinary",
                read_started - queued_at,
                time.perf_counter() - read_started,
            )

    async def _compute_paired(
        self,
        authorized_x: AuthorizedRaster,
        authorized_y: AuthorizedRaster,
        selected_bounds: CanonicalWgs84Bounds | None,
        cache_key: tuple[object, ...],
        cancellation_requested: threading.Event,
        sampling_area: RasterSamplingArea,
    ) -> RasterPairedStatistics:
        """Compute one ordered source pair within shared bounded capacity.

        Args:
            authorized_x: Catalog source authorized as the X reference.
            authorized_y: Catalog source authorized for nearest alignment.
            selected_bounds: Optional canonical WGS 84 sampling rectangle.
            cache_key: Ordered identities, signatures, bounds, and policy.
            cancellation_requested: Thread-safe last-waiter signal.
            sampling_area: Resolved lifecycle identity rechecked around reads.

        Returns:
            Newly computed bounded paired statistics.

        Raises:
            RasterConflictError: If either source changes around the read.
            NoRasterBoundsOverlapError: If pair/bounds do not overlap.
            NoValidRasterSamplesError: If no paired finite cells exist.
            RasterReadCancelled: If every request waiter disconnects.
            OSError: If either source cannot be read.
            rasterio.errors.RasterioError: If GDAL cannot process a source.
            ValueError: If source or bounded-read contracts are invalid.
        """
        try:
            async with self._wait_for_read_capacity(cache_key):
                require_active_raster_read(cancellation_requested.is_set)
                await self._require_current_sampling_area(sampling_area)
                options = (
                    {"catalog_selection": sampling_area}
                    if isinstance(sampling_area, CatalogSelectionSamplingArea)
                    else {}
                )
                statistics = await asyncio.to_thread(
                    self._paired_statistics_reader,
                    authorized_x.source_path,
                    authorized_y.source_path,
                    selected_bounds,
                    cancellation_requested.is_set,
                    **options,
                )
                require_active_raster_read(cancellation_requested.is_set)
                await self._require_current_sampling_area(sampling_area)
                async with self._state_lock:
                    work = self._inflight.get(cache_key)
                    if (
                        work is None
                        or work.task is not asyncio.current_task()
                        or work.waiter_count == 0
                        or cancellation_requested.is_set()
                    ):
                        raise RasterReadCancelled
                    self._remember_completed(cache_key, statistics)
                return statistics
        finally:
            async with self._state_lock:
                work = self._inflight.get(cache_key)
                if work is not None and work.task is asyncio.current_task():
                    work.finished = True
                    if work.waiter_count == 0:
                        self._inflight.pop(cache_key)

    async def _release_waiter(
        self,
        cache_key: tuple[object, ...],
        work: _InflightStatistics,
    ) -> None:
        """Release a caller and stop work after its final waiter disconnects.

        Args:
            cache_key: Complete identity of the shared computation.
            work: Exact in-flight state joined by the caller.

        Returns:
            None after detaching the caller and updating worker ownership.
        """
        async with self._state_lock:
            work.waiter_count -= 1
            self._waiter_count -= 1
            if work.waiter_count != 0:
                return
            if work.finished:
                if self._inflight.get(cache_key) is work:
                    self._inflight.pop(cache_key)
                return
            work.cancellation_requested.set()
            if self._inflight.get(cache_key) is work:
                self._inflight.pop(cache_key)
            if not work.started:
                work.task.cancel()
                self._tasks.discard(work.task)

    async def _compute(
        self,
        authorized_raster: AuthorizedRaster,
        cache_key: RasterStatisticsCacheKey,
        sampling_area: RasterSamplingArea,
        cancellation_requested: threading.Event,
    ) -> RasterStatistics:
        """Compute one current source/area identity within bounded capacity.

        Args:
            authorized_raster: Catalog source authorized at request start.
            cache_key: Source, area, algorithm, and parameter cache identity.
            sampling_area: Resolved whole, rectangle, or catalog-selection area.
            cancellation_requested: Thread-safe last-waiter signal.

        Returns:
            Newly computed bounded raster statistics.

        Raises:
            RasterConflictError: If the source changes around the read.
            SelectionUnavailableError: If the Catalog source identity changes.
            NoRasterBoundsOverlapError: If selected geometry misses the raster.
            NoValidRasterSamplesError: If no finite sample values exist.
            RasterReadCancelled: If every request waiter disconnects.
            OSError: If source identity or pixels cannot be read.
            rasterio.errors.RasterioError: If GDAL cannot read the source.
            ValueError: If source or sampling contracts are invalid.
        """
        try:
            async with self._wait_for_read_capacity(cache_key):
                require_active_raster_read(cancellation_requested.is_set)
                await self._require_current_sampling_area(sampling_area)
                statistics = await asyncio.to_thread(
                    self._statistics_reader,
                    authorized_raster.source_path,
                    sampling_area,
                    cancellation_requested.is_set,
                )
                require_active_raster_read(cancellation_requested.is_set)
                await self._require_current_sampling_area(sampling_area)
                async with self._state_lock:
                    work = self._inflight.get(cache_key)
                    if (
                        work is None
                        or work.task is not asyncio.current_task()
                        or work.waiter_count == 0
                        or cancellation_requested.is_set()
                    ):
                        raise RasterReadCancelled
                    self._remember_completed(cache_key, statistics)
                return statistics
        finally:
            async with self._state_lock:
                work = self._inflight.get(cache_key)
                if work is not None and work.task is asyncio.current_task():
                    work.finished = True
                    if work.waiter_count == 0:
                        self._inflight.pop(cache_key)

    def _remember_completed(
        self,
        cache_key: tuple[object, ...],
        statistics: RasterStatistics | RasterPairedStatistics,
    ) -> None:
        """Retain one completed result within the combined LRU budget.

        The caller must hold ``_state_lock`` so ordinary and paired workers
        cannot transiently exceed the configured process-wide limit.

        Args:
            cache_key: Complete ordinary or paired computation identity.
            statistics: Valid completed result for that identity.

        Returns:
            None after retaining the result and evicting older entries.
        """
        self._cache[cache_key] = statistics
        self._cache.move_to_end(cache_key)
        while len(self._cache) > self._cache_entries:
            self._cache.popitem(last=False)

    async def _resolve_sampling_area(
        self,
        request: CatalogRasterStatisticsRequest | CatalogRasterPairRequest,
    ) -> RasterSamplingArea:
        """Resolve the request's strict sampling-area union.

        Args:
            request: Validated raster identity and exclusive sampling fields.

        Returns:
            Whole-raster, rectangular, or immutable resolved catalog selection area.

        Raises:
            SelectionUnavailableError: If an catalog selection reader is unavailable or
                the opaque lifecycle cannot be resolved.
        """
        if request.selected_bounds is not None:
            return SelectedBoundsSamplingArea(request.selected_bounds.canonical_tuple())
        if request.catalog_selection is None:
            return WholeRasterSamplingArea()
        if self._catalog_selection_reader is None:
            raise SelectionUnavailableError(
                "Catalog vector sampling is not available. Use the whole raster."
            )
        resolved = await self._catalog_selection_reader.resolve_for_sampling(
            request.catalog_selection
        )
        return CatalogSelectionSamplingArea(resolved)

    async def _require_current_sampling_area(
        self,
        sampling_area: RasterSamplingArea,
    ) -> None:
        """Recheck catalog-vector source identity around a raster read.

        Args:
            sampling_area: Sampling area resolved at request start.

        Returns:
            None after confirming the current catalog source, or for a box/whole area.

        Raises:
            SelectionUnavailableError: If the Catalog source is unavailable or its immutable identity changed.
        """
        if not isinstance(sampling_area, CatalogSelectionSamplingArea):
            return
        if self._catalog_selection_reader is None:
            raise SelectionUnavailableError(
                "Catalog vector sampling is not available. Use the whole raster."
            )
        current = await self._catalog_selection_reader.resolve_for_sampling(
            sampling_area.resolved.selection
        )
        if current.selection != sampling_area.resolved.selection:
            raise SelectionUnavailableError(
                "The catalog vector changed while it was being sampled. Try again."
            )

    def _retrieve_task_exception(
        self,
        completed_task: asyncio.Task[_StatisticsResult],
    ) -> None:
        """Retrieve failures from shared work even when its waiters have left.

        Args:
            completed_task: Finished or canceled ordinary or paired task.

        Returns:
            None after consuming any worker exception.
        """
        self._tasks.discard(completed_task)
        if not completed_task.cancelled():
            completed_task.exception()
