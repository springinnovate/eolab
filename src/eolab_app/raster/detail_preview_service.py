"""Catalog-authorized, cached service for bounded raster detail previews."""

import asyncio
import math
import threading
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import rasterio

from eolab_app.raster.detail_preview import (
    DETAIL_PREVIEW_POLICY_VERSION,
    read_raster_detail_preview,
)
from eolab_app.raster.detail_proxy import (
    DETAIL_PROXY_CENTER_OFFSETS,
    DETAIL_PROXY_MAX_DECODED_SOURCE_BYTES,
    DETAIL_PROXY_MAX_DIMENSION,
    DETAIL_PROXY_MAX_SOURCE_BLOCK_READS,
    DETAIL_PROXY_MAX_TRANSFORMED_POSITIONS,
)
from eolab_app.raster.eligibility import (
    DETAIL_ONLY_PREVIEW_REASON_CODES,
    RENDERING_METADATA_KEY,
    RENDERING_POLICY,
    supports_detail_only_preview,
)
from eolab_app.raster.exact_detail import (
    EXACT_DETAIL_EDGE_DENSIFY_POINTS,
    EXACT_DETAIL_MAX_DECODED_SOURCE_BYTES,
    EXACT_DETAIL_MAX_DIMENSION,
    EXACT_DETAIL_MAX_SOURCE_BLOCK_READS,
    EXACT_DETAIL_WINDOW_PADDING_PIXELS,
)
from eolab_app.raster.errors import RasterConflictError
from eolab_app.raster.models import (
    AuthorizedRaster,
    CanonicalWgs84Bounds,
    CatalogRasterDetailPreviewRequest,
    CatalogRasterRequest,
    GEOSERVER_READER_CONTRACT,
    RasterDetailPreview,
    RasterDetailPreviewCacheKey,
    SourceSignature,
    Wgs84Bounds,
)
from eolab_app.raster.ports import RasterCatalog
from eolab_app.raster.read_cancellation import (
    RasterReadCancellationCheck,
    require_active_raster_read,
)
from eolab_app.raster.sources import MountedRasterResolver, source_signature


@dataclass
class _InflightPreview:
    """Track one coalesced worker and the request waiters that still need it.

    Attributes:
        task: Shared asynchronous computation around one Rasterio worker.
        cancellation_requested: Thread-safe signal set after the last waiter
            disconnects.
        waiter_count: Number of active service callers awaiting this identity.
        finished: Whether the worker has completed its cache/error lifecycle.
    """

    task: asyncio.Task[RasterDetailPreview]
    cancellation_requested: threading.Event
    waiter_count: int = 0
    finished: bool = False


