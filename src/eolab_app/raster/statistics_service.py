"""Catalog-authorized application service for bounded raster statistics."""

import asyncio
import threading
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import rasterio

from eolab_app.raster.errors import RasterConflictError
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
    SamplingAreaUnavailableError,
    SelectedBoundsSamplingArea,
    TemporaryAoiSamplingArea,
    TemporaryAoiSamplingAreaReader,
    WholeRasterSamplingArea,
)


@dataclass
class _InflightStatistics:
    """Track one shared worker and the request waiters that still own it.

    Attributes:
        task: Shared asynchronous computation around one Rasterio worker.
        cancellation_requested: Thread-safe last-waiter cancellation signal.
        waiter_count: Active callers awaiting this exact cache identity.
        started: Whether the task acquired bounded read capacity.
        finished: Whether computation completed its cache/error lifecycle.
    """

    task: asyncio.Task[RasterStatistics]
    cancellation_requested: threading.Event
    waiter_count: int = 0
    started: bool = False
    finished: bool = False


@dataclass
class _InflightPairedStatistics:
    """Track one shared paired worker and its active request waiters.

    Attributes:
        task: Shared asynchronous paired computation.
        cancellation_requested: Thread-safe last-waiter cancellation signal.
        waiter_count: Active callers awaiting the same ordered pair and bounds.
        started: Whether the task acquired shared bounded read capacity.
        finished: Whether computation completed its cache/error lifecycle.
    """

    task: asyncio.Task[RasterPairedStatistics]
    cancellation_requested: threading.Event
    waiter_count: int = 0
    started: bool = False
    finished: bool = False


