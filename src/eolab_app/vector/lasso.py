"""Describe a freehand feature selection and its optional bounded map highlight."""

import json
from time import monotonic
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, JsonValue

from eolab_app.bounded_geometry import GeometryValidationError
from eolab_app.bounded_vector import VectorReadLimits, _limit_memory
from eolab_app.catalog_selection import ResolvedCatalogSelection, VectorSelection
from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
    ProcessResultWriter,
    run_bounded_process,
)
from eolab_app.feature_intersection import read_original_features
from eolab_app.polygon_areas import SummaryPolygon
from eolab_app.vector.display_geometry import MAX_DISPLAY_BYTES, MAX_DISPLAY_COORDINATES


class LassoSelectionRequest(BaseModel):
    """Select whole original features intersecting a closed WGS84 freehand polygon.

    The target retains its existing field and spatial predicates. The polygon
    is this request's user input, not a new Catalog source or a saved feature copy.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    selection: VectorSelection
    polygon: SummaryPolygon


class LassoSelectionResult(BaseModel):
    """Exact original-feature membership with optional complete map highlights.

    Attributes:
        matched: Exact number of selected original features, including zero.
        featureIds: Native IDs in original source order, with each feature once.
        geometry: Attribute-free whole-feature display geometry, or None when
            it cannot fit the ordinary map read or display budget.
    """

    matched: int = Field(ge=0)
    featureIds: tuple[int, ...]
    geometry: dict[str, JsonValue] | None


async def read_lasso_highlights(
    target: ResolvedCatalogSelection, feature_ids: tuple[int, ...]
) -> dict[str, Any] | None:
    """Return complete feature highlights within the ordinary map display budgets.

    Args:
        target: Authorized original source held open by the selection owner.
        feature_ids: Exact matching native IDs, already computed independently.

    Returns:
        Attribute-free WGS84 features, or None when the optional highlight cannot
        fit its display/read budget. An empty selection returns an empty collection.

    Raises:
        asyncio.CancelledError: After a cancelled native read has exited.
        SelectionUnavailableError: If the original source can no longer be read.
    """
    if not feature_ids:
        return {"type": "FeatureCollection", "features": []}
    limits = VectorReadLimits()
    try:
        return await run_bounded_process(
            _read_highlights, (target, feature_ids, limits), limits.seconds
        )
    except (ProcessDeadlineError, GeometryValidationError, MemoryError):
        return None


def _read_highlights(
    writer: ProcessResultWriter,
    target: ResolvedCatalogSelection,
    feature_ids: tuple[int, ...],
    limits: VectorReadLimits,
) -> None:
    """Read whole matched features through the same original-source iterator.

    Args:
        writer: Supervised parent waiting for the optional display result.
        target: Authorized immutable vector and its applied predicate.
        feature_ids: Exact native IDs to display, without clipping their geometries.
        limits: Existing interactive source-read budgets.

    Raises:
        SelectionUnavailableError: If the original file cannot be read.
    """
    from shapely import get_num_coordinates
    from shapely.geometry import mapping

    selected = frozenset(feature_ids)
    features: list[dict[str, Any]] = []
    coordinates = 0
    size = 64
    try:
        with _limit_memory(limits.memory_bytes):
            with read_original_features(
                target, limits, monotonic() + limits.seconds
            ) as originals:
                for feature_id, geometry in originals:
                    if feature_id not in selected:
                        continue
                    coordinates += int(get_num_coordinates(geometry))
                    if coordinates > MAX_DISPLAY_COORDINATES:
                        writer.put(None)
                        return
                    feature = {
                        "type": "Feature",
                        "id": feature_id,
                        "properties": {},
                        "geometry": mapping(geometry),
                    }
                    encoded = json.dumps(feature, allow_nan=False)
                    size += len(encoded.encode()) + 1
                    if size > MAX_DISPLAY_BYTES:
                        writer.put(None)
                        return
                    features.append(json.loads(encoded))
        writer.put({"type": "FeatureCollection", "features": features})
    except (GeometryValidationError, MemoryError):
        writer.put(None)
