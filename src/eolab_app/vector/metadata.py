"""Authoritative assessed vector metadata shared by vector workflows."""

from typing import Any
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.models import (
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
    source_signature: tuple[tuple[str, int, int, int, int, int], ...],
    operation: str,
) -> dict[str, Any]:
    """Require current eligible assessment metadata for a source signature.

    Args:
        item: Authoritative Catalog Item.
        source_signature: Current complete mounted-source signature.
        operation: User-facing operation name for a safe error.

    Returns:
        Current rendering metadata.

    Raises:
        VectorConflictError: If the Item was not successfully assessed against
            the current source and deployed reader contract.
    """
    metadata = item.get("properties", {}).get(VECTOR_RENDERING_METADATA_KEY)
    if (
        not isinstance(metadata, dict)
        or metadata.get("policy") != VECTOR_RENDERING_POLICY
        or metadata.get("eligible") is not True
        or metadata.get("reader_contract") != VECTOR_READER_CONTRACT
        or metadata.get("reader_compatible") is not True
        or metadata.get("source_signature") != [
            list(entry) for entry in source_signature
        ]
    ):
        raise VectorConflictError(
            f"{operation} unavailable: reassess the current vector Item before "
            "styling it."
        )
    return metadata


