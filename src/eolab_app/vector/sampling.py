"""Coordinate vector selection checks, summaries, and map display outlines.

Source/filter preparation lives in selection_source so readers and installed Jobs
operations use the same rules without constructing this service.
This service retains selection authorization and execution routing;
an unavailable outline does not prevent numeric analysis of the selection.
"""

from collections.abc import Awaitable, Callable
from typing import Any
from eolab_app.catalog.vector_contract import CatalogVectorRequest
from eolab_app.attribute_filter import VectorFilter

from eolab_app.catalog_selection import (
    CatalogSelection,
    ResolvedCatalogSelection,
    SelectionUnavailableError,
)
from eolab_app.vector.errors import VectorConflictError, VectorFeatureError
from eolab_app.vector.filters import (
    CatalogVectorFilterRequest,
)
from eolab_app.vector.ports import VectorCatalog
from eolab_app.vector.selection_source import resolve_selection
from eolab_app.vector.sources import MountedVectorResolver


class VectorSamplingService:
    """Validate filtered catalog features and request their measurements or outlines."""

    def __init__(
        self,
        catalog: VectorCatalog,
        resolver: MountedVectorResolver,
        outline_executor: (
            Callable[[CatalogSelection], Awaitable[dict[str, Any]]] | None
        ) = None,
        *,
        selection_executor: (
            Callable[[CatalogSelection], Awaitable[dict[str, Any]]] | None
        ) = None,
    ) -> None:
        """Connect catalog source resolution with feature-measurement and outline jobs.

        Args:
            catalog: Authoritative Catalog reader.
            resolver: Exact mounted vector source resolver.
            outline_executor: Jobs adapter supplied by application composition.
                Omit for selection-only consumers; outline() then reports
                unavailable without starting local display work.
            selection_executor: Jobs adapter for measuring filtered features.
                Consumers that only reauthorize descriptors may omit it; select()
                then reports unavailable without launching a local process.
        """
        self.catalog = catalog
        self.resolver = resolver
        self._outline_executor = outline_executor
        self._selection_executor = selection_executor

    async def resolve_for_sampling(
        self, selection: CatalogSelection
    ) -> ResolvedCatalogSelection:
        """Authorize a saved feature selection against its Catalog binding and filter.

        Args:
            selection: Validated catalog source identity and feature filter.

        Returns:
            Authorized dataset path and feature filter.

        Raises:
            SelectionUnavailableError: If identity, source or predicate changed.
        """
        try:
            resolved = await resolve_selection(self.catalog, self.resolver, selection)
        except (VectorFeatureError, OSError, ValueError) as error:
            raise SelectionUnavailableError(
                "The catalog vector is unavailable; select it again."
            ) from error
        if resolved.selection.cache_identity() != selection.cache_identity():
            raise SelectionUnavailableError(
                "The catalog vector identity changed; select it again."
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

    async def select(self, request: CatalogVectorFilterRequest) -> dict[str, Any]:
        """Queue a filtered-feature measurement without retaining coordinates.

        Args:
            request: Catalog identity and typed predicate.

        Returns:
            Exact counts/bounds and path-free selection descriptor.

        Raises:
            VectorConflictError: If unavailable, empty, over budget or queue-full.
            SelectionUnavailableError: If the source cannot be read.
            asyncio.CancelledError: After the Jobs client cancels abandoned work.
        """
        resolved = await resolve_selection(self.catalog, self.resolver, request)
        if self._selection_executor is None:
            raise VectorConflictError("The vector selection executor is unavailable")
        result = await self._selection_executor(resolved.selection)
        return {
            **result,
            "selection": resolved.selection.model_dump(mode="json", by_alias=True),
            "filter": request.filter.model_dump(mode="json"),
            "label": request.item_id,
        }

    async def outline(self, selection: CatalogSelection) -> dict[str, Any]:
        """Create a simplified map outline of the selected features.

        Args:
            selection: Previously validated catalog descriptor.

        Returns:
            Approximate FeatureCollection for map display only.

        Raises:
            VectorConflictError: If no executor is supplied, or Jobs display work
                is unavailable or over budget.
            SelectionUnavailableError: If the Catalog binding or source is unavailable.
            asyncio.CancelledError: After the executor's bounded cleanup.
        """
        await self.resolve_for_sampling(selection)
        if self._outline_executor is None:
            raise VectorConflictError("The map outline executor is unavailable")
        result = await self._outline_executor(selection)
        return result
