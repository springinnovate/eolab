"""Authorize vector sources and read counts, bounds, attributes or outlines.

Source/filter preparation lives in selection_source so readers and installed Jobs
operations use the same rules without constructing this service.
This service retains selection authorization and execution routing;
an unavailable outline does not prevent numeric analysis of the selection.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import replace
from typing import TYPE_CHECKING, Any, Protocol
from eolab_app.catalog.vector_contract import CatalogVectorRequest
from eolab_app.attribute_filter import VectorFilter
from eolab_app.polygon_areas import SummaryPolygon

from eolab_app.catalog_selection import (
    CatalogSelection,
    FeatureMatches,
    ResolvedCatalogSelection,
    ArtifactVectorSelection,
    SelectionUnavailableError,
    UploadedSelection,
    UploadedVectorFilterRequest,
    VectorSelection,
    DrawingReference,
    DrawingSelection,
    VectorSourceOwners,
)
from eolab_app.vector.errors import VectorConflictError, VectorFeatureError
from eolab_app.vector.field_statistics import (
    VectorFieldStatistics,
    VectorLayerStatisticsRequest,
)
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
from eolab_app.vector.lasso import LASSO_EXECUTION_SECONDS, LassoRead, LassoSelectionResult
from eolab_app.vector.feature_attributes import (
    FeatureAttributesRequest,
    FeatureAttributesResult,
)
from eolab_app.vector.spatial_read import (
    INTERSECTION_SECONDS,
    SpatialReads,
    worker_layer,
)
from eolab_app.vector_uploads import VectorUploadStore
from eolab_app.source_files import (
    LeasedSourceFiles,
    SourceFileError,
    finish_source_task,
)


if TYPE_CHECKING:
    from eolab_app.feature_intersection import IntersectionLayer


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
        spatial_read: str | None = None,
    ) -> ParcelRowsPage:
        """Read a page of exact filtered parcel IDs and display attributes.

        Args:
            selection: Authorized Catalog descriptor and ordinary current filter.
            id_field: Original parcel ID field.
            fields: Requested original display attributes.
            offset: Matching rows to skip.
            limit: Maximum rows to return.
            spatial_read: Temporary original-feature membership for a spatially filtered page.

        Returns:
            Complete page with its next offset, including empty success.

        Raises:
            VectorConflictError: The source, fields or execution are unavailable.
        """
        ...


class VectorSamplingService:
    """Authorize original vector layers and coordinate reads of their features."""

    def __init__(
        self,
        catalog: VectorCatalog,
        resolver: MountedVectorResolver,
        outline_executor: VectorSelectionExecutor | None = None,
        *,
        selection_executor: VectorSelectionExecutor | None = None,
        extent_executor: VectorSelectionExecutor | None = None,
        parcel_executor: VectorParcelExecutor | None = None,
        layer_statistics_executor: Callable[
            [VectorLayerStatisticsRequest, str | None, str | None],
            Awaitable[tuple[VectorFieldStatistics, ...]],
        ] | None = None,
        uploads: VectorUploadStore | None = None,
        artifact_files: Callable[[], LeasedSourceFiles] | None = None,
        read_drawing: Callable[[str, DrawingReference], Awaitable[tuple[SummaryPolygon, ...]]] | None = None,
        comparison_executor: Callable[[str, int], Awaitable[None]] | None = None,
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
            layer_statistics_executor: Jobs adapter for complete-layer attribute statistics.
            uploads: Original browser-owned GeoPackages and their admission metadata.
            artifact_files: Composition-supplied access to immutable result files;
                resolved when used, after the owning source service is composed.
            read_drawing: Read a saved drawing revision or a device-only input owned by this browser.
            comparison_executor: Run the credentialed native job with its execution deadline in seconds.
        """
        self.catalog = catalog
        self.resolver = resolver
        self._outline_executor = outline_executor
        self._selection_executor = selection_executor
        self._uploads = uploads
        self._extent_executor = extent_executor
        self._parcel_executor = parcel_executor
        self._layer_statistics_executor = layer_statistics_executor
        self._artifact_files = artifact_files
        self._read_drawing = read_drawing
        self.spatial_reads = SpatialReads()
        self._comparison_executor = comparison_executor

    async def layer_statistics(
        self,
        request: VectorLayerStatisticsRequest,
        source_owner: str | VectorSourceOwners | None,
    ) -> tuple[VectorFieldStatistics, ...]:
        """Read whole-layer benchmarks while the original source is authorized.

        Jobs schedules the read and owns its execution budget. A result-file
        lease stays open until Jobs confirms that native work has stopped.

        Args:
            request: Unfiltered source identity and selected numeric fields.
            source_owner: Server-derived identity for a private source, if any.

        Returns:
            Complete original-layer statistics for the requested fields.

        Raises:
            SelectionUnavailableError: If the original source cannot be resolved.
            SourceFileError: If the private result is unavailable or its lease is lost.
            VectorUploadError: If the upload is unavailable or inaccessible to Jobs.
            VectorConflictError: If reading fails or exceeds the deadline.
            asyncio.CancelledError: After a cancelled native read finishes.
        """
        if self._layer_statistics_executor is None:
            raise VectorConflictError("Layer statistics are unavailable.")
        async with self._open_original(request.source, source_owner) as source:
            if source.upload_owner is not None:
                await asyncio.to_thread(self._uploads.prepare_source_read, source.path)
            return await self._layer_statistics_executor(
                request, source.upload_owner, source.read_lease
            )

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

    async def read_parcel_rows(
        self, request: ParcelRowsRequest, source_owner: VectorSourceOwners | None = None,
    ) -> ParcelRowsResponse:
        """Authorize and page the currently filtered original Catalog parcels.

        Full-layer ID validation belongs to tool configuration, not each page read.

        Args:
            request: Catalog source/filter, original ID/display fields and page bounds.
            source_owner: The browser's credentials when a spatial condition needs private access.

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
        if request.filter.intersections:
            async with self.open_selection(resolved.selection, source_owner) as target:
                with self.spatial_reads.hold(target.matches.model_dump(mode="json")) as (token, _):
                    page = await self._parcel_executor.read_rows(resolved.selection, request.idField, request.fields,
                                                                request.offset, request.limit, token)
            return ParcelRowsResponse(**page.model_dump(), selection=resolved.selection)
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
        async with AsyncExitStack() as stack:
            original = await stack.enter_async_context(self._open_original(selection, source_owner))

            async def read_layer(source: VectorSelection | DrawingSelection) -> IntersectionLayer:
                """Keep the chosen polygon source available until the consumer finishes."""
                return await stack.enter_async_context(self.open_polygon_view(source, source_owner))

            from eolab_app.feature_intersection import bind_intersections
            yield await bind_intersections(original, read_layer, compare=self.compare_layers)

    @asynccontextmanager
    async def open_polygon_view(
        self, selection: VectorSelection | DrawingSelection, owners: str | VectorSourceOwners | None,
    ) -> AsyncIterator[ResolvedCatalogSelection | tuple[SummaryPolygon, ...]]:
        """Keep a polygon view and every source of its selected features authorized during a read.

        Args:
            selection: Filtered original vector, committed drawings, or an empty drawing view.
            owners: The browser credentials established for the current read.

        Yields:
            The authorized original file, or WGS84 drawings in their original order.

        Raises:
            SelectionUnavailableError: If the browser has no access to the drawing.
        """
        if not isinstance(selection, DrawingSelection):
            async with self.open_selection(selection, owners) as original:
                yield original
            return
        async with AsyncExitStack() as access:
            if selection.filter is not None:
                for rule in selection.filter.intersections:
                    await access.enter_async_context(self.open_polygon_view(rule.source, owners))
            if selection.polygonArea is None:
                yield ()
            else:
                owner = owners.processing if isinstance(owners, VectorSourceOwners) else None
                if self._read_drawing is None or owner is None:
                    raise SelectionUnavailableError("This drawing is unavailable to this browser.")
                yield await self._read_drawing(owner, selection.polygonArea)

    async def compare_layers(
        self, target: IntersectionLayer, boundaries: dict[str, IntersectionLayer], predicate: VectorFilter,
        drawing_properties: tuple[dict[str, str], ...] = (),
    ) -> FeatureMatches:
        """Queue one read of the original target and all filtered polygon sources.

        Args:
            target: Unfiltered vector or committed target drawings.
            boundaries: Authorized polygon views keyed by their map-layer ID.
            predicate: Field and spatial conditions on the target.
            drawing_properties: Name and note in target order for drawing filters.

        Returns:
            Matching original IDs and the total target feature count.

        Raises:
            VectorConflictError: If the Jobs worker is unavailable or cannot return the comparison.
        """
        if self._comparison_executor is None:
            raise VectorConflictError("The polygon intersection reader is unavailable.")
        for layer in (target, *boundaries.values()):
            if isinstance(layer, ResolvedCatalogSelection) and layer.upload_owner:
                await asyncio.to_thread(self._uploads.prepare_source_read, layer.path)
        inputs = {
            "target": worker_layer(target),
            "boundaries": {
                key: worker_layer(layer) for key, layer in boundaries.items()
            },
            "filter": predicate.model_dump(mode="json", by_alias=True),
            "drawingProperties": drawing_properties,
        }
        with self.spatial_reads.hold(inputs) as (token, read):
            await self._comparison_executor(token, INTERSECTION_SECONDS)
            if read.result is None:
                raise VectorConflictError("The polygon intersection reader returned no result.")
            return read.result

    async def lasso(
        self,
        selection: VectorSelection,
        polygon: SummaryPolygon,
        source_owner: str | VectorSourceOwners | None = None,
    ) -> LassoSelectionResult:
        """Select whole original features touching a user-drawn polygon.

        Args:
            selection: Catalog, upload or result identity with its applied filter.
            polygon: Validated closed WGS84 outline captured by the map tool.
            source_owner: Browser credentials for every private referenced source.

        Returns:
            Exact IDs, count and complete ordered attributes, with optional whole-feature outlines.
            An outline timeout preserves the completed rows after the native job exits.

        Raises:
            SelectionUnavailableError: If the source identity or access is invalid.
            VectorConflictError: The comparison or complete attribute read failed.
            asyncio.CancelledError: After native work has stopped using its sources.
        """
        if self._comparison_executor is None:
            raise VectorConflictError("The polygon intersection reader is unavailable.")
        async with self.open_selection(selection, source_owner) as target:
            if target.upload_owner:
                await asyncio.to_thread(self._uploads.prepare_source_read, target.path)
            inputs = {
                "target": worker_layer(target),
                "lasso": polygon.model_dump(mode="json"),
            }
            deadline = asyncio.timeout(None)
            read = LassoRead(deadline)
            with self.spatial_reads.hold(inputs, lasso=read) as (token, _):
                try:
                    async with deadline:
                        await self._comparison_executor(token, LASSO_EXECUTION_SECONDS)
                except TimeoutError as error:
                    if read.result is None:
                        raise VectorConflictError(
                            "Selecting these features took too long. Select a smaller area and try again."
                        ) from error
                except VectorConflictError:
                    if read.result is None:
                        raise
            if read.result is None:
                raise VectorConflictError(
                    "The Lasso reader returned no feature attributes."
                )
            return read.result

    async def read_feature_attributes(
        self,
        request: FeatureAttributesRequest,
        source_owner: str | VectorSourceOwners | None = None,
    ) -> FeatureAttributesResult:
        """Authorize selected native IDs and read their original scalar attributes.

        Args:
            request: Path-free filtered source and unique ordered native-ID text.
            source_owner: Browser credentials for every private referenced source.

        Returns:
            Complete identified attributes and the original source descriptor,
            independently of map visibility or optional display geometry.

        Raises:
            SelectionUnavailableError: If source identity or access is invalid.
            VectorUploadError: If the selected upload is unavailable to this browser.
            SourceFileError: If a private result expires or loses its read lease.
            VectorFeatureError: If Catalog access, the filter, or the complete
                bounded attribute read fails.
            asyncio.CancelledError: After native work stops using its sources.
        """
        from eolab_app.vector.feature_attributes import read_feature_attributes

        async with self.open_selection(request.selection, source_owner) as target:
            native_ids = tuple(int(feature_id) for feature_id in request.featureIds)
            return await read_feature_attributes(target, native_ids)

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
            yield replace(resolved, upload_owner=source_owner) if isinstance(selection, UploadedSelection) else resolved
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
                yield replace(await asyncio.shield(metadata), read_lease=source.lease_id)
            finally:
                await finish_source_task(metadata)

    async def _execute_selection(
        self,
        selection: VectorSelection,
        source_owner: str | VectorSourceOwners | None,
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
            async with self.open_selection(selection, source_owner) as resolved:
                with self.spatial_reads.hold(resolved.matches.model_dump(mode="json")) as (token, _):
                    return await executor(selection, resolved.upload_owner, resolved.read_lease, token)
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

    async def resolve_original_selection(
        self, selection: CatalogSelection | UploadedSelection, source_owner: str | None = None,
    ) -> ResolvedCatalogSelection:
        """Authorize the original Catalog or upload file and validate all its field conditions.

        Args:
            selection: Captured source identity, filter and calculated fields.
            source_owner: Browser upload owner at admission, or None for a Catalog file.

        Returns:
            Original file and its validated predicate, ready for a job to bind spatial conditions.

        Raises:
            SelectionUnavailableError: If the source identity or field validation fails.
            VectorUploadError: If the browser cannot access the upload.
        """
        try:
            async with self._open_original(selection, source_owner) as original:
                return original
        except (VectorFeatureError, OSError, ValueError) as error:
            raise SelectionUnavailableError(str(error)) from error

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
            async with self.open_selection(selection, source_owner) as resolved:
                return resolved
        except SelectionUnavailableError:
            raise
        except VectorConflictError as error:
            raise SelectionUnavailableError(error.detail) from error
        except (VectorFeatureError, OSError, ValueError) as error:
            raise SelectionUnavailableError(
                "The selected vector is unavailable; select it again."
            ) from error

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

    async def _resolve_request_source(
        self, request: CatalogVectorFilterRequest | UploadedVectorFilterRequest | ArtifactVectorSelection,
        owners: str | VectorSourceOwners | None,
    ) -> ResolvedCatalogSelection:
        """Resolve a count or extent request before the Jobs reader applies its filter.

        Args:
            request: Submitted target and predicate.
            owners: Private credentials for this request.

        Returns:
            The target's validated original identity and schema.

        Raises:
            SelectionUnavailableError: If a private result cannot be opened.
            VectorFeatureError: If catalog or upload metadata cannot validate the selection.
        """
        if isinstance(request, ArtifactVectorSelection):
            async with self._open_original(request, owners) as original:
                return original
        upload_owner = owners.uploads if isinstance(owners, VectorSourceOwners) else owners
        return await resolve_selection(self.catalog, self.resolver, request, self._uploads, upload_owner)

    async def select(
        self,
        request: (
            CatalogVectorFilterRequest
            | UploadedVectorFilterRequest
            | ArtifactVectorSelection
        ),
        source_owner: str | VectorSourceOwners | None = None,
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
        resolved = await self._resolve_request_source(request, source_owner)
        if request.filter.intersections:
            async with self.open_selection(resolved.selection, source_owner) as target:
                result = target.matches.counts
                if not result["matched"]:
                    raise VectorConflictError("No matching polygon features; change the filter")
        else:
            if self._selection_executor is None:
                raise VectorConflictError("The vector selection executor is unavailable")
            if isinstance(resolved.selection, UploadedSelection):
                await asyncio.to_thread(self._uploads.prepare_source_read, resolved.path)
            result = await self._execute_selection(resolved.selection, source_owner, self._selection_executor)
        return {
            **result,
            "selection": resolved.selection.model_dump(mode="json", by_alias=True),
            "filter": request.filter.model_dump(mode="json", by_alias=True),
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
        source_owner: str | VectorSourceOwners | None = None,
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
        resolved = await self._resolve_request_source(request, source_owner)
        if self._extent_executor is None:
            raise VectorConflictError("The vector zoom executor is unavailable")
        if isinstance(resolved.selection, UploadedSelection):
            await asyncio.to_thread(self._uploads.prepare_source_read, resolved.path)
        return await self._execute_selection(
            resolved.selection, source_owner, self._extent_executor
        )

    async def outline(
        self, selection: VectorSelection, source_owner: str | VectorSourceOwners | None = None
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
        if self._outline_executor is None:
            raise VectorConflictError("The map outline executor is unavailable")
        if selection.filter.intersections:
            return await self._execute_selection(selection, source_owner, self._outline_executor)
        resolved = await self.resolve_for_sampling(selection, source_owner)
        if isinstance(selection, UploadedSelection):
            await asyncio.to_thread(self._uploads.prepare_source_read, resolved.path)
        result = await self._execute_selection(
            selection, source_owner, self._outline_executor
        )
        return result
