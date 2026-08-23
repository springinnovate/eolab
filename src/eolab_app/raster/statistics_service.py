"""Bounded, coalescing application service for raster statistics."""

import asyncio
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import rasterio

from eolab_app.raster.errors import RasterConflictError
from eolab_app.raster.models import (
    AuthorizedRaster,
    CatalogRasterStatisticsRequest,
    RasterStatistics,
    RasterStatisticsCacheKey,
)
from eolab_app.sampling_area import (
    RasterSamplingArea,
    SamplingAreaUnavailableError,
    SelectedBoundsSamplingArea,
    TemporaryAoiSamplingArea,
    TemporaryAoiSamplingAreaReader,
    WholeRasterSamplingArea,
)
from eolab_app.raster.sources import PublishedRasterRegistry
from eolab_app.raster.statistics import (
    NoRasterBoundsOverlapError,
    NoValidRasterSamplesError,
    RASTER_STATISTICS_ALGORITHM,
    read_raster_statistics,
)


GEOSERVER_WORKSPACE_NAME = "eolab"


@dataclass
class RasterStatisticsWork:
    """One coalesced statistics task and its active HTTP waiters.

    Attributes:
        task: Shared statistics computation.
        waiter_count: Requests still awaiting the computation.
    """

    task: asyncio.Task[RasterStatistics]
    waiter_count: int = 0


