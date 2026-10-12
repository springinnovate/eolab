"""Locate catalog vector files and prepare the filter used to select features.

VectorCatalog supplies the Item and MountedVectorResolver locates its dataset.
The filter is validated against catalog fields, and source file signatures are
recorded for change detection. Feature readers apply the filter later; source
resolution does not load polygons.
"""

import asyncio
import hashlib
import json

from eolab_app.catalog_selection import CatalogSelection, ResolvedCatalogSelection
from eolab_app.attribute_filter import ogr_predicate
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.filters import (
    CatalogVectorFilterRequest,
    VectorFilter,
    validate_filter,
)
from eolab_app.vector.metadata import catalog_vector_fields
from eolab_app.vector.ports import VectorCatalog
from eolab_app.vector.sources import MountedVectorResolver, vector_source_signature


async def resolve_selection(
    catalog: VectorCatalog,
    resolver: MountedVectorResolver,
    request: CatalogVectorFilterRequest,
) -> ResolvedCatalogSelection:
    """Locate a catalog vector dataset and prepare its attribute filter for reading.

    No polygons are loaded or filtered here. The returned OGR WHERE expression
    narrows candidates during reading; polygon_features also applies the exact
    attribute rules so driver-specific string comparisons cannot change results.

    Args:
        catalog: Reader that fetches the requested STAC Item.
        resolver: Maps the Item's data Asset to an
            allowed dataset path and native layer inside the read-only mount.
        request: Catalog collection/item IDs and attribute filter. Callers name
            a catalog entry, not a filesystem path; the server locates the file.

    Returns:
        Server-only dataset path, driver, layer/filter selection, compiled OGR
        WHERE expression, and file signatures for detecting source changes.

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
            f"The selected source is {source.source_kind} {source.source_format}; "
            "sampling requires a mounted Shapefile or GeoPackage polygon layer."
        )
    validated_filter = validate_filter(request.filter, catalog_vector_fields(item))
    source_file_signature = await asyncio.to_thread(vector_source_signature, source)
    source_signature_hash = hashlib.sha256(
        json.dumps(source_file_signature).encode()
    ).hexdigest()
    selection = CatalogSelection(
        collectionId=request.collection_id,
        itemId=request.item_id,
        assetKey=source.asset_key,
        layerName=source.layer_name,
        sourceSignature=source_signature_hash,
        filter=validated_filter,
    )
    component_paths_by_name = {
        p.name: p for p in (source.component_paths or (source.source_path,))
    }
    return ResolvedCatalogSelection(
        selection,
        source.source_path,
        "GPKG" if source.source_format == "geopackage" else "ESRI Shapefile",
        tuple(
            (component_paths_by_name[name], tuple(values))
            for name, *values in source_file_signature
        ),
        ogr_predicate(validated_filter),
    )
