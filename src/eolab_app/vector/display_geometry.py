"""Catalog-selection outlines for presentation only, never raster masks."""

import json

from shapely import get_num_coordinates
from shapely.geometry import Polygon, mapping, shape

# Deliberately much smaller than the legacy 2 MiB / 100,000 vertex browser cap.
MAX_DISPLAY_BYTES = 256 * 1024
MAX_DISPLAY_COORDINATES = 10_000
MAX_FALLBACK_COMPONENTS = 500

# Display-quality heuristics, not geographic accuracy or latency guarantees.
# Start at about 0.006% of the envelope span to retain recognizable detail.
INITIAL_TOLERANCE_SPAN_DIVISOR = 16_384
# A positive floor keeps tolerance progression usable for tiny envelopes.
MIN_DISPLAY_SPAN_DEGREES = 1e-9
# Geometric growth covers fine through coarse outlines in bounded work.
TOLERANCE_GROWTH_FACTOR = 2
# Nine full-detail passes cover span/16,384 through span/64. If none fits,
# spend the remaining passes on the largest exteriors, starting at span/32.
# This is a quality/work tradeoff, not proof that the topology cannot fit.
FULL_DETAIL_ATTEMPTS = 9
# Eighteen total passes reach 8 * span, including nine exterior-only passes.
# Stop at the first fitting result; the supervised deadline still bounds time.
MAX_SIMPLIFICATION_ATTEMPTS = 18


def display_geometry(
    exact: dict,
    bounds: tuple[float, float, float, float],
) -> dict:
    """Build a bounded approximate outline without mutating exact geometry.

    Simplification runs in the selection's time/memory-bounded native child.
    Topology-preserving simplification retains holes and disconnected polygons.
    If the full-detail passes cannot meet the display budget, show at most
    MAX_FALLBACK_COMPONENTS exterior outlines, largest by area. The module
    constants define the tolerance progression and bounded attempt counts;
    neither the finest fitting tolerance nor a runtime improvement is promised.
    This fallback never substitutes an envelope or changes retained analysis
    geometry. Canonical dateline components remain
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
    span = max(bounds[2] - bounds[0], bounds[3] - bounds[1], MIN_DISPLAY_SPAN_DEGREES)
    tolerance = span / INITIAL_TOLERANCE_SPAN_DIVISOR
    for attempt in range(MAX_SIMPLIFICATION_ATTEMPTS):
        if attempt == FULL_DETAIL_ATTEMPTS:
            # After the full-detail attempt budget, bound this display-only
            # fallback by importance, never by source row order.
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
        tolerance *= TOLERANCE_GROWTH_FACTOR
    # A coarse tolerance does not itself prove the serialized result fits;
    # retain the explicit failure if no attempt satisfies both display caps.
    raise RuntimeError("Bounded polygon outline could not be constructed")
