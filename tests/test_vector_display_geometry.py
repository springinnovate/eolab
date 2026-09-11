"""Display reduction is bounded independently of exact analysis admission."""

import json
import pytest
from shapely import get_num_coordinates
from shapely.geometry import Polygon, box, mapping, shape
from eolab_app.vector.display_geometry import (
    MAX_DISPLAY_BYTES,
    MAX_DISPLAY_COORDINATES,
    display_geometry,
)

def test_display_preserves_holes_multipolygon_and_dateline_components() -> None:
    """Keep explicit east/west dateline pieces separate and small holes visible."""
    west = Polygon(
        [(-180, 0), (-178, 0), (-178, 4), (-180, 4), (-180, 0)],
        [[(-179.8, 1), (-179.2, 1), (-179.2, 2), (-179.8, 2), (-179.8, 1)]],
    )
    east = box(178, 0, 180, 4)
    exact = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {},
                "geometry": {
                    "type": "MultiPolygon",
                    "coordinates": [
                        mapping(west)["coordinates"],
                        mapping(east)["coordinates"],
                    ],
                },
            }
        ],
    }
    original = json.dumps(exact)
    result = display_geometry(exact, (-180, 0, 180, 4))
    assert len(result["features"]) == 2
    assert sum(
        shape(feature["geometry"]).area for feature in result["features"]
    ) == pytest.approx(west.area + east.area)
    assert all(
        shape(feature["geometry"]).bounds[2] - shape(feature["geometry"]).bounds[0] <= 2
        for feature in result["features"]
    )
    assert json.dumps(exact) == original


def test_component_fallback_is_bounded_without_mutating_exact_selection() -> None:
    """An irreducible archipelago cannot exhaust browser resources."""
    polygons = [
        mapping(box(index % 100, index // 100, index % 100 + 0.1, index // 100 + 0.1))[
            "coordinates"
        ]
        for index in range(5000)
    ]
    exact = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {},
                "geometry": {"type": "MultiPolygon", "coordinates": polygons},
            }
        ],
    }
    result = display_geometry(exact, (0, 0, 100, 50))
    assert len(exact["features"][0]["geometry"]["coordinates"]) == 5000
    assert (
        sum(
            int(get_num_coordinates(shape(feature["geometry"])))
            for feature in result["features"]
        )
        <= MAX_DISPLAY_COORDINATES
    )
    assert len(json.dumps(result, separators=(",", ":")).encode()) <= MAX_DISPLAY_BYTES
