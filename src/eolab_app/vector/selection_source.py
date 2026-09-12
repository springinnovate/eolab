"""Shared Catalog-to-source resolution for local and registered vector work."""

import asyncio
import hashlib
import json

from eolab_app.catalog_selection import CatalogSelection, ResolvedCatalogSelection
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.filters import (
    CatalogVectorFilterRequest,
    VectorFilter,
    validate_filter,
)
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


async def resolve_selection(
    catalog: VectorCatalog,
    resolver: MountedVectorResolver,
    request: CatalogVectorFilterRequest,
) -> ResolvedCatalogSelection:
    """Resolve Catalog identity and validated predicate to the original source.

    Args:
        catalog: Authoritative internal Catalog reader.
        resolver: Resolver confined to the read-only scan mount.
        request: Path-free Catalog identity and predicate.

    Returns:
        Private source capability with a complete component signature.

    Raises:
        VectorFeatureError: If identity, source or predicate is unavailable.
        OSError: If a source component cannot be inspected.
    """
    item = await catalog.get_item(request)
    source = resolver.resolve(item)
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
