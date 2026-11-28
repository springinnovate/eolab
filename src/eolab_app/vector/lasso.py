"""Deliver a Lasso selection's original feature attributes and optional map outlines."""

import asyncio
import json
from collections.abc import Iterator
from contextlib import closing
from dataclasses import dataclass
from itertools import chain
from math import ceil
from time import monotonic
from typing import Literal

import httpx2
from pydantic import BaseModel, ConfigDict, Field, JsonValue, TypeAdapter
from shapely import get_num_coordinates
from shapely.geometry import mapping
from shapely.geometry.base import BaseGeometry

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
        geometry: Attribute-free highlights for every match, or None when the
            bounded map read cannot provide them. A FeatureCollection with
            simplified=true uses less detailed shapes or points on the features.
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


def _encode_highlight(
    feature_id: int, geometry: BaseGeometry, coordinates_left: int, bytes_left: int
) -> tuple[bytes, int] | None:
    """Encode one map feature if it fits both remaining display budgets.

    Args:
        feature_id: Original native ID.
        geometry: WGS84 shape to draw at its original location.
        coordinates_left: Maximum number of coordinates for this shape.
        bytes_left: Maximum encoded bytes for this GeoJSON Feature.

    Returns:
        GeoJSON bytes and coordinate count, or None if either limit is exceeded.
    """
    coordinates = int(get_num_coordinates(geometry))
    if coordinates > coordinates_left:
        return None
    feature = {
        "type": "Feature",
        "id": feature_id,
        "properties": {},
        "geometry": mapping(geometry),
    }
    encoded = json.dumps(feature, allow_nan=False, separators=(",", ":")).encode()
    return (encoded, coordinates) if len(encoded) <= bytes_left else None


def _highlight_shapes(geometry: BaseGeometry) -> Iterator[BaseGeometry]:
    """Offer progressively coarser map shapes, ending with a point on the feature.

    Args:
        geometry: Selected original in WGS84.

    Yields:
        Original geometry, then topology-preserving approximations from fine
        to coarse relative to the feature's extent. The last choice locates a
        feature whose disconnected parts cannot fit even at coarse resolution.
    """
    yield geometry
    west, south, east, north = geometry.bounds
    span = max(east - west, north - south)
    for divisor in (4096, 512, 64, 8, 1):
        yield geometry.simplify(span / divisor, preserve_topology=True)
    yield geometry.representative_point()


def encode_lasso_highlights(
    target: ResolvedCatalogSelection,
    feature_ids: tuple[int, ...],
    limits: VectorReadLimits,
) -> bytes | None:
    """Return map highlights for every match from a single supervised source read.

    Args:
        target: Authorized immutable vector with its applied predicate.
        feature_ids: Exact native IDs to display in the supplied order.
        limits: Existing interactive source-read budgets.

    Returns:
        WGS84 GeoJSON with original shapes if they all fit. Otherwise each
        feature receives a share of the display budget for a reduced shape or
        location marker. Its GeoJSON collection has a boolean "simplified"
        member set to true. Returns None if the complete display cannot fit.

    Raises:
        SelectionUnavailableError: If the original file cannot be read.
    """
    prefix = b'{"type":"FeatureCollection","features":['
    suffix = b"]}"
    if not feature_ids:
        return prefix + suffix
    deadline = monotonic() + limits.seconds
    try:
        with (
            _limit_memory(limits.memory_bytes),
            closing(
                iter_original_features(
                    target, limits, deadline, feature_ids=feature_ids
                )
            ) as originals,
        ):
            shapes = ((fid, geometry) for fid, _, geometry in originals)
            buffered_shapes: list[tuple[int, BaseGeometry]] = []
            encoded: list[bytes] = []
            coordinates_left = MAX_DISPLAY_COORDINATES
            bytes_left = (
                MAX_DISPLAY_BYTES - len(prefix + suffix) - (len(feature_ids) - 1)
            )
            for fid, geometry in shapes:
                buffered_shapes.append((fid, geometry))
                exact = _encode_highlight(fid, geometry, coordinates_left, bytes_left)
                if exact is None:
                    break
                data, coordinates = exact
                encoded.append(data)
                coordinates_left -= coordinates
                bytes_left -= len(data)
            else:
                return prefix + b",".join(encoded) + suffix

            # Reuse the small exact prefix and continue the open reader from
            # the first overflow. No feature is fetched or projected twice.
            prefix = b'{"type":"FeatureCollection","simplified":true,"features":['
            count = len(feature_ids)
            byte_share = (
                MAX_DISPLAY_BYTES - len(prefix + suffix) - (count - 1)
            ) // count
            coordinate_share = MAX_DISPLAY_COORDINATES // count
            encoded.clear()
            if coordinate_share == 0 or byte_share <= 0:
                return None
            for fid, geometry in chain(buffered_shapes, shapes):
                for candidate in _highlight_shapes(geometry):
                    if monotonic() >= deadline:
                        return None
                    reduced = _encode_highlight(
                        fid, candidate, coordinate_share, byte_share
                    )
                    if reduced is not None:
                        encoded.append(reduced[0])
                        break
                else:
                    return None
            return prefix + b",".join(encoded) + suffix
    except (GeometryValidationError, MemoryError):
        return None
