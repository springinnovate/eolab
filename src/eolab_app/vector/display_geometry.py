"""Catalog-selection outlines for presentation only, never raster masks."""

import json

from shapely import get_num_coordinates
from shapely.geometry import Polygon, mapping, shape

# Deliberately much smaller than the legacy 2 MiB / 100,000 vertex browser cap.
MAX_DISPLAY_BYTES = 256 * 1024
MAX_DISPLAY_COORDINATES = 10_000
MAX_FALLBACK_COMPONENTS = 500


def display_geometry(
    exact: dict,
    bounds: tuple[float, float, float, float],
) -> dict:
    """Build a bounded approximate outline without mutating exact geometry.

    Simplification runs in the selection's time/memory-bounded native child.
    Topology-preserving simplification retains holes and disconnected polygons.
    If irreducible component/hole counts exceed the display budget, show the
    largest 500 exterior outlines. This fallback never substitutes an envelope
    or changes retained analysis geometry. Canonical dateline components remain
    separate; no longitude wrapping or polygon union is performed.

    Args:
        exact: Validated complete Polygon/MultiPolygon FeatureCollection.
        bounds: Exact canonical envelope, used only to scale display tolerance.

    Returns:
        Attribute-free display FeatureCollection within both presentation caps.
        Small islands/holes may be absent from the approximate display.

    Raises:
        RuntimeError: If validated polygon exteriors cannot meet the display cap.
    """
    polygons = []
    for feature in exact["features"]:
        geometry = shape(feature["geometry"])
        polygons.extend(
            [geometry] if geometry.geom_type == "Polygon" else geometry.geoms
        )
    span = max(bounds[2] - bounds[0], bounds[3] - bounds[1], 1e-9)
    tolerance = span / 16_384
    for attempt in range(18):
        if attempt == 9:
            # Topological detail can have a nonzero minimum size. Bound this
            # display-only fallback by importance, never by source row order.
            polygons = [
                Polygon(polygon.exterior)
                for polygon in sorted(
                    polygons,
                    key=lambda polygon: polygon.area,
                    reverse=True,
                )[:MAX_FALLBACK_COMPONENTS]
            ]
        simplified = [
            polygon.simplify(tolerance, preserve_topology=True) for polygon in polygons
        ]
        if (
            sum(int(get_num_coordinates(polygon)) for polygon in simplified)
            <= MAX_DISPLAY_COORDINATES
        ):
            result = {
                "type": "FeatureCollection",
                "features": [
                    {"type": "Feature", "properties": {}, "geometry": mapping(polygon)}
                    for polygon in simplified
                ],
            }
            if (
                len(
                    json.dumps(result, allow_nan=False, separators=(",", ":")).encode(
                        "utf-8"
                    )
                )
                <= MAX_DISPLAY_BYTES
            ):
                return result
        tolerance *= 2
    # At a tolerance exceeding the entire envelope, each retained exterior is
    # a triangle. 500 such polygons fit the caps even at float repr precision.
    raise RuntimeError("Bounded polygon outline could not be constructed")
