"""Shared STAC metadata conventions for mounted vector datasets."""

from collections.abc import Iterable, Sequence
from typing import Any


MOUNTED_VECTOR_COLLECTION_ID = "eolab-mounted-vectors"
TABLE_EXTENSION = "https://stac-extensions.github.io/table/v1.2.0/schema.json"
PRIMARY_GEOMETRY_COLUMN = "geometry"


def build_bbox_polygon(bbox: Sequence[float]) -> dict[str, Any]:
    """Represent a WGS 84 bounding box as a GeoJSON Polygon.

    Args:
        bbox: West, south, east, and north coordinates in WGS 84.

    Returns:
        Closed counterclockwise polygon following the bounding-box edges.

    Raises:
        ValueError: If the bounding box does not contain exactly four values.
    """
    west, south, east, north = bbox
    return {
        "type": "Polygon",
        "coordinates": [[
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south],
        ]],
    }


def build_vector_table_properties(
    feature_count: int,
    geometry_type: str,
    fields: Iterable[tuple[str, str]],
) -> dict[str, Any]:
    """Build format-neutral STAC Table Extension properties.

    Args:
        feature_count: Number of features in the represented vector layer.
        geometry_type: GeoJSON geometry type declared for the layer.
        fields: Ordered attribute field names and type descriptions.

    Returns:
        Table Extension properties shared by mounted vector handlers.

    Raises:
        ValueError: If feature count is negative or a field conflicts with the
            shared primary geometry column.
    """
    if feature_count < 0:
        raise ValueError("Vector feature count cannot be negative")
    field_columns = [
        {"name": field_name, "type": field_type}
        for field_name, field_type in fields
    ]
    if any(
        field["name"] == PRIMARY_GEOMETRY_COLUMN
        for field in field_columns
    ):
        raise ValueError(
            f"Vector attribute field conflicts with {PRIMARY_GEOMETRY_COLUMN!r}"
        )
    return {
        "table:row_count": feature_count,
        "table:columns": [
            {"name": PRIMARY_GEOMETRY_COLUMN, "type": geometry_type},
            *field_columns,
        ],
        "table:primary_geometry": PRIMARY_GEOMETRY_COLUMN,
    }
