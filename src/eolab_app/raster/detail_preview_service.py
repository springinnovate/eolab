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
    DETAIL_PROXY_CENTER_OFFSETS,
    DETAIL_PROXY_MAX_DECODED_SOURCE_BYTES,
    DETAIL_PROXY_MAX_DIMENSION,
    DETAIL_PROXY_MAX_SOURCE_BLOCK_READS,
    DETAIL_PROXY_REPRESENTATIVE_OFFSETS,
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
    CatalogRasterDetailPreviewRequest,
    GEOSERVER_READER_CONTRACT,
    RasterDetailPreview,
    RasterDetailPreviewCacheKey,
    RasterDetailPreviewMode,
    SourceSignature,
    Wgs84Bounds,
)
from eolab_app.raster.ports import RasterCatalog
from eolab_app.raster.sources import MountedRasterResolver, source_signature


class RasterDetailPreviewService:
    """Authorize, coalesce, and cache strictly bounded detail previews."""

    def __init__(
        self,
        catalog: RasterCatalog,
        source_resolver: MountedRasterResolver,
        read_concurrency: int,
        cache_entries: int,
        preview_reader: Callable[
            [Path, RasterDetailPreviewMode, tuple[float, float, float, float]],
            RasterDetailPreview,
        ] = read_raster_detail_preview,
        signature_reader: Callable[[Path], SourceSignature] = source_signature,
    ) -> None:
        """Create a bounded preview workflow over authoritative catalog data.

        Args:
            catalog: Authoritative scanner-owned raster catalog.
            source_resolver: Resolver confined to the read-only scan mount.
            read_concurrency: Maximum simultaneous Rasterio preview reads.
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
    def _mode_parameters(mode: RasterDetailPreviewMode) -> tuple[int, ...]:
        """Return fixed algorithm inputs included in cache identity.

        Args:
            mode: Validated detail preview mode.

        Returns:
            Mode-specific sampling limits and location-policy inputs.
        """
        # Deterministic fractional locations are encoded in thousandths.
        if mode in {"centerSample", "representativeSample"}:
            offsets = (
                DETAIL_PROXY_CENTER_OFFSETS
                if mode == "centerSample"
                else DETAIL_PROXY_REPRESENTATIVE_OFFSETS
            )
            return (
                DETAIL_PROXY_MAX_DIMENSION,
                DETAIL_PROXY_MAX_SOURCE_BLOCK_READS,
                DETAIL_PROXY_MAX_DECODED_SOURCE_BYTES,
                *(round(value * 1000) for offset in offsets for value in offset),
            )
        return (
            DETAIL_PREVIEW_PATCH_DIMENSION,
            DETAIL_PROXY_MAX_SOURCE_BLOCK_READS,
            DETAIL_PROXY_MAX_DECODED_SOURCE_BYTES,
            *(round(value * 1000) for value in DETAIL_PREVIEW_CANDIDATE_FRACTIONS),
        )

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
        cache_key: RasterDetailPreviewCacheKey = (
            request.collection_id,
            request.item_id,
            authorized_raster.source_signature,
            raster_extent,
            DETAIL_PREVIEW_POLICY_VERSION,
            request.mode,
            self._mode_parameters(request.mode),
        )
        async with self._state_lock:
            cached = self._cache.get(cache_key)
            if cached is not None:
                self._cache.move_to_end(cache_key)
                return cached
            task = self._inflight.get(cache_key)
            if task is None:
                task = asyncio.create_task(
                    self._compute(
                        authorized_raster,
                        request.mode,
                        raster_extent,
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
        raster_extent: tuple[float, float, float, float],
        cache_key: RasterDetailPreviewCacheKey,
    ) -> RasterDetailPreview:
        """Compute and cache one source version within read capacity.

        Args:
            authorized_raster: Source identity approved at request start.
            mode: Explicit preview mode.
            raster_extent: Cataloged WGS 84 raster extent.
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
