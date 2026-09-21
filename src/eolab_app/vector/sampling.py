"""Coordinate vector selection checks, summaries, and map display outlines.

Source/filter preparation lives in selection_source so readers and installed Jobs
operations use the same rules without constructing this service.
This service retains selection authorization and execution routing;
an unavailable outline does not prevent numeric analysis of the selection.
"""

from collections.abc import Awaitable, Callable
from typing import Any

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
    """Authorize direct catalog selections without retaining geometry or IDs."""

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
        """Connect source authority and bounded execution.

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
        """Reauthorize descriptor identity, source signature and native layer.

        Args:
            selection: Validated path-free immutable descriptor.

        Returns:
            Current private source capability.

        Raises:
            SelectionUnavailableError: If identity, source or predicate changed.
        """
        try:
            resolved = await resolve_selection(self.catalog, self.resolver, selection)
        except (VectorFeatureError, OSError, ValueError) as error:
            raise SelectionUnavailableError(
                "The catalog vector is unavailable; select it again."
            ) from error
        if resolved.selection != selection:
            raise SelectionUnavailableError(
                "The catalog vector identity changed; select it again."
            )
        return resolved

    async def select(self, request: CatalogVectorFilterRequest) -> dict[str, Any]:
        """Queue a filtered-feature measurement without retaining coordinates.

        Args:
            request: Catalog identity and typed predicate.

        Returns:
            Exact counts/bounds and path-free selection descriptor.

        Raises:
            VectorConflictError: If unavailable, empty, over budget or queue-full.
            SelectionUnavailableError: If the source changes while work waits/runs.
            asyncio.CancelledError: After the Jobs client cancels abandoned work.
        """
        resolved = await resolve_selection(self.catalog, self.resolver, request)
        if self._selection_executor is None:
            raise VectorConflictError("The vector selection executor is unavailable")
        result = await self._selection_executor(resolved.selection)
        await self.resolve_for_sampling(resolved.selection)
        return {
            **result,
            "selection": resolved.selection.model_dump(mode="json", by_alias=True),
            "filter": request.filter.model_dump(mode="json"),
            "label": request.item_id,
        }

    async def outline(self, selection: CatalogSelection) -> dict[str, Any]:
        """Generate optional presentation geometry independently of analysis.

        Args:
            selection: Previously validated catalog descriptor.

        Returns:
            Approximate FeatureCollection for map display only.

        Raises:
            VectorConflictError: If no executor is supplied, or Jobs display work
                is unavailable or over budget.
            SelectionUnavailableError: If the source changed before or during work.
            asyncio.CancelledError: After the executor's bounded cleanup.
        """
        await self.resolve_for_sampling(selection)
        if self._outline_executor is None:
            raise VectorConflictError("The map outline executor is unavailable")
        result = await self._outline_executor(selection)
        await self.resolve_for_sampling(selection)
        return result
