"""Authoritative assessed vector metadata shared by vector workflows."""

from typing import Any
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.models import (
    ResolvedVectorSource,
    VectorLayer,
    VECTOR_RENDERING_METADATA_KEY, VECTOR_RENDERING_POLICY, VECTOR_READER_CONTRACT,
)


def catalog_vector_fields(item: dict[str, Any]) -> dict[str, str]:
    """Return authoritative non-geometry Catalog fields and declared types.

    Args:
        item: Authoritative Catalog Item loaded by the style service.

    Returns:
        Exact bounded attribute field identities and type descriptions declared
        by the STAC Table Extension, excluding its primary geometry column.
    """
    properties = item.get("properties")
    if not isinstance(properties, dict):
        return {}
    columns = properties.get("table:columns")
    primary_geometry = properties.get("table:primary_geometry")
    if not isinstance(columns, list):
        return {}
    return {
        name: field_type
        for column in columns
        if isinstance(column, dict)
        and isinstance((name := column.get("name")), str)
        and 0 < len(name) <= 256
        and name != primary_geometry
        and isinstance((field_type := column.get("type")), str)
        and 0 < len(field_type) <= 128
    }


def catalog_vector_feature_count(
    item: dict[str, Any],
    operation: str,
) -> int:
    """Return the authoritative non-negative STAC Table row count.

    Args:
        item: Authoritative Catalog Item loaded by the style service.
        operation: User-facing operation name for a safe error.

    Returns:
        Declared feature count.

    Raises:
        VectorConflictError: If current Table metadata has no valid row count.
    """
    value = item.get("properties", {}).get("table:row_count")
    if type(value) is not int or value < 0:
        raise VectorConflictError(
            f"{operation} unavailable: reassess the vector Item because its "
            "feature count is missing."
        )
    return value


def require_assessed_metadata(
    item: dict[str, Any],
    operation: str,
) -> dict[str, Any]:
    """Require eligible assessment metadata for the deployed vector reader.

    Args:
        item: Authoritative Catalog Item.
        operation: User-facing operation name for a safe error.

    Returns:
        Current rendering metadata.

    Raises:
        VectorConflictError: If the Item was not successfully assessed against
            the deployed reader contract.
    """
    metadata = item.get("properties", {}).get(VECTOR_RENDERING_METADATA_KEY)
    if (
        not isinstance(metadata, dict)
        or metadata.get("policy") != VECTOR_RENDERING_POLICY
    ):
        raise VectorConflictError(
            f"{operation} unavailable: assess this vector layer first."
        )
    if metadata.get("eligible") is not True:
        reason = metadata.get("reason")
        raise VectorConflictError(
            reason if isinstance(reason, str) and reason else
            f"{operation} unavailable for this vector layer."
        )
    if (
        metadata.get("reader_contract") != VECTOR_READER_CONTRACT
        or metadata.get("reader_compatible") is not True
    ):
        raise VectorConflictError(
            f"{operation} unavailable: reassess this vector layer for "
            "the current GeoServer reader."
        )
    return metadata


def get_catalog_vector_layer(
    item: dict[str, Any],
    source: ResolvedVectorSource,
    operation: str,
) -> VectorLayer:
    """Read the display and attribute metadata for an assessed catalog vector.

    Args:
        item: Catalog Item returned by the catalog adapter.
        source: File and native layer located from this Item.
        operation: User-facing operation name included in metadata errors.

    Returns:
        Original source and metadata used by publication, styling and filters.

    Raises:
        VectorConflictError: If the catalog does not describe a supported,
            assessed vector layer or its feature count is unavailable.
    """
    metadata = require_assessed_metadata(item, operation)
    if (
        source.source_kind != "mounted"
        or source.source_path is None
        or source.layer_name is None
        or source.source_format not in {"shapefile", "geopackage"}
    ):
        raise VectorConflictError(
            f"{operation} unavailable: the assessed mounted vector source is unsupported."
        )
    geometry_kind = metadata.get("geometry_kind")
    if geometry_kind not in {"point", "line", "polygon"}:
        raise VectorConflictError(
            f"{operation} unavailable: the assessed geometry is invalid."
        )
    return VectorLayer(
        resource_name=item["id"],
        source=source,
        fields=catalog_vector_fields(item),
        feature_count=catalog_vector_feature_count(item, operation),
        bbox=tuple(item["bbox"]),
        geometry_kind=geometry_kind,
    )
