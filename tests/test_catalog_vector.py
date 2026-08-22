"""Test shared mounted-vector STAC metadata conventions."""

import pytest

from eolab_app.catalog.vector import build_vector_table_properties


def test_vector_table_properties_are_format_neutral_and_data_driven() -> None:
    """Expose only the shared geometry column and real attribute fields."""
    properties = build_vector_table_properties(
        2,
        "MultiPolygon",
        (("habitat", "str:80"), ("rank", "int:18")),
    )

    assert properties == {
        "table:row_count": 2,
        "table:columns": [
            {"name": "geometry", "type": "MultiPolygon"},
            {"name": "habitat", "type": "str:80"},
            {"name": "rank", "type": "int:18"},
        ],
        "table:primary_geometry": "geometry",
    }
    assert all(
        column["name"] not in {"layer", "driver", "format"}
        for column in properties["table:columns"]
    )


def test_vector_table_properties_reject_geometry_field_conflicts() -> None:
    """Reserve the shared primary geometry column for handler conventions."""
    with pytest.raises(ValueError, match="conflicts"):
        build_vector_table_properties(1, "Point", (("geometry", "bytes"),))
