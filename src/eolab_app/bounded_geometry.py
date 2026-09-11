"""Bounded coordinate validation for original Catalog-vector geometries."""

import math
from collections.abc import Iterator, Sequence
from typing import Any
from numbers import Real


MAX_GEOMETRY_NESTING_DEPTH = 32


class GeometryValidationError(ValueError):
    """A geometry cannot satisfy the bounded WGS84 selection contract."""


def _geometry_positions(
    geometry: dict[str, Any], depth: int = 0, *, canonical: bool = True
) -> Iterator[tuple[float, float]]:
    """Yield bounded geometry positions.

    Args:
        geometry: Transformed GeoJSON geometry.
        depth: Current collection depth.
        canonical: Validate world bounds after transformation.

    Yields:
        Canonical longitude/latitude pairs.

    Raises:
        GeometryValidationError: If coordinates or nesting violate the source contract.
    """
    if depth > MAX_GEOMETRY_NESTING_DEPTH:
        raise GeometryValidationError(
            "Selection geometry exceeds the supported nesting depth"
        )
    if geometry.get("type") == "GeometryCollection":
        for child in geometry.get("geometries", []):
            yield from _geometry_positions(child, depth + 1, canonical=canonical)
    else:
        yield from _positions(geometry.get("coordinates"), canonical=canonical)


def _positions(
    value: object, depth: int = 0, *, canonical: bool = True
) -> Iterator[tuple[float, float]]:
    """Yield finite bounded coordinate positions.

    Args:
        value: Nested coordinates.
        depth: Current coordinate nesting depth.
        canonical: Require longitude/latitude world bounds after transformation.

    Yields:
        Floating-point positions.

    Raises:
        GeometryValidationError: If positions are malformed, nonfinite or out of bounds.
    """
    if depth > MAX_GEOMETRY_NESTING_DEPTH or not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise GeometryValidationError(
            "Selection has malformed coordinates or excessive nesting depth"
        )
    if value and all(isinstance(item, Real) for item in value):
        if len(value) < 2 or not all(math.isfinite(float(item)) for item in value):
            raise GeometryValidationError(
                "Selection coordinates must contain finite positions"
            )
        x, y = float(value[0]), float(value[1])
        if canonical and not (-180 <= x <= 180 and -90 <= y <= 90):
            raise GeometryValidationError(
                "Selection geometry is outside canonical WGS 84 bounds"
            )
        yield x, y
    else:
        for child in value:
            yield from _positions(child, depth + 1, canonical=canonical)
