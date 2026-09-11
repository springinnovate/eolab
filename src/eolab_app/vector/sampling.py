"""Catalog-owned immutable selection authorization, independent of outlines."""

import asyncio
import hashlib
import json
from collections.abc import Callable
from typing import Any

from eolab_app.catalog_selection import (
    CatalogSelection,
    ResolvedCatalogSelection,
    SelectionUnavailableError,
)
from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
    ProcessResultWriter,
    run_bounded_process,
)
from eolab_app.vector.errors import VectorConflictError, VectorFeatureError
from eolab_app.vector.filters import (
    CatalogVectorFilterRequest,
    VectorFilter,
    validate_filter,
)
from eolab_app.vector.geometry import geometry_process, GEOMETRY_READ_SECONDS
from eolab_app.bounded_vector import summary_process
from eolab_app.vector.metadata import catalog_vector_fields
from eolab_app.vector.ports import VectorCatalog
from eolab_app.vector.sources import MountedVectorResolver, vector_source_signature


def ogr_predicate(candidate: VectorFilter) -> str | None:
    """Compile a conservative native predicate from schema-validated rules.

    String comparisons retain exact Python post-filtering because driver
    collations differ. An OR with such a rule requires all native candidates.

    Args:
        candidate: Schema-validated immutable predicate.

    Returns:
        Quoted OGR WHERE text, or no native restriction.
    """
    if not candidate.active:
        return None
    clauses = []
    for rule in candidate.rules:
        if rule.operator == "contains" or isinstance(rule.value, str):
            if candidate.match == "any":
                return None
            continue
        field = '"' + rule.field.replace('"', '""') + '"'
        if rule.operator in {"missing", "present"}:
            clauses.append(
                f"{field} IS {'NOT ' if rule.operator == 'present' else ''}NULL"
            )
            continue
        literal = (
            str(int(rule.value)) if isinstance(rule.value, bool) else str(rule.value)
        )
        operator = {
            "eq": "=",
            "ne": "<>",
            "gt": ">",
            "ge": ">=",
            "lt": "<",
            "le": "<=",
        }[rule.operator]
        clauses.append(f"({field} IS NOT NULL AND {field} {operator} {literal})")
    return (" AND " if candidate.match == "all" else " OR ").join(clauses) or None


class VectorSamplingService:
    """Authorize direct catalog selections without retaining geometry or IDs."""

    def __init__(self, catalog: VectorCatalog, resolver: MountedVectorResolver) -> None:
        """Connect source authority and bounded execution.

        Args:
            catalog: Authoritative Catalog reader.
            resolver: Exact mounted vector source resolver.
        """
        self.catalog = catalog
        self.resolver = resolver
        self._slots = asyncio.Semaphore(2)

    async def _resolve(
        self, request: CatalogVectorFilterRequest
    ) -> ResolvedCatalogSelection:
        """Validate source identity and compile its predicate.

        Args:
            request: Catalog identity and typed predicate.

        Returns:
            Private immutable source capability.

        Raises:
            VectorFeatureError: If source or predicate validation fails.
        """
        item = await self.catalog.get_item(request)
        source = self.resolver.resolve(item)
        if (
            source.source_format not in {"geopackage", "shapefile"}
            or source.source_path is None
        ):
            raise VectorConflictError(
                "Sampling supports mounted Shapefile and GeoPackage polygon layers"
            )
        candidate = validate_filter(request.filter, catalog_vector_fields(item))
        signature = await asyncio.to_thread(vector_source_signature, source)
        digest = hashlib.sha256(json.dumps(signature).encode()).hexdigest()
        selection = CatalogSelection(
            collectionId=request.collection_id,
            itemId=request.item_id,
            assetKey=source.asset_key,
            layerName=source.layer_name,
            sourceSignature=digest,
            filter=candidate,
        )
        paths = {p.name: p for p in (source.component_paths or (source.source_path,))}
        return ResolvedCatalogSelection(
            selection,
            source.source_path,
            "GPKG" if source.source_format == "geopackage" else "ESRI Shapefile",
            tuple((paths[name], tuple(values)) for name, *values in signature),
            ogr_predicate(candidate),
        )

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
            resolved = await self._resolve(selection)
        except (VectorFeatureError, OSError, ValueError) as error:
            raise SelectionUnavailableError(
                "The catalog vector is unavailable; select it again."
            ) from error
        if resolved.selection != selection:
            raise SelectionUnavailableError(
                "The catalog vector identity changed; select it again."
            )
        return resolved

    async def _run(
        self,
        target: Callable[[ProcessResultWriter, ResolvedCatalogSelection], None],
        resolved: ResolvedCatalogSelection,
    ) -> dict[str, Any]:
        """Run one bounded native selection command without an unbounded queue.

        Args:
            target: Fixed selection or outline process command.
            resolved: Authorized source capability.

        Returns:
            Native result after source reauthorization.

        Raises:
            VectorConflictError: If busy, stale, empty or over actual work budget.
        """
        if self._slots.locked():
            raise VectorConflictError("Vector sampling is busy; retry later")
        async with self._slots:
            try:
                success, result = await run_bounded_process(
                    target, (resolved,), GEOMETRY_READ_SECONDS
                )
            except ProcessDeadlineError as error:
                raise VectorConflictError(
                    "Vector reading exceeded its time budget"
                ) from error
            if not success:
                raise VectorConflictError(result)
            await self.resolve_for_sampling(resolved.selection)
            return result

    async def select(self, request: CatalogVectorFilterRequest) -> dict[str, Any]:
        """Measure a selection without returning or retaining exact coordinates.

        Args:
            request: Catalog identity and typed predicate.

        Returns:
            Exact counts/bounds and path-free selection descriptor.

        Raises:
            VectorConflictError: If empty, stale, busy or over actual read budget.
        """
        resolved = await self._resolve(request)
        result = await self._run(summary_process, resolved)
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
            VectorConflictError: If display work is unavailable or over budget.
        """
        return await self._run(
            geometry_process, await self.resolve_for_sampling(selection)
        )
