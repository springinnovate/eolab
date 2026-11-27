"""Deliver a Lasso selection's original feature attributes and optional map outlines."""

import asyncio
import json
from contextlib import closing
from dataclasses import dataclass
from math import ceil
from time import monotonic
from typing import Literal

import httpx2
from pydantic import BaseModel, ConfigDict, Field, JsonValue, TypeAdapter

from eolab_app.bounded_geometry import GeometryValidationError
from eolab_app.bounded_vector import READ_SECONDS, VectorReadLimits, _limit_memory
from eolab_app.catalog_selection import ResolvedCatalogSelection, VectorSelection
from eolab_app.feature_intersection import iter_original_features
from eolab_app.polygon_areas import SummaryPolygon
from eolab_app.vector.display_geometry import MAX_DISPLAY_BYTES, MAX_DISPLAY_COORDINATES
from eolab_app.vector.feature_attributes import (
    FeatureAttributes,
    collect_feature_attributes,
)
from eolab_app.vector.spatial_read import INTERSECTION_SECONDS

LASSO_EXECUTION_SECONDS = INTERSECTION_SECONDS + ceil(2 * READ_SECONDS)
"""Outer Jobs deadline for membership and two individually supervised native reads."""

_FEATURE_ROWS = TypeAdapter(tuple[FeatureAttributes, ...])
_HIGHLIGHTS = TypeAdapter(dict[str, JsonValue])


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
        featureIds: Canonical decimal native IDs in numeric ascending order,
            with each feature once. Text preserves signed-64-bit identity in browsers.
        features: Original scalar attributes in that same order for inspection and plots.
        geometry: Attribute-free whole-feature display geometry, or None when
            it cannot fit the ordinary map read or display budget.
    """

    matched: int = Field(ge=0)
    featureIds: tuple[str, ...]
    features: tuple[FeatureAttributes, ...]
    geometry: dict[str, JsonValue] | None


@dataclass
class LassoRead:
    """Hold the completed inspection result while its worker attempts optional outlines.

    Attributes:
        deadline: Request-owned timer that cancels and reaps a stalled native job.
        result: Complete selection, available from delivery of the ordered scalar rows.
        next_stage: The only worker delivery still authorized to advance this read.
    """

    deadline: asyncio.Timeout
    result: LassoSelectionResult | None = None
    next_stage: (
        Literal["intersection", "attributes", "features", "highlights"] | None
    ) = "intersection"

    def receive(self, stage: str | None, body: bytes = b"") -> None:
        """Accept each private worker delivery in order and bound its next native read.

        Args:
            stage: Intersection start, attribute-read start, complete rows or outlines.
            body: Encoded rows or GeoJSON for a result delivery.

        Raises:
            ValueError: A delivery is late, out of order, or malformed.
        """
        if stage is None or stage != self.next_stage or self.deadline.expired():
            raise ValueError("This Lasso read is no longer waiting for this result.")
        if stage == "intersection":
            self.next_stage = "attributes"
            seconds = INTERSECTION_SECONDS
        elif stage == "attributes":
            self.next_stage = "features"
            seconds = READ_SECONDS
        elif stage == "features":
            rows = _FEATURE_ROWS.validate_json(body)
            self.result = LassoSelectionResult(
                matched=len(rows),
                featureIds=tuple(row.id for row in rows),
                features=rows,
                geometry=None,
            )
            self.next_stage = "highlights"
            seconds = READ_SECONDS
        else:
            geometry = _HIGHLIGHTS.validate_json(body)
            self.result = self.result.model_copy(update={"geometry": geometry})
            self.next_stage = None
            return
        self.deadline.reschedule(asyncio.get_running_loop().time() + seconds)


async def deliver_lasso_features(
    client: httpx2.AsyncClient,
    url: str,
    headers: dict[str, str],
    target: ResolvedCatalogSelection,
    feature_ids: tuple[int, ...],
) -> None:
    """Send every selected row to the waiting application before reading any outlines.

    Args:
        client: Internal connection from the supervised intersection worker.
        url: Request-scoped spatial-read endpoint.
        headers: Bearer credential issued for this source.
        target: Independently authorized original, including its applied predicates.
        feature_ids: Exact matches in ascending native ID order.

    Raises:
        GeometryValidationError: The complete attribute read exceeds its budgets.
        SelectionUnavailableError: The source or a selected row is unavailable.
        httpx2.HTTPError: The requesting application cannot accept the delivery.
    """
    limits = VectorReadLimits()
    started = await client.put(url, headers=headers, params={"stage": "attributes"})
    started.raise_for_status()
    rows = collect_feature_attributes(target, feature_ids, limits)
    delivered = await client.put(
        url,
        headers=headers,
        params={"stage": "features"},
        content=_FEATURE_ROWS.dump_json(rows.features),
    )
    delivered.raise_for_status()
    geometry = encode_lasso_highlights(target, feature_ids, limits)
    if geometry is not None:
        delivered = await client.put(
            url, headers=headers, params={"stage": "highlights"}, content=geometry
        )
        delivered.raise_for_status()


def encode_lasso_highlights(
    target: ResolvedCatalogSelection,
    feature_ids: tuple[int, ...],
    limits: VectorReadLimits,
) -> bytes | None:
    """Encode complete whole-feature highlights once inside the supervised worker.

    Args:
        target: Authorized immutable vector and its applied predicate.
        feature_ids: Exact native IDs to display, without clipping their geometries.
        limits: Existing interactive source-read budgets.

    Returns:
        Encoded WGS84 GeoJSON, or None when the display/read budget is exceeded.

    Raises:
        SelectionUnavailableError: If the original file cannot be read.
    """
    from shapely import get_num_coordinates
    from shapely.geometry import mapping

    if not feature_ids:
        return b'{"type":"FeatureCollection","features":[]}'
    features: list[bytes] = []
    coordinates = 0
    size = 64
    try:
        with _limit_memory(limits.memory_bytes):
            with closing(
                iter_original_features(
                    target,
                    limits,
                    monotonic() + limits.seconds,
                    feature_ids=feature_ids,
                )
            ) as originals:
                for feature_id, _properties, geometry in originals:
                    coordinates += int(get_num_coordinates(geometry))
                    if coordinates > MAX_DISPLAY_COORDINATES:
                        return None
                    feature = {
                        "type": "Feature",
                        "id": feature_id,
                        "properties": {},
                        "geometry": mapping(geometry),
                    }
                    encoded = json.dumps(feature, allow_nan=False).encode()
                    size += len(encoded) + 1
                    if size > MAX_DISPLAY_BYTES:
                        return None
                    features.append(encoded)
        return b'{"type":"FeatureCollection","features":[' + b",".join(features) + b"]}"
    except (GeometryValidationError, MemoryError):
        return None
