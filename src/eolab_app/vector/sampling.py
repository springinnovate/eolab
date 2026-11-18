"""Authorize vector selections and read feature counts, bounds, outlines or parcels.

Source/filter preparation lives in selection_source so readers and installed Jobs
operations use the same rules without constructing this service.
This service retains selection authorization and execution routing;
an unavailable outline does not prevent numeric analysis of the selection.
"""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Any, Protocol
from eolab_app.catalog.vector_contract import CatalogVectorRequest
from eolab_app.attribute_filter import VectorFilter
from eolab_app.feature_predicate import DrawingSelection, PolygonAreaReference, VectorSourceOwners
from eolab_app.polygon_areas import PolygonSummaryInput, SummaryPolygon

from eolab_app.catalog_selection import (
    CatalogSelection,
    ResolvedCatalogSelection,
    ArtifactVectorSelection,
    SelectionUnavailableError,
    UploadedSelection,
    UploadedVectorFilterRequest,
    VectorSelection,
)
from eolab_app.vector.errors import VectorConflictError, VectorFeatureError
from eolab_app.vector.filters import (
    CatalogVectorFilterRequest,
)
from eolab_app.vector.ports import VectorCatalog
from eolab_app.vector.parcel_models import (
    ParcelId,
    ParcelIdRequest,
    ParcelIdValidation,
    ParcelIdValidationResponse,
    ParcelLookupRequest,
    ParcelLookupResponse,
    ParcelRowsRequest,
    ParcelRowsPage,
    ParcelRowsResponse,
)
from eolab_app.vector.selection_source import resolve_selection
from eolab_app.vector.sources import MountedVectorResolver
from eolab_app.vector.spatial_read import SpatialReads
from eolab_app.vector_uploads import VectorUploadStore
from eolab_app.source_files import (
    LeasedSourceFiles,
    SourceFileError,
    finish_source_task,
)


class VectorSelectionExecutor(Protocol):
    """Run a vector read while the caller retains any private result source lease."""

    async def __call__(
        self,
        selection: VectorSelection,
        upload_owner: str | None = None,
        read_lease: str | None = None,
        spatial_read: str | None = None,
    ) -> dict[str, Any]:
        """Read original features through Jobs and wait for native exit on cancellation.

        Args:
            selection: Original source, predicate and view fields.
            upload_owner: Private upload owner or None.
            read_lease: Held result-file capability or None for Catalog/uploads.
            spatial_read: Short-lived access to original IDs from authorized intersecting views.

        Returns:
            Operation-owned measurements or display geometry.
        """
        ...


class VectorParcelExecutor(Protocol):
    """Execute Catalog parcel validation, lookups and pages without rendering state."""

    async def validate_ids(
        self, selection: CatalogSelection, id_field: str
    ) -> ParcelIdValidation:
        """Validate all original IDs in a whole-layer Catalog selection.

        Args:
            selection: Authorized Catalog descriptor with an inactive filter.
            id_field: One original string or integer attribute.

        Returns:
            Complete-layer validation, never a sampled or truncated success.

        Raises:
            VectorConflictError: The source, IDs or execution are unavailable.
        """
        ...

    async def lookup_parcel(
        self, selection: CatalogSelection, id_field: str, parcel_id: ParcelId
    ) -> bool:
        """Find an exact typed ID in the complete original Catalog layer.

        Args:
            selection: Authorized Catalog descriptor with an inactive filter.
            id_field: Original field previously validated for parcel identity.
            parcel_id: Exact typed ID to find.

        Returns:
            Whether the original layer contains the requested typed ID.

        Raises:
            VectorConflictError: Source reading or execution is unavailable.
        """
        ...

    async def read_rows(
        self,
        selection: CatalogSelection,
        id_field: str,
        fields: tuple[str, ...],
        offset: int,
        limit: int,
    ) -> ParcelRowsPage:
        """Read a page of exact filtered parcel IDs and display attributes.

        Args:
            selection: Authorized Catalog descriptor and ordinary current filter.
            id_field: Original parcel ID field.
            fields: Requested original display attributes.
            offset: Matching rows to skip.
            limit: Maximum rows to return.

        Returns:
            Complete page with its next offset, including empty success.

        Raises:
            VectorConflictError: The source, fields or execution are unavailable.
        """
        ...


