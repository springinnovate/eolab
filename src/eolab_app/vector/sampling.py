"""Authorize vector selections, count features, and request bounds or map outlines.

Source/filter preparation lives in selection_source so readers and installed Jobs
operations use the same rules without constructing this service.
This service retains selection authorization and execution routing;
an unavailable outline does not prevent numeric analysis of the selection.
"""

import asyncio
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any, Protocol
from eolab_app.catalog.vector_contract import CatalogVectorRequest
from eolab_app.attribute_filter import VectorFilter

from eolab_app.catalog_selection import (
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
from eolab_app.vector.selection_source import resolve_selection
from eolab_app.vector.sources import MountedVectorResolver
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
    ) -> dict[str, Any]:
        """Read original features through Jobs and wait for native exit on cancellation.

        Args:
            selection: Original source, predicate and view fields.
            upload_owner: Private upload owner or None.
            read_lease: Held result-file capability or None for Catalog/uploads.

        Returns:
            Operation-owned measurements or display geometry.
        """
        ...


class VectorSamplingService:
    """Authorize filtered vector features and request counts, bounds or outlines."""

    def __init__(
        self,
        catalog: VectorCatalog,
        resolver: MountedVectorResolver,
        outline_executor: VectorSelectionExecutor | None = None,
        *,
        selection_executor: VectorSelectionExecutor | None = None,
        extent_executor: VectorSelectionExecutor | None = None,
        uploads: VectorUploadStore | None = None,
        artifact_files: Callable[[], LeasedSourceFiles] | None = None,
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
            uploads: Original browser-owned GeoPackages and their admission metadata.
            artifact_files: Composition-supplied access to immutable result files;
                resolved when used, after the owning source service is composed.
        """
        self.catalog = catalog
        self.resolver = resolver
        self._outline_executor = outline_executor
        self._selection_executor = selection_executor
        self._uploads = uploads
        self._extent_executor = extent_executor
        self._artifact_files = artifact_files

    @asynccontextmanager
    async def open_selection(
        self, selection: VectorSelection, source_owner: str | None = None
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
        if not isinstance(selection, ArtifactVectorSelection):
            yield await self.resolve_for_sampling(selection, source_owner)
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
        self, selection: VectorSelection, source_owner: str | None = None
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
            if isinstance(selection, ArtifactVectorSelection):
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
                self.catalog, self.resolver, request, self._uploads, source_owner
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
                self.catalog, self.resolver, request, self._uploads, source_owner
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