class RasterDetailPreviewService:
    """Authorize, admit, coalesce, and cache bounded detail previews.

    Unique in-flight computations are limited to the configured read capacity;
    identical cache identities share one admitted computation.
    """

    def __init__(
        self,
        catalog: RasterCatalog,
        source_resolver: MountedRasterResolver,
        read_concurrency: int,
        cache_entries: int,
        preview_reader: Callable[
            [
                Path,
                CanonicalWgs84Bounds,
                CanonicalWgs84Bounds | None,
                RasterReadCancellationCheck,
            ],
            RasterDetailPreview,
        ] = read_raster_detail_preview,
        signature_reader: Callable[[Path], SourceSignature] = source_signature,
    ) -> None:
        """Create a bounded preview workflow over authoritative catalog data.

        Args:
            catalog: Authoritative scanner-owned raster catalog.
            source_resolver: Resolver confined to the read-only scan mount.
            read_concurrency: Maximum simultaneous Rasterio reads and admitted
                unique preview computations.
            cache_entries: Maximum completed preview documents retained.
            preview_reader: Synchronous bounded Rasterio preview boundary.
            signature_reader: Synchronous source identity boundary.

        Raises:
            ValueError: If concurrency or cache limits are not positive.
        """
        if read_concurrency < 1:
            raise ValueError("Detail preview concurrency must be positive")
        if cache_entries < 1:
            raise ValueError("Detail preview cache size must be positive")
        self._catalog = catalog
        self._source_resolver = source_resolver
        self._read_semaphore = asyncio.Semaphore(read_concurrency)
        self._maximum_inflight = read_concurrency
        self._cache_entries = cache_entries
        self._preview_reader = preview_reader
        self._signature_reader = signature_reader
        self._cache: OrderedDict[
            RasterDetailPreviewCacheKey,
            RasterDetailPreview,
        ] = OrderedDict()
        self._inflight: dict[
            RasterDetailPreviewCacheKey,
            _InflightPreview,
        ] = {}
        self._state_lock = asyncio.Lock()

    @staticmethod
    def _policy_parameters() -> tuple[int, ...]:
        """Return fixed algorithm inputs included in cache identity.

        Returns:
            Center-grid, exact-window, and location-policy inputs.
        """
        # Deterministic fractional locations are encoded in thousandths.
        return (
            DETAIL_PROXY_MAX_DIMENSION,
            DETAIL_PROXY_MAX_SOURCE_BLOCK_READS,
            DETAIL_PROXY_MAX_DECODED_SOURCE_BYTES,
            DETAIL_PROXY_MAX_TRANSFORMED_POSITIONS,
            EXACT_DETAIL_MAX_DIMENSION,
            EXACT_DETAIL_MAX_SOURCE_BLOCK_READS,
            EXACT_DETAIL_MAX_DECODED_SOURCE_BYTES,
            EXACT_DETAIL_EDGE_DENSIFY_POINTS,
            EXACT_DETAIL_WINDOW_PADDING_PIXELS,
            *(
                round(value * 1000)
                for offset in DETAIL_PROXY_CENTER_OFFSETS
                for value in offset
            ),
        )

    @staticmethod
    def _effective_view_bounds(
        request: CatalogRasterDetailPreviewRequest,
        raster_extent: CanonicalWgs84Bounds,
    ) -> CanonicalWgs84Bounds | None:
        """Clip an optional validated map view to the raster extent.

        Args:
            request: Validated preview request.
            raster_extent: Current authoritative WGS 84 raster extent.

        Returns:
            Canonical positive-area intersection, or ``None`` for an extent
            proxy.

        Raises:
            RasterConflictError: If the current view misses the raster.
        """
        if request.view_bounds is None:
            return None
        requested = request.view_bounds.canonical_tuple()
        effective = (
            max(requested[0], raster_extent[0]),
            max(requested[1], raster_extent[1]),
            min(requested[2], raster_extent[2]),
            min(requested[3], raster_extent[3]),
        )
        if effective[0] >= effective[2] or effective[1] >= effective[3]:
            raise RasterConflictError(
                "Current map view does not intersect the raster extent."
            )
        return effective

    async def _authorize(
        self,
        request: CatalogRasterRequest,
    ) -> tuple[AuthorizedRaster, tuple[float, float, float, float]]:
        """Resolve one current overview-only rejection from the catalog.

        Args:
            request: Validated Catalog Item identity.

        Returns:
            Current mounted source authorization and WGS 84 raster extent.

        Raises:
            RasterFeatureError: If catalog/source resolution fails.
            RasterConflictError: If the assessment, reason, reader contract,
                source signature, or extent is not current and applicable.
        """
        item = await self._catalog.get_item(request)
        source_path = self._source_resolver.resolve(item)
        rendering_metadata = item["assets"]["data"].get(
            RENDERING_METADATA_KEY
        )
        if (
            not isinstance(rendering_metadata, dict)
            or rendering_metadata.get("policy") != RENDERING_POLICY
        ):
            raise RasterConflictError(
                "Detail-only preview unavailable: assess this raster first."
            )
        if rendering_metadata.get("eligible") is True:
            raise RasterConflictError(
                "This raster supports normal full visualization; use Add to "
                "map layers instead."
            )
        if (
            rendering_metadata.get("reason_code")
            not in DETAIL_ONLY_PREVIEW_REASON_CODES
        ):
            reason = rendering_metadata.get("reason")
            raise RasterConflictError(
                reason
                if isinstance(reason, str) and reason
                else "This raster is not eligible for detail-only preview."
            )
        if rendering_metadata.get("bounded_blocks") is not True:
            raise RasterConflictError(
                "Detail-only preview unavailable: the raster does not have "
                "safe bounded source blocks."
            )
        if (
            not supports_detail_only_preview(rendering_metadata)
            or rendering_metadata.get("reader_contract")
            != GEOSERVER_READER_CONTRACT
        ):
            raise RasterConflictError(
                "Detail-only preview unavailable: reassess this raster for "
                "the current reader and CRS contract."
            )
        try:
            current_signature = await asyncio.to_thread(
                self._signature_reader,
                source_path,
            )
        except OSError as error:
            raise RasterConflictError(
                "Detail-only preview unavailable: the raster source can no "
                "longer be read."
            ) from error
        if list(current_signature) != rendering_metadata.get(
            "source_signature"
        ):
            raise RasterConflictError(
                "Detail-only preview unavailable: the raster changed; "
                "reassess it first."
            )
        bbox = item.get("bbox")
        try:
            if (
                not isinstance(bbox, list)
                or len(bbox) != 4
                or any(
                    isinstance(value, bool)
                    or not isinstance(value, (int, float))
                    or not math.isfinite(value)
                    for value in bbox
                )
            ):
                raise ValueError
            raster_extent = Wgs84Bounds(
                west=float(bbox[0]),
                south=float(bbox[1]),
                east=float(bbox[2]),
                north=float(bbox[3]),
            ).canonical_tuple()
        except (TypeError, ValueError):
            raise RasterConflictError(
                "Detail-only preview unavailable: the raster extent is invalid."
            ) from None
        return (
            AuthorizedRaster(source_path, current_signature),
            raster_extent,
        )

    async def get(
        self,
        request: CatalogRasterDetailPreviewRequest,
    ) -> RasterDetailPreview:
        """Return a current preview while coalescing identical bounded work.

        Args:
            request: Validated Catalog identity and optional current view.

        Returns:
            Cached or newly computed detail-only preview.

        Raises:
            RasterFeatureError: If authorization or catalog access fails.
            RasterConflictError: If bounded reading or georeferencing fails.
        """
        authorized_raster, raster_extent = await self._authorize(request)
        effective_view_bounds = self._effective_view_bounds(
            request,
            raster_extent,
        )
        cache_key: RasterDetailPreviewCacheKey = (
            request.collection_id,
            request.item_id,
            authorized_raster.source_signature,
            raster_extent,
            DETAIL_PREVIEW_POLICY_VERSION,
            effective_view_bounds,
            self._policy_parameters(),
        )
        async with self._state_lock:
            cached = self._cache.get(cache_key)
            if cached is not None:
                self._cache.move_to_end(cache_key)
                return cached
            inflight = self._inflight.get(cache_key)
            if inflight is None:
                if len(self._inflight) >= self._maximum_inflight:
                    raise RasterConflictError(
                        "Detail-only preview capacity is busy; retry after "
                        "the current bounded read finishes."
                    )
                cancellation_requested = threading.Event()
                task = asyncio.create_task(
                    self._compute(
                        authorized_raster,
                        raster_extent,
                        effective_view_bounds,
                        cache_key,
                        cancellation_requested,
                    )
                )
                task.add_done_callback(self._retrieve_task_exception)
                inflight = _InflightPreview(task, cancellation_requested)
                self._inflight[cache_key] = inflight
            elif inflight.cancellation_requested.is_set():
                raise RasterConflictError(
                    "Detail-only preview capacity is busy; retry after "
                    "the current bounded read finishes."
                )
            inflight.waiter_count += 1
        try:
            try:
                return await asyncio.shield(inflight.task)
            except ValueError as error:
                raise RasterConflictError(str(error)) from error
            except (OSError, rasterio.errors.RasterioError) as error:
                raise RasterConflictError(
                    "The bounded detail-only preview could not be read."
                ) from error
        finally:
            await self._release_waiter(cache_key, inflight)

    async def _release_waiter(
        self,
        cache_key: RasterDetailPreviewCacheKey,
        inflight: _InflightPreview,
    ) -> None:
        """Release one waiter and cooperatively stop an abandoned worker.

        Args:
            cache_key: Complete identity of the shared computation.
            inflight: Exact in-flight state joined by the caller.

        Returns:
            None after detaching the caller and updating worker ownership.
        """
        async with self._state_lock:
            inflight.waiter_count -= 1
            if inflight.waiter_count != 0:
                return
            if inflight.finished:
                if self._inflight.get(cache_key) is inflight:
                    self._inflight.pop(cache_key)
                return
            inflight.cancellation_requested.set()

    async def _compute(
        self,
        authorized_raster: AuthorizedRaster,
        raster_extent: CanonicalWgs84Bounds,
        view_bounds: CanonicalWgs84Bounds | None,
        cache_key: RasterDetailPreviewCacheKey,
        cancellation_requested: threading.Event,
    ) -> RasterDetailPreview:
        """Compute and cache one source version within read capacity.

        Args:
            authorized_raster: Source identity approved at request start.
            raster_extent: Cataloged WGS 84 raster extent.
            view_bounds: Effective current-view intersection, when requested.
            cache_key: Complete source, view, parameters, and policy identity.
            cancellation_requested: Thread-safe last-waiter signal.

        Returns:
            Newly computed bounded preview.

        Raises:
            RasterConflictError: If the source changes around the read.
            RasterReadCancelled: If every coalesced waiter disconnects.
            OSError: If source identity or pixels cannot be read.
            rasterio.errors.RasterioError: If GDAL cannot read or warp.
            ValueError: If sampling or georeferencing fails.
        """
        try:
            async with self._read_semaphore:
                require_active_raster_read(cancellation_requested.is_set)
                if await asyncio.to_thread(
                    self._signature_reader,
                    authorized_raster.source_path,
                ) != authorized_raster.source_signature:
                    raise RasterConflictError(
                        "The raster changed before detail preview reading."
                    )
                preview = await asyncio.to_thread(
                    self._preview_reader,
                    authorized_raster.source_path,
                    raster_extent,
                    view_bounds,
                    cancellation_requested.is_set,
                )
                require_active_raster_read(cancellation_requested.is_set)
                if await asyncio.to_thread(
                    self._signature_reader,
                    authorized_raster.source_path,
                ) != authorized_raster.source_signature:
                    raise RasterConflictError(
                        "The raster changed while its detail preview was read."
                    )
                async with self._state_lock:
                    self._cache[cache_key] = preview
                    self._cache.move_to_end(cache_key)
                    while len(self._cache) > self._cache_entries:
                        self._cache.popitem(last=False)
                return preview
        finally:
            async with self._state_lock:
                inflight = self._inflight[cache_key]
                if inflight.task is not asyncio.current_task():
                    raise RuntimeError(
                        "Detail preview in-flight task identity changed"
                    )
                inflight.finished = True
                if inflight.waiter_count == 0:
                    self._inflight.pop(cache_key)

    @staticmethod
    def _retrieve_task_exception(
        completed_task: asyncio.Task[RasterDetailPreview],
    ) -> None:
        """Retrieve failures from coalesced work after HTTP cancellation.

        Args:
            completed_task: Finished or canceled preview task.
        """
        if not completed_task.cancelled():
            completed_task.exception()