class VectorSamplingService:
    """Authorize vector sources for counts, bounds, outlines and parcel identity/rows."""

    def __init__(
        self,
        catalog: VectorCatalog,
        resolver: MountedVectorResolver,
        outline_executor: VectorSelectionExecutor | None = None,
        *,
        selection_executor: VectorSelectionExecutor | None = None,
        extent_executor: VectorSelectionExecutor | None = None,
        parcel_executor: VectorParcelExecutor | None = None,
        uploads: VectorUploadStore | None = None,
        artifact_files: Callable[[], LeasedSourceFiles] | None = None,
        read_drawing: Callable[[str, PolygonAreaReference], Awaitable[PolygonSummaryInput]] | None = None,
    ) -> None:
        """Connect vector source resolution with feature-count, extent and outline jobs.

        Args:
            catalog: Authoritative Catalog reader.
            resolver: Exact mounted vector source resolver.
            outline_executor: Jobs adapter supplied by application composition.
                Omit for selection-only consumers; outline() then reports
                unavailable without starting local display work.
            selection_executor: Jobs adapter for counting filtered features.
                Consumers that only reauthorize descriptors may omit it; select()
                then reports unavailable without launching a local process.
            extent_executor: Jobs adapter for original-source bounds; omit when
                the consumer does not offer filtered map zoom.
            parcel_executor: Jobs adapter for Catalog parcel ID validation,
                membership lookups and page reads; omit for consumers without them.
            uploads: Original browser-owned GeoPackages and their admission metadata.
            artifact_files: Composition-supplied access to immutable result files;
                resolved when used, after the owning source service is composed.
            read_drawing: Load committed drawing polygons under their Processing session.
        """
        self.catalog = catalog
        self.resolver = resolver
        self._outline_executor = outline_executor
        self._selection_executor = selection_executor
        self._uploads = uploads
        self._extent_executor = extent_executor
        self._parcel_executor = parcel_executor
        self._artifact_files = artifact_files
        self._read_drawing = read_drawing
        self.spatial_reads = SpatialReads()

    async def validate_parcel_ids(
        self, request: ParcelIdRequest
    ) -> ParcelIdValidationResponse:
        """Authorize a full Catalog layer and validate one original parcel ID field.

        Args:
            request: Catalog source identity and original ID field; no display filter.

        Returns:
            Complete-layer ID validation tied to its authoritative asset/layer identity.

        Raises:
            VectorFeatureError: Catalog identity or source resolution failed.
            VectorConflictError: IDs, native reading or the executor are unavailable.
            asyncio.CancelledError: After the executor's bounded cancellation cleanup.
        """
        if self._parcel_executor is None:
            raise VectorConflictError("The parcel reader is unavailable")
        resolved = await resolve_selection(
            self.catalog,
            self.resolver,
            CatalogVectorFilterRequest(
                collectionId=request.collection_id,
                itemId=request.item_id,
                filter=VectorFilter(),
            ),
        )
        validation = await self._parcel_executor.validate_ids(
            resolved.selection, request.idField
        )
        return ParcelIdValidationResponse(
            **validation.model_dump(), selection=resolved.selection
        )

    async def lookup_parcel(self, request: ParcelLookupRequest) -> ParcelLookupResponse:
        """Authorize a Catalog layer and find one typed ID across its original features.

        Whole-layer uniqueness is validated when choosing the ID field. This lookup
        checks only membership and does not apply the current view filter.

        Args:
            request: Catalog source, original ID field and exact typed parcel ID.

        Returns:
            Original-layer membership and the authoritative source descriptor.

        Raises:
            VectorFeatureError: Catalog identity or source resolution failed.
            VectorConflictError: Native reading or the executor is unavailable.
            asyncio.CancelledError: After the executor's bounded cancellation cleanup.
        """
        if self._parcel_executor is None:
            raise VectorConflictError("The parcel reader is unavailable")
        resolved = await resolve_selection(
            self.catalog,
            self.resolver,
            CatalogVectorFilterRequest(
                collectionId=request.collection_id,
                itemId=request.item_id,
                filter=VectorFilter(),
            ),
        )
        found = await self._parcel_executor.lookup_parcel(
            resolved.selection, request.idField, request.parcelId
        )
        return ParcelLookupResponse(found=found, selection=resolved.selection)

    async def read_parcel_rows(self, request: ParcelRowsRequest) -> ParcelRowsResponse:
        """Authorize and page the currently filtered original Catalog parcels.

        Full-layer ID validation belongs to tool configuration, not each page read.

        Args:
            request: Catalog source/filter, original ID/display fields and page bounds.

        Returns:
            Current source descriptor and complete page with lossless typed IDs.

        Raises:
            VectorFeatureError: Catalog identity, filters or source resolution failed.
            VectorConflictError: Native reading or the executor are unavailable.
            asyncio.CancelledError: After the executor's bounded cancellation cleanup.
        """
        if self._parcel_executor is None:
            raise VectorConflictError("The parcel reader is unavailable")
        resolved = await resolve_selection(self.catalog, self.resolver, request)
        page = await self._parcel_executor.read_rows(
            resolved.selection,
            request.idField,
            request.fields,
            request.offset,
            request.limit,
        )
        return ParcelRowsResponse(**page.model_dump(), selection=resolved.selection)

    @asynccontextmanager
    async def open_selection(
        self, selection: VectorSelection, source_owner: str | VectorSourceOwners | None = None
    ) -> AsyncIterator[ResolvedCatalogSelection]:
        """Retain a private result until the caller finishes reading its original features.

        Args:
            selection: Source identity, predicate and calculated-field definitions.
            source_owner: Browser identity for the selected upload or Processing result.

        Yields:
            Validated original source with a renewable lease for a result file.

        Raises:
            SelectionUnavailableError: If source identity, fields or access are invalid.
            SourceFileError: If a result's ownership, expiry or lease changes.
            asyncio.CancelledError: After the native metadata read finishes.
        """
        if selection.filter.intersections:
            from eolab_app.feature_intersection import bind_intersections

            async with AsyncExitStack() as stack:
                async def read_layer(source: VectorSelection | DrawingSelection) -> ResolvedCatalogSelection | tuple[SummaryPolygon, ...]:
                    """Open a polygon view for the duration of this read, including its own active conditions."""
                    if isinstance(source, DrawingSelection):
                        return await self.drawing_polygons(source, source_owner)
                    return await stack.enter_async_context(self.open_selection(source, source_owner))

                async with self._open_original(selection, source_owner) as original:
                    yield await bind_intersections(original, read_layer)
            return
        async with self._open_original(selection, source_owner) as original:
            yield original

    async def drawing_polygons(
        self, selection: DrawingSelection, owners: str | VectorSourceOwners | None,
    ) -> tuple[SummaryPolygon, ...]:
        """Read the coordinates saved for a filtered drawing.

        Args:
            selection: A private drawing reference or a view with zero matching polygons.
            owners: The browser credentials established for the current read.

        Returns:
            Authorized WGS84 polygons in their original drawing order.

        Raises:
            SelectionUnavailableError: If the browser has no access to the drawing.
        """
        if selection.polygonArea is None:
            return ()
        owner = owners.processing if isinstance(owners, VectorSourceOwners) else None
        if self._read_drawing is None or owner is None:
            raise SelectionUnavailableError("This drawing is unavailable to this browser.")
        return (await self._read_drawing(owner, selection.polygonArea)).polygons

    @asynccontextmanager
    async def _open_original(
        self, selection: VectorSelection, owners: str | VectorSourceOwners | None,
    ) -> AsyncIterator[ResolvedCatalogSelection]:
        """Hold the original vector file while its feature predicate is prepared and read.

        Args:
            selection: Catalog, upload or run-result identity with its predicate.
            owners: The appropriate owner for a single source, or both browser credentials.

        Yields:
            Its authorized original dataset before spatial membership is evaluated.

        Raises:
            SelectionUnavailableError: If identity, schema or private ownership is invalid.
        """
        source_owner = owners.for_source(selection) if isinstance(owners, VectorSourceOwners) else owners
        if not isinstance(selection, ArtifactVectorSelection):
            resolved = await resolve_selection(self.catalog, self.resolver, selection, self._uploads, source_owner)
            if resolved.selection != selection:
                raise SelectionUnavailableError("The selected vector identity changed; select it again.")
            yield resolved
            return
        from eolab_app.bounded_vector import resolve_vector_file_selection

        if self._artifact_files is None or source_owner is None:
            raise SelectionUnavailableError(
                "This vector result is unavailable to this browser."
            )
        async with self._artifact_files().open(
            source_owner, selection.jobId, selection.artifactId
        ) as source:
            if source.media_type != "application/geopackage+sqlite3":
                raise SelectionUnavailableError("Choose a vector GeoPackage result.")
            metadata = asyncio.create_task(
                asyncio.to_thread(resolve_vector_file_selection, source.path, selection)
            )
            try:
                yield await asyncio.shield(metadata)
            finally:
                await finish_source_task(metadata)

    async def _execute_selection(
        self,
        selection: VectorSelection,
        source_owner: str | None,
        executor: VectorSelectionExecutor,
    ) -> dict[str, Any]:
        """Run the requested vector read under its original result-file lease.

        Args:
            selection: Authorized source descriptor and predicate.
            source_owner: Source-appropriate private browser identity.
            executor: Configured Jobs adapter for counts, bounds or outlines.

        Returns:
            The operation's completed result after native work has stopped.

        Raises:
            SelectionUnavailableError: If private source access is not configured.
            SourceFileError: If result authorization or lease renewal fails.
        """
        if selection.filter.intersections:
            async with self.open_selection(selection, source_owner) as resolved, AsyncExitStack() as access:
                owner = source_owner.for_source(selection) if isinstance(source_owner, VectorSourceOwners) else source_owner
                lease = None
                if isinstance(selection, ArtifactVectorSelection):
                    source = await access.enter_async_context(self._artifact_files().open(owner, selection.jobId, selection.artifactId))
                    lease = source.lease_id
                with self.spatial_reads.hold(resolved.intersections) as token:
                    return await executor(selection, owner if isinstance(selection, UploadedSelection) else None, lease, token)
        if isinstance(source_owner, VectorSourceOwners):
            source_owner = source_owner.for_source(selection)
        if not isinstance(selection, ArtifactVectorSelection):
            return await executor(selection, source_owner)
        if self._artifact_files is None or source_owner is None:
            raise SelectionUnavailableError(
                "This vector result is unavailable to this browser."
            )
        async with self._artifact_files().open(
            source_owner, selection.jobId, selection.artifactId
        ) as source:
            return await executor(selection, None, source.lease_id)

    async def resolve_for_sampling(
        self, selection: VectorSelection, source_owner: str | VectorSourceOwners | None = None
    ) -> ResolvedCatalogSelection:
        """Authorize a feature selection against its source identity and filter.

        Use open_selection() instead when native reads of a private result must
        remain protected from cleanup after this metadata resolution returns.

        Args:
            selection: Validated original source identity and feature filter.
            source_owner: Server-derived upload or Processing source owner.

        Returns:
            Authorized dataset path and feature filter.

        Raises:
            SelectionUnavailableError: If source identity or predicate is invalid.
            VectorUploadError: If the upload is unavailable to this browser.
        """
        try:
            if isinstance(selection, ArtifactVectorSelection) or selection.filter.intersections or isinstance(source_owner, VectorSourceOwners):
                async with self.open_selection(selection, source_owner) as resolved:
                    return resolved
            resolved = await resolve_selection(
                self.catalog, self.resolver, selection, self._uploads, source_owner
            )
        except SelectionUnavailableError:
            raise
        except VectorConflictError as error:
            raise SelectionUnavailableError(error.detail) from error
        except (VectorFeatureError, OSError, ValueError) as error:
            raise SelectionUnavailableError(
                "The selected vector is unavailable; select it again."
            ) from error
        if resolved.selection != selection:
            raise SelectionUnavailableError(
                "The selected vector identity changed; select it again."
            )
        return resolved

    async def resolve_source(
        self, source: CatalogVectorRequest
    ) -> ResolvedCatalogSelection:
        """Authorize a current full catalog layer without scanning its features.

        Args:
            source: Configured catalog collection and item.

        Returns:
            Full-layer selection and authorized path for one calculation.

        Raises:
            SelectionUnavailableError: If catalog access or source inspection fails.
        """
        request = CatalogVectorFilterRequest(
            collectionId=source.collection_id,
            itemId=source.item_id,
            filter=VectorFilter(),
        )
        try:
            return await resolve_selection(self.catalog, self.resolver, request)
        except (VectorFeatureError, OSError, ValueError) as error:
            raise SelectionUnavailableError(
                "The configured catalog vector source is missing or unreadable."
            ) from error

    async def select(
        self,
        request: (
            CatalogVectorFilterRequest
            | UploadedVectorFilterRequest
            | ArtifactVectorSelection
        ),
        source_owner: str | None = None,
    ) -> dict[str, Any]:
        """Count filtered features and return the selection for later polygon reads.

        Args:
            request: Original source identity and typed predicate.
            source_owner: Server-derived upload or Processing source owner.

        Returns:
            Exact matched/total counts and a path-free selection descriptor.
            Polygon geometry is read by the calculation or optional outline.

        Raises:
            VectorConflictError: If unavailable, empty, over budget or queue-full.
            SelectionUnavailableError: If the source cannot be read.
            VectorUploadError: If the upload is unavailable to this browser.
            asyncio.CancelledError: After the Jobs client cancels abandoned work.
        """
        resolved = (
            await self.resolve_for_sampling(request, source_owner)
            if isinstance(request, ArtifactVectorSelection)
            else await resolve_selection(
                self.catalog, self.resolver, request, self._uploads,
                source_owner.uploads if isinstance(source_owner, VectorSourceOwners) else source_owner,
            )
        )
        if self._selection_executor is None:
            raise VectorConflictError("The vector selection executor is unavailable")
        if isinstance(resolved.selection, UploadedSelection):
            await asyncio.to_thread(self._uploads.prepare_source_read, resolved.path)
        result = await self._execute_selection(
            resolved.selection, source_owner, self._selection_executor
        )
        return {
            **result,
            "selection": resolved.selection.model_dump(mode="json", by_alias=True),
            "filter": request.filter.model_dump(mode="json"),
            "label": (
                resolved.selection.layerName
                if isinstance(
                    request, (UploadedVectorFilterRequest, ArtifactVectorSelection)
                )
                else request.item_id
            ),
        }

    async def extent(
        self,
        request: (
            CatalogVectorFilterRequest
            | UploadedVectorFilterRequest
            | ArtifactVectorSelection
        ),
        source_owner: str | None = None,
    ) -> dict[str, Any]:
        """Return original-source bounds for the complete accepted filter.

        Args:
            request: Original source identity and immutable typed predicate.
            source_owner: Server-derived upload or Processing source owner.

        Returns:
            Matched count and WGS84 bbox, or null when matches have no coordinates.

        Raises:
            VectorConflictError: If execution is unavailable or the read fails.
            SelectionUnavailableError: If the original source cannot be read.
            VectorUploadError: If the upload is unavailable to this browser.
            asyncio.CancelledError: After Jobs cancels and cleans up abandoned work.
        """
        resolved = (
            await self.resolve_for_sampling(request, source_owner)
            if isinstance(request, ArtifactVectorSelection)
            else await resolve_selection(
                self.catalog, self.resolver, request, self._uploads,
                source_owner.uploads if isinstance(source_owner, VectorSourceOwners) else source_owner,
            )
        )
        if self._extent_executor is None:
            raise VectorConflictError("The vector zoom executor is unavailable")
        if isinstance(resolved.selection, UploadedSelection):
            await asyncio.to_thread(self._uploads.prepare_source_read, resolved.path)
        return await self._execute_selection(
            resolved.selection, source_owner, self._extent_executor
        )

    async def outline(
        self, selection: VectorSelection, source_owner: str | None = None
    ) -> dict[str, Any]:
        """Create a simplified map outline of the selected features.

        Args:
            selection: Catalog or upload descriptor returned by selection.
            source_owner: Server-derived upload or Processing source owner.

        Returns:
            Approximate FeatureCollection for map display only.

        Raises:
            VectorConflictError: If no executor is supplied, or Jobs display work
                is unavailable or over budget.
            SelectionUnavailableError: If the source identity is invalid.
            VectorUploadError: If the upload is unavailable to this browser.
            asyncio.CancelledError: After the executor's bounded cleanup.
        """
        resolved = await self.resolve_for_sampling(selection, source_owner)
        if self._outline_executor is None:
            raise VectorConflictError("The map outline executor is unavailable")
        if isinstance(selection, UploadedSelection):
            await asyncio.to_thread(self._uploads.prepare_source_read, resolved.path)
        result = await self._execute_selection(
            selection, source_owner, self._outline_executor
        )
        return result
