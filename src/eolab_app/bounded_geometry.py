"""Validate GeoJSON coordinates and nesting for vector analysis."""

import math
from collections.abc import Iterator, Sequence
from typing import Any
from numbers import Real


MAX_GEOMETRY_NESTING_DEPTH = 32


class GeometryValidationError(ValueError):
    """Coordinates are malformed, too deeply nested or outside the required bounds."""


def _iter_geometry_coordinates(
    geometry: dict[str, Any], depth: int = 0, *, validate_wgs84_bounds: bool = True
) -> Iterator[tuple[float, float]]:
    """Validate and yield coordinate pairs from a GeoJSON geometry or collection.

    Args:
        geometry: GeoJSON geometry before or after transformation to WGS84.
        depth: Current collection depth.
        validate_wgs84_bounds: Require longitude/latitude bounds after transformation.

    Yields:
        Finite x/y pairs, restricted to WGS84 bounds when requested.

    Raises:
        GeometryValidationError: If coordinates or nesting violate the source contract.
    """
    if depth > MAX_GEOMETRY_NESTING_DEPTH:
        raise GeometryValidationError(
            "Selection geometry exceeds the supported nesting depth"
        )
    if geometry.get("type") == "GeometryCollection":
        for child in geometry.get("geometries", []):
            yield from _iter_geometry_coordinates(
                child, depth + 1, validate_wgs84_bounds=validate_wgs84_bounds
            )
    else:
        yield from _iter_coordinate_pairs(
            geometry.get("coordinates"), validate_wgs84_bounds=validate_wgs84_bounds
        )


def _iter_coordinate_pairs(
    value: object, depth: int = 0, *, validate_wgs84_bounds: bool = True
) -> Iterator[tuple[float, float]]:
    """Validate nested coordinate arrays and yield their finite x/y pairs.

    Args:
        value: Nested coordinates.
        depth: Current coordinate nesting depth.
        validate_wgs84_bounds: Require longitude/latitude bounds after transformation.

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
        if validate_wgs84_bounds and not (-180 <= x <= 180 and -90 <= y <= 90):
            raise GeometryValidationError(
                "Selection geometry is outside canonical WGS 84 bounds"
            )
        yield x, y
    else:
        for child in value:
            yield from _iter_coordinate_pairs(
                child, depth + 1, validate_wgs84_bounds=validate_wgs84_bounds
            )
