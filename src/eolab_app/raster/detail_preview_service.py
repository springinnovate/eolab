"""Catalog-authorized, cached service for bounded raster detail previews."""

import asyncio
import math
from collections import OrderedDict
from collections.abc import Callable
from pathlib import Path

import rasterio

from eolab_app.raster.detail_preview import (
    DETAIL_PREVIEW_CANDIDATE_FRACTIONS,
    DETAIL_PREVIEW_PATCH_DIMENSION,
    DETAIL_PREVIEW_POLICY_VERSION,
    NoUsefulDetailPatchError,
    read_raster_detail_preview,
)
from eolab_app.raster.detail_proxy import (
    DETAIL_PATCH_MAX_DECODED_SOURCE_BYTES,
    DETAIL_PROXY_CENTER_OFFSETS,
    DETAIL_PROXY_MAX_DECODED_SOURCE_BYTES,
    DETAIL_PROXY_MAX_SOURCE_BLOCK_READS,
    DETAIL_PROXY_MAX_TRANSFORMED_POSITIONS,
    DETAIL_PROXY_REPRESENTATIVE_OFFSETS,
    detail_proxy_maximum_dimension,
)
from eolab_app.raster.eligibility import (
    DETAIL_ONLY_PREVIEW_REASON_CODES,
    RENDERING_METADATA_KEY,
    RENDERING_POLICY,
    supports_detail_only_preview,
)
from eolab_app.raster.errors import RasterConflictError
from eolab_app.raster.models import (
    AuthorizedRaster,
    CanonicalWgs84Bounds,
    CatalogRasterDetailPreviewRequest,
    GEOSERVER_READER_CONTRACT,
    RasterDetailPreview,
    RasterDetailPreviewCacheKey,
    RasterDetailPreviewDensity,
    RasterDetailPreviewMode,
    SourceSignature,
    Wgs84Bounds,
)
from eolab_app.raster.ports import RasterCatalog
from eolab_app.raster.sources import MountedRasterResolver, source_signature


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
                RasterDetailPreviewMode,
                CanonicalWgs84Bounds,
                RasterDetailPreviewDensity | None,
                CanonicalWgs84Bounds | None,
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
            asyncio.Task[RasterDetailPreview],
        ] = {}
        self._state_lock = asyncio.Lock()

    @staticmethod
    def _mode_parameters(
        mode: RasterDetailPreviewMode,
        density: RasterDetailPreviewDensity | None,
    ) -> tuple[int, ...]:
        """Return fixed algorithm inputs included in cache identity.

        Args:
            mode: Validated detail preview mode.
            density: Fixed exact sampled-grid profile, or ``None`` for a patch.

        Returns:
            Mode-specific sampling limits and location-policy inputs.

        Raises:
            ValueError: If sampled mode parameters bypass request validation
                without a density profile.
        """
        # Deterministic fractional locations are encoded in thousandths.
        if mode in {"centerSample", "representativeSample"}:
            if density is None:
                raise ValueError("Sampled raster proxies require a density")
            offsets = (
                DETAIL_PROXY_CENTER_OFFSETS
                if mode == "centerSample"
                else DETAIL_PROXY_REPRESENTATIVE_OFFSETS
            )
            return (
                detail_proxy_maximum_dimension(density),
                DETAIL_PROXY_MAX_SOURCE_BLOCK_READS,
                DETAIL_PROXY_MAX_DECODED_SOURCE_BYTES,
                DETAIL_PROXY_MAX_TRANSFORMED_POSITIONS,
                *(round(value * 1000) for offset in offsets for value in offset),
            )
        return (
            DETAIL_PREVIEW_PATCH_DIMENSION,
            DETAIL_PROXY_MAX_SOURCE_BLOCK_READS,
            DETAIL_PATCH_MAX_DECODED_SOURCE_BYTES,
            DETAIL_PROXY_MAX_TRANSFORMED_POSITIONS,
            *(round(value * 1000) for value in DETAIL_PREVIEW_CANDIDATE_FRACTIONS),
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
            proxy or representative patch.

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
        request: CatalogRasterDetailPreviewRequest,
    ) -> tuple[AuthorizedRaster, tuple[float, float, float, float]]:
        """Resolve one current overview-only rejection from the catalog.

        Args:
            request: Validated Catalog Item and preview mode.

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
            request: Validated Catalog identity and explicit preview mode.

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
            request.mode,
            request.density,
            effective_view_bounds,
            self._mode_parameters(request.mode, request.density),
        )
        async with self._state_lock:
            cached = self._cache.get(cache_key)
            if cached is not None:
                self._cache.move_to_end(cache_key)
                return cached
            task = self._inflight.get(cache_key)
            if task is None:
                if len(self._inflight) >= self._maximum_inflight:
                    raise RasterConflictError(
                        "Detail-only preview capacity is busy; retry after "
                        "the current bounded read finishes."
                    )
                task = asyncio.create_task(
                    self._compute(
                        authorized_raster,
                        request.mode,
                        raster_extent,
                        request.density,
                        effective_view_bounds,
                        cache_key,
                    )
                )
                task.add_done_callback(self._retrieve_task_exception)
                self._inflight[cache_key] = task
        try:
            return await asyncio.shield(task)
        except NoUsefulDetailPatchError as error:
            raise RasterConflictError(
                "No finite, non-nodata pixels were found in the bounded "
                "representative-patch candidates."
            ) from error
        except ValueError as error:
            raise RasterConflictError(str(error)) from error
        except (OSError, rasterio.errors.RasterioError) as error:
            raise RasterConflictError(
                "The bounded detail-only preview could not be read."
            ) from error

    async def _compute(
        self,
        authorized_raster: AuthorizedRaster,
        mode: RasterDetailPreviewMode,
        raster_extent: CanonicalWgs84Bounds,
        density: RasterDetailPreviewDensity | None,
        view_bounds: CanonicalWgs84Bounds | None,
        cache_key: RasterDetailPreviewCacheKey,
    ) -> RasterDetailPreview:
        """Compute and cache one source version within read capacity.

        Args:
            authorized_raster: Source identity approved at request start.
            mode: Explicit preview mode.
            raster_extent: Cataloged WGS 84 raster extent.
            density: Fixed sampled-grid profile, or ``None`` for a patch.
            view_bounds: Effective current-view intersection, when requested.
            cache_key: Complete source, mode, parameters, and policy identity.

        Returns:
            Newly computed bounded preview.

        Raises:
            RasterConflictError: If the source changes around the read.
            OSError: If source identity or pixels cannot be read.
            rasterio.errors.RasterioError: If GDAL cannot read or warp.
            ValueError: If sampling or georeferencing fails.
        """
        try:
            async with self._read_semaphore:
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
                    mode,
                    raster_extent,
                    density,
                    view_bounds,
                )
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
                if self._inflight.get(cache_key) is asyncio.current_task():
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
