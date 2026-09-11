"""Separate bounded native commands for selection metadata and map outlines."""

from typing import Any

from eolab_app.bounded_vector import (
    polygon_features,
    selection_summary,
    READ_SECONDS,
    _limit_memory,
)
from eolab_app.catalog_selection import (
    ResolvedCatalogSelection,
    SelectionUnavailableError,
)
from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.vector.display_geometry import display_geometry

GEOMETRY_READ_SECONDS = READ_SECONDS


def geometry_process(
    writer: ProcessResultWriter, resolved: ResolvedCatalogSelection
) -> None:
    """Build an approximate outline independently of numeric analysis admission.

    Args:
        writer: Supervisor-owned result channel.
        resolved: Authorized original source and predicate.
    """
    try:
        with _limit_memory():
            summary = selection_summary(resolved)
            outline: dict[str, Any] = {"type": "FeatureCollection", "features": []}
            with polygon_features(resolved) as features:
                for geometry in features:
                    part = display_geometry(
                        {
                            "type": "FeatureCollection",
                            "features": [
                                {
                                    "type": "Feature",
                                    "properties": {},
                                    "geometry": geometry,
                                }
                            ],
                        },
                        summary["bbox"],
                    )
                    outline["features"].extend(part["features"])
                    outline = display_geometry(outline, summary["bbox"])
        writer.put((True, {"geometry": outline, "bbox": summary["bbox"]}))
    except Exception:
        writer.put(
            (
                False,
                "The optional map outline could not be drawn within its display budget",
            )
        )