class RasterStatisticsService:
    """Cache and serialize bounded statistics reads for published rasters."""

    def __init__(
        self,
        raster_registry: PublishedRasterRegistry,
        read_concurrency: int,
        cache_entries: int,
        temporary_aoi_reader: TemporaryAoiSamplingAreaReader | None = None,
        statistics_reader: Callable[
            [
                Path,
                tuple[float, float, float, float]
                | TemporaryAoiSamplingArea
                | None,
            ],
            RasterStatistics,
        ] = read_raster_statistics,
    ) -> None:
        """Create a bounded, coalescing raster statistics service.

        Args:
            raster_registry: Current-process publication authorizations.
            read_concurrency: Maximum simultaneous Rasterio statistics reads.
            cache_entries: Maximum completed statistics documents retained.
            temporary_aoi_reader: Narrow resolver for opaque ready AOIs. It is
                optional only for compositions that never accept AOI requests.
            statistics_reader: Synchronous Rasterio statistics boundary.
        """
        self._raster_registry = raster_registry
        self._read_semaphore = asyncio.Semaphore(read_concurrency)
        self._cache_entries = cache_entries
        self._temporary_aoi_reader = temporary_aoi_reader
        self._statistics_reader = statistics_reader
        self._cache: OrderedDict[
            RasterStatisticsCacheKey,
            RasterStatistics,
        ] = OrderedDict()
        self._inflight: dict[
            RasterStatisticsCacheKey,
            RasterStatisticsWork,
        ] = {}
        self._active_read_tasks: set[asyncio.Task[RasterStatistics]] = set()
        self._state_lock = asyncio.Lock()

    async def get(
        self,
        request: CatalogRasterStatisticsRequest,
    ) -> RasterStatistics:
        """Return current statistics, coalescing identical source reads.

        Args:
            request: Validated Item identity and optional selected WGS 84 area.

        Returns:
            Cached or newly computed bounded raster statistics.

        Raises:
            RasterRequestError: If the layer is not approved.
            RasterConflictError: If the raster is stale or cannot be sampled.
        """
        layer_name = f"{GEOSERVER_WORKSPACE_NAME}:{request.item_id}"
        authorized_raster = await asyncio.to_thread(
            self._raster_registry.require_current,
            layer_name,
        )
        try:
            sampling_area = await self._resolve_sampling_area(request)
        except SamplingAreaUnavailableError as error:
            raise RasterConflictError(error.detail) from error
        cache_key = (
            layer_name,
            authorized_raster.source_signature,
            RASTER_STATISTICS_ALGORITHM,
            sampling_area.cache_identity(),
        )
        async with self._state_lock:
            cached_statistics = self._cache.get(cache_key)
            if cached_statistics is not None:
                self._cache.move_to_end(cache_key)
                return cached_statistics

            work = self._inflight.get(cache_key)
            if work is None:
                read_task = asyncio.create_task(
                    self._compute(
                        layer_name,
                        authorized_raster,
                        cache_key,
                        sampling_area,
                    )
                )
                read_task.add_done_callback(self._retrieve_task_exception)
                work = RasterStatisticsWork(read_task)
                self._inflight[cache_key] = work
            work.waiter_count += 1

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
        except (OSError, ValueError, rasterio.errors.RasterioError) as error:
            raise RasterConflictError(
                "The selected raster statistics could not be read"
            ) from error
        finally:
            await self._release_waiter(cache_key, work)

    async def _release_waiter(
        self,
        cache_key: RasterStatisticsCacheKey,
        work: RasterStatisticsWork,
    ) -> None:
        """Cancel abandoned work only while queued for read capacity.

        Args:
            cache_key: Identity of the coalesced statistics work.
            work: Work whose HTTP waiter completed or was canceled.
        """
        async with self._state_lock:
            work.waiter_count -= 1
            if (
                work.waiter_count == 0
                and self._inflight.get(cache_key) is work
                and work.task not in self._active_read_tasks
            ):
                self._inflight.pop(cache_key)
                work.task.cancel()

    async def _compute(
        self,
        layer_name: str,
        authorized_raster: AuthorizedRaster,
        cache_key: RasterStatisticsCacheKey,
        sampling_area: RasterSamplingArea,
    ) -> RasterStatistics:
        """Compute one source signature while retaining capacity.

        Args:
            layer_name: Workspace-qualified approved WMS layer.
            authorized_raster: Source approved at request start.
            cache_key: Stable cache identity for the statistics.
            sampling_area: Resolved whole, rectangular, or temporary AOI area.

        Returns:
            Newly computed bounded raster statistics.

        Raises:
            RasterConflictError: If the source changes around the read.
            NoRasterBoundsOverlapError: If selected bounds miss the raster.
            NoValidRasterSamplesError: If no finite sample values exist.
            OSError: If the source cannot be read.
            rasterio.errors.RasterioError: If GDAL cannot sample the source.
            ValueError: If coordinate transformation or statistics fail.
        """
        read_task = cast(
            asyncio.Task[RasterStatistics],
            asyncio.current_task(),
        )
        try:
            async with self._read_semaphore:
                async with self._state_lock:
                    self._active_read_tasks.add(read_task)
                current_raster = await asyncio.to_thread(
                    self._raster_registry.require_current,
                    layer_name,
                )
                if current_raster != authorized_raster:
                    raise RasterConflictError(
                        "The visualized GeoTIFF changed; select it again"
                    )
                await self._require_current_sampling_area(sampling_area)
                statistics = await asyncio.to_thread(
                    self._statistics_reader,
                    authorized_raster.source_path,
                    self._statistics_reader_area(sampling_area),
                )
                current_raster = await asyncio.to_thread(
                    self._raster_registry.require_current,
                    layer_name,
                )
                if current_raster != authorized_raster:
                    raise RasterConflictError(
                        "The visualized GeoTIFF changed; select it again"
                    )
                await self._require_current_sampling_area(sampling_area)

                async with self._state_lock:
                    self._cache[cache_key] = statistics
                    self._cache.move_to_end(cache_key)
                    while len(self._cache) > self._cache_entries:
                        self._cache.popitem(last=False)
                return statistics
        finally:
            async with self._state_lock:
                self._active_read_tasks.discard(read_task)
                work = self._inflight.get(cache_key)
                if work is not None and work.task is read_task:
                    self._inflight.pop(cache_key)

    @staticmethod
    def _statistics_reader_area(
        sampling_area: RasterSamplingArea,
    ) -> tuple[float, float, float, float] | TemporaryAoiSamplingArea | None:
        """Adapt the domain union to the stable synchronous reader boundary.

        Existing whole-raster and rectangular readers retain their ``None`` or
        canonical bounds arguments. Only temporary AOIs add the reusable area
        value object needed to carry immutable polygonal geometry.

        Args:
            sampling_area: Explicit resolved sampling-area value object.

        Returns:
            ``None`` for whole raster, canonical bounds for a rectangle, or the
            resolved temporary-AOI area.
        """
        if isinstance(sampling_area, WholeRasterSamplingArea):
            return None
        if isinstance(sampling_area, SelectedBoundsSamplingArea):
            return sampling_area.bounds
        return sampling_area

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
            None when whole-raster/bounds sampling needs no lifecycle recheck,
            or when the AOI is still the exact same ready lifecycle.

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
        """Retrieve failures from work that outlived a canceled request.

        Args:
            completed_task: Finished or canceled coalesced statistics task.
        """
        if not completed_task.cancelled():
            completed_task.exception()