class RasterStatisticsService:
    """Authorize, admit, coalesce, cache, and cancel statistics reads.

    Distinct in-flight computations are limited to configured read capacity;
    callers requesting an identical cache identity share one admitted worker.
    Ordinary and paired completed results share one configured cache budget.
    """

    def __init__(
        self,
        source_authorizer: RasterSourceAuthorizer,
        read_concurrency: int,
        cache_entries: int,
        temporary_aoi_reader: TemporaryAoiSamplingAreaReader | None = None,
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
    ) -> None:
        """Create a bounded analysis workflow over current catalog sources.

        Args:
            source_authorizer: Catalog-owned mounted-source authorization.
            read_concurrency: Maximum simultaneous Rasterio reads and admitted
                distinct statistics computations.
            cache_entries: Maximum completed ordinary and paired statistics
                documents retained in one combined cache.
            temporary_aoi_reader: Narrow resolver for opaque ready AOIs. It is
                optional only for compositions that reject AOI requests.
            statistics_reader: Synchronous bounded Rasterio reader boundary.
            paired_statistics_reader: Synchronous ordered-pair reader boundary.

        Raises:
            ValueError: If concurrency or cache limits are not positive.
        """
        if read_concurrency < 1:
            raise ValueError("Raster statistics concurrency must be positive")
        if cache_entries < 1:
            raise ValueError("Raster statistics cache size must be positive")
        self._source_authorizer = source_authorizer
        self._read_semaphore = asyncio.Semaphore(read_concurrency)
        self._maximum_inflight = read_concurrency
        self._cache_entries = cache_entries
        self._temporary_aoi_reader = temporary_aoi_reader
        self._statistics_reader = statistics_reader
        self._paired_statistics_reader = paired_statistics_reader
        self._cache: OrderedDict[
            tuple[object, ...],
            RasterStatistics | RasterPairedStatistics,
        ] = OrderedDict()
        self._inflight: dict[
            RasterStatisticsCacheKey,
            _InflightStatistics,
        ] = {}
        self._state_lock = asyncio.Lock()
        self._paired_inflight: dict[
            tuple[object, ...],
            _InflightPairedStatistics,
        ] = {}

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
            RasterConflictError: If raster, AOI, or bounded reading fails.
        """
        authorized_raster = await self._source_authorizer.authorize(request)
        try:
            sampling_area = await self._resolve_sampling_area(request)
        except SamplingAreaUnavailableError as error:
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
                work = self._inflight.get(cache_key)
                if work is None:
                    if (
                        len(self._inflight) + len(self._paired_inflight)
                        >= self._maximum_inflight
                    ):
                        raise RasterConflictError(
                            "Raster statistics capacity is busy; retry after "
                            "the current bounded read finishes."
                        )
                    cancellation_requested = threading.Event()
                    task = asyncio.create_task(
                        self._compute(
                            authorized_raster,
                            cache_key,
                            sampling_area,
                            cancellation_requested,
                        )
                    )
                    task.add_done_callback(self._retrieve_task_exception)
                    work = _InflightStatistics(task, cancellation_requested)
                    self._inflight[cache_key] = work
                elif work.cancellation_requested.is_set():
                    raise RasterConflictError(
                        "Raster statistics capacity is finishing canceled work; "
                        "retry shortly."
                    )
                work.waiter_count += 1

        if cached is not None:
            await self._source_authorizer.require_current(authorized_raster)
            try:
                await self._require_current_sampling_area(sampling_area)
            except SamplingAreaUnavailableError as error:
                raise RasterConflictError(error.detail) from error
            return cast(RasterStatistics, cached)

        if work is None:
            raise RuntimeError("Raster statistics work was not established")
        try:
            return await asyncio.shield(work.task)
        except NoRasterBoundsOverlapError as error:
            detail = (
                "The uploaded AOI does not overlap the raster. Choose another "
                "AOI or use the whole raster."
                if isinstance(sampling_area, TemporaryAoiSamplingArea)
                else "The selected area does not overlap the raster"
            )
            raise RasterConflictError(detail) from error
        except NoValidRasterSamplesError as error:
            detail = (
                "The uploaded AOI overlaps the raster but contains no finite, "
                "non-nodata sampled pixels. Choose another AOI or raster."
                if isinstance(sampling_area, TemporaryAoiSamplingArea)
                else "No finite, non-nodata pixels were found in the bounded "
                "raster sample"
            )
            raise RasterConflictError(detail) from error
        except SamplingAreaUnavailableError as error:
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
            RasterConflictError: If overlap, validity, capacity, source, or
                bounded-reading contracts fail.
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
        cache_key: tuple[object, ...] = (
            "paired",
            request.x_raster.collection_id,
            request.x_raster.item_id,
            authorized_x.source_signature,
            request.y_raster.collection_id,
            request.y_raster.item_id,
            authorized_y.source_signature,
            RASTER_PAIRED_STATISTICS_ALGORITHM,
            selected_bounds,
            raster_paired_statistics_policy_parameters(),
        )
        async with self._state_lock:
            cached = self._cache.get(cache_key)
            if cached is not None:
                self._cache.move_to_end(cache_key)
                work = None
            else:
                work = self._paired_inflight.get(cache_key)
                if work is None:
                    if (
                        len(self._inflight) + len(self._paired_inflight)
                        >= self._maximum_inflight
                    ):
                        raise RasterConflictError(
                            "Raster statistics capacity is busy; retry after "
                            "the current bounded read finishes."
                        )
                    cancellation_requested = threading.Event()
                    task = asyncio.create_task(
                        self._compute_paired(
                            authorized_x,
                            authorized_y,
                            selected_bounds,
                            cache_key,
                            cancellation_requested,
                        )
                    )
                    task.add_done_callback(
                        self._retrieve_paired_task_exception
                    )
                    work = _InflightPairedStatistics(
                        task,
                        cancellation_requested,
                    )
                    self._paired_inflight[cache_key] = work
                elif work.cancellation_requested.is_set():
                    raise RasterConflictError(
                        "Raster statistics capacity is finishing canceled work; "
                        "retry shortly."
                    )
                work.waiter_count += 1

        if cached is not None:
            await asyncio.gather(
                self._source_authorizer.require_current(authorized_x),
                self._source_authorizer.require_current(authorized_y),
            )
            return cast(RasterPairedStatistics, cached)
        if work is None:
            raise RuntimeError("Paired raster statistics work was not established")
        try:
            return await asyncio.shield(work.task)
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
            await self._release_paired_waiter(cache_key, work)

    async def _release_paired_waiter(
        self,
        cache_key: tuple[object, ...],
        work: _InflightPairedStatistics,
    ) -> None:
        """Release one paired caller and cancel after its last waiter leaves.

        Args:
            cache_key: Complete ordered-pair computation identity.
            work: Exact in-flight paired state joined by the caller.

        Returns:
            None after detaching the caller and updating worker ownership.
        """
        async with self._state_lock:
            work.waiter_count -= 1
            if work.waiter_count != 0:
                return
            if work.finished:
                if self._paired_inflight.get(cache_key) is work:
                    self._paired_inflight.pop(cache_key)
                return
            work.cancellation_requested.set()
            if not work.started:
                if self._paired_inflight.get(cache_key) is work:
                    self._paired_inflight.pop(cache_key)
                work.task.cancel()

    async def _compute_paired(
        self,
        authorized_x: AuthorizedRaster,
        authorized_y: AuthorizedRaster,
        selected_bounds: CanonicalWgs84Bounds | None,
        cache_key: tuple[object, ...],
        cancellation_requested: threading.Event,
    ) -> RasterPairedStatistics:
        """Compute one ordered source pair within shared bounded capacity.

        Args:
            authorized_x: Catalog source authorized as the X reference.
            authorized_y: Catalog source authorized for nearest alignment.
            selected_bounds: Optional canonical WGS 84 sampling rectangle.
            cache_key: Ordered identities, signatures, bounds, and policy.
            cancellation_requested: Thread-safe last-waiter signal.

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
            async with self._read_semaphore:
                async with self._state_lock:
                    work = self._paired_inflight.get(cache_key)
                    if work is None or work.task is not asyncio.current_task():
                        raise RasterReadCancelled
                    work.started = True
                require_active_raster_read(cancellation_requested.is_set)
                await asyncio.gather(
                    self._source_authorizer.require_current(authorized_x),
                    self._source_authorizer.require_current(authorized_y),
                )
                statistics = await asyncio.to_thread(
                    self._paired_statistics_reader,
                    authorized_x.source_path,
                    authorized_y.source_path,
                    selected_bounds,
                    cancellation_requested.is_set,
                )
                require_active_raster_read(cancellation_requested.is_set)
                await asyncio.gather(
                    self._source_authorizer.require_current(authorized_x),
                    self._source_authorizer.require_current(authorized_y),
                )
                async with self._state_lock:
                    work = self._paired_inflight.get(cache_key)
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
                work = self._paired_inflight.get(cache_key)
                if work is not None and work.task is asyncio.current_task():
                    work.finished = True
                    if work.waiter_count == 0:
                        self._paired_inflight.pop(cache_key)

    async def _release_waiter(
        self,
        cache_key: RasterStatisticsCacheKey,
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
            if work.waiter_count != 0:
                return
            if work.finished:
                if self._inflight.get(cache_key) is work:
                    self._inflight.pop(cache_key)
                return
            work.cancellation_requested.set()
            if not work.started:
                if self._inflight.get(cache_key) is work:
                    self._inflight.pop(cache_key)
                work.task.cancel()

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
            sampling_area: Resolved whole, rectangle, or temporary-AOI area.
            cancellation_requested: Thread-safe last-waiter signal.

        Returns:
            Newly computed bounded raster statistics.

        Raises:
            RasterConflictError: If the source changes around the read.
            SamplingAreaUnavailableError: If the AOI lifecycle changes.
            NoRasterBoundsOverlapError: If selected geometry misses the raster.
            NoValidRasterSamplesError: If no finite sample values exist.
            RasterReadCancelled: If every request waiter disconnects.
            OSError: If source identity or pixels cannot be read.
            rasterio.errors.RasterioError: If GDAL cannot read the source.
            ValueError: If source or sampling contracts are invalid.
        """
        try:
            async with self._read_semaphore:
                async with self._state_lock:
                    work = self._inflight.get(cache_key)
                    if work is None or work.task is not asyncio.current_task():
                        raise RasterReadCancelled
                    work.started = True
                require_active_raster_read(cancellation_requested.is_set)
                await self._source_authorizer.require_current(authorized_raster)
                await self._require_current_sampling_area(sampling_area)
                statistics = await asyncio.to_thread(
                    self._statistics_reader,
                    authorized_raster.source_path,
                    sampling_area,
                    cancellation_requested.is_set,
                )
                require_active_raster_read(cancellation_requested.is_set)
                await self._source_authorizer.require_current(authorized_raster)
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
        request: CatalogRasterStatisticsRequest,
    ) -> RasterSamplingArea:
        """Resolve the request's strict sampling-area union.

        Args:
            request: Validated raster identity and exclusive sampling fields.

        Returns:
            Whole-raster, rectangular, or immutable resolved AOI area.

        Raises:
            SamplingAreaUnavailableError: If an AOI reader is unavailable or
                the opaque lifecycle cannot be resolved.
        """
        if request.selected_bounds is not None:
            return SelectedBoundsSamplingArea(
                request.selected_bounds.canonical_tuple()
            )
        if request.temporary_aoi_id is None:
            return WholeRasterSamplingArea()
        if self._temporary_aoi_reader is None:
            raise SamplingAreaUnavailableError(
                "Temporary AOI sampling is not available. Use the whole raster."
            )
        resolved_aoi = await self._temporary_aoi_reader.resolve_for_sampling(
            request.temporary_aoi_id
        )
        return TemporaryAoiSamplingArea(resolved_aoi)

    async def _require_current_sampling_area(
        self,
        sampling_area: RasterSamplingArea,
    ) -> None:
        """Recheck temporary-AOI lifecycle identity around a raster read.

        Args:
            sampling_area: Sampling area resolved at request start.

        Returns:
            None for non-lifecycle areas or the same ready AOI lifecycle.

        Raises:
            SamplingAreaUnavailableError: If the AOI was removed, replaced,
                expired, or its immutable identity unexpectedly changed.
        """
        if not isinstance(sampling_area, TemporaryAoiSamplingArea):
            return
        if self._temporary_aoi_reader is None:
            raise SamplingAreaUnavailableError(
                "Temporary AOI sampling is not available. Use the whole raster."
            )
        current = await self._temporary_aoi_reader.resolve_for_sampling(
            sampling_area.resolved_aoi.identity.reference
        )
        if current.identity != sampling_area.resolved_aoi.identity:
            raise SamplingAreaUnavailableError(
                "The uploaded AOI changed while it was being sampled. Try again."
            )

    @staticmethod
    def _retrieve_task_exception(
        completed_task: asyncio.Task[RasterStatistics],
    ) -> None:
        """Retrieve failures from coalesced work after HTTP cancellation.

        Args:
            completed_task: Finished or canceled statistics task.

        Returns:
            None after consuming any worker exception.
        """
        if not completed_task.cancelled():
            completed_task.exception()

    @staticmethod
    def _retrieve_paired_task_exception(
        completed_task: asyncio.Task[RasterPairedStatistics],
    ) -> None:
        """Retrieve paired failures after every HTTP waiter disconnects.

        Args:
            completed_task: Finished or canceled paired-statistics task.

        Returns:
            None after consuming any worker exception.
        """
        if not completed_task.cancelled():
            completed_task.exception()
