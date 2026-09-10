"""Catalog-owned filtered polygon selection, with injected AOI retention."""

import asyncio
from collections.abc import Awaitable, Callable

from eolab_app.execution.bounded_process import ProcessDeadlineError, run_bounded_process
from eolab_app.sampling_area import ResolvedTemporaryAoi
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.filters import CatalogVectorFilterRequest, validate_filter
from eolab_app.vector.geometry import GEOMETRY_READ_SECONDS, geometry_process
from eolab_app.vector.metadata import catalog_vector_fields
from eolab_app.vector.ports import VectorCatalog
from eolab_app.vector.sources import MountedVectorResolver, vector_source_signature

RetainGeometry = Callable[[dict, tuple[float, float, float, float], str], Awaitable[ResolvedTemporaryAoi]]


class VectorSamplingService:
    """Authorize complete polygon selections without rendering prerequisites."""

    def __init__(self, catalog: VectorCatalog, resolver: MountedVectorResolver, retain_geometry: RetainGeometry) -> None:
        """Connect source authority to temporary retention.

        Args:
            catalog: Authoritative Catalog reader.
            resolver: Exact mounted vector source resolver.
            retain_geometry: Injected capability for bounded AOI retention.
        """
        self.catalog = catalog
        self.resolver = resolver
        self.retain_geometry = retain_geometry
        self._slots = asyncio.Semaphore(2)

    async def select(self, request: CatalogVectorFilterRequest) -> dict:
        """Create an immutable, expiring AOI for the complete filtered layer.

        Args:
            request: Catalog identity and typed predicate, never a path or SQL.

        Returns:
            Display-only geometry, exact bounds/counts, filter and opaque AOI ID.
            Numeric consumers must resolve the ID, never use this outline.

        Raises:
            VectorConflictError: If busy, stale, empty, invalid or over budget.
        """
        if self._slots.locked():
            raise VectorConflictError("Vector sampling is busy; retry after the current selection finishes")
        async with self._slots:
            item = await self.catalog.get_item(request)
            source = self.resolver.resolve(item)
            candidate = validate_filter(request.filter, catalog_vector_fields(item))
            signature = await asyncio.to_thread(vector_source_signature, source)
            try:
                success, result = await run_bounded_process(
                    geometry_process, (source, candidate, signature), GEOMETRY_READ_SECONDS,
                )
            except ProcessDeadlineError as error:
                raise VectorConflictError("Vector sampling exceeded its time budget; use a smaller source layer") from error
            if not success:
                raise VectorConflictError(result)
            current = await self.catalog.get_item(request)
            if self.resolver.resolve(current) != source or catalog_vector_fields(current) != catalog_vector_fields(item):
                raise VectorConflictError("Catalog source changed during sampling; refresh the layer")
            if await asyncio.to_thread(vector_source_signature, source) != signature:
                raise VectorConflictError("Vector source changed during sampling; refresh the layer")
            label = str(item.get("properties", {}).get("title") or item["id"])[:256]
            area = await self.retain_geometry(result["geometry"], result["bbox"], label)
            return {
                "geometry": result["displayGeometry"], "bbox": result["bbox"],
                "matched": result["matched"], "total": result["total"],
                "id": area.identity.reference, "state": "ready",
                "filename": label, "selectedDataset": label,
                "expiresAt": area.identity.expires_at.isoformat(),
                "filter": candidate.model_dump(mode="json"),
            }
