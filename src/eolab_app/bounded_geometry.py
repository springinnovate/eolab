"""Bounded geometry conversion shared by uploaded and catalog selections."""

import json
import math
from collections.abc import Sequence
from numbers import Real

from fiona.model import to_dict
from fiona.transform import transform_geom
from rasterio.features import is_valid_geom
from shapely.geometry import shape

MAX_FEATURES = 10_000
MAX_COORDINATE_POSITIONS = 100_000
MAX_BROWSER_GEOMETRY_BYTES = 2 * 1024 * 1024
MAX_GEOMETRY_NESTING_DEPTH = 32


class GeometryValidationError(ValueError):
    """A geometry cannot satisfy the bounded WGS84 selection contract."""


class GeometryBuilder:
    """Accumulate bounded, attribute-free WGS84 features without simplification."""

    def __init__(self, *, polygons_only: bool = False) -> None:
        """Initialize a collection.

        Args:
            polygons_only: Require valid Polygon or MultiPolygon topology.
        """
        self.polygons_only = polygons_only
        self.features = []
        self.bounds = [math.inf, math.inf, -math.inf, -math.inf]
        self.coordinate_count = 0
        self.byte_count = 0

    def add(self, source_geometry: dict, crs: object) -> None:
        """Transform and append one geometry within cumulative budgets.

        Args:
            source_geometry: Native GeoJSON geometry, without attributes.
            crs: Explicit Fiona-compatible source CRS.

        Raises:
            GeometryValidationError: If geometry or a cumulative budget is invalid.
        """
        if not crs or source_geometry is None:
            raise GeometryValidationError("AOI requires a CRS and non-null geometry")
        if len(self.features) >= MAX_FEATURES:
            raise GeometryValidationError(f"AOI exceeds the {MAX_FEATURES}-feature limit; filter first")
        # Check nesting/size before asking native code to transform the geometry.
        for index, _ in enumerate(_geometry_positions(source_geometry, canonical=False), 1):
            if index + self.coordinate_count > MAX_COORDINATE_POSITIONS:
                raise GeometryValidationError(f"AOI geometry exceeds the {MAX_COORDINATE_POSITIONS}-coordinate limit; filter first")
        geometry = to_dict(transform_geom(crs, "EPSG:4326", source_geometry, antimeridian_cutting=False))
        if not is_valid_geom(geometry):
            raise GeometryValidationError("AOI contains unsupported or malformed geometry")
        if self.polygons_only and (geometry.get("type") not in {"Polygon", "MultiPolygon"}
                                   or not shape(geometry).is_valid):
            raise GeometryValidationError("Sampling requires valid polygons; repair the source geometry first")
        for longitude, latitude in _geometry_positions(geometry):
            self.coordinate_count += 1
            if self.coordinate_count > MAX_COORDINATE_POSITIONS:
                raise GeometryValidationError(f"AOI geometry exceeds the {MAX_COORDINATE_POSITIONS}-coordinate limit; filter first")
            self.bounds[0] = min(self.bounds[0], longitude)
            self.bounds[1] = min(self.bounds[1], latitude)
            self.bounds[2] = max(self.bounds[2], longitude)
            self.bounds[3] = max(self.bounds[3], latitude)
        feature = {"type": "Feature", "properties": {}, "geometry": geometry}
        self.byte_count += len(json.dumps(feature, allow_nan=False, separators=(",", ":")).encode("utf-8")) + 1
        if self.byte_count + 42 > MAX_BROWSER_GEOMETRY_BYTES:
            raise GeometryValidationError(f"AOI browser geometry exceeds the {MAX_BROWSER_GEOMETRY_BYTES}-byte limit; filter first")
        self.features.append(feature)

    def finish(self) -> tuple[dict, tuple[float, float, float, float]]:
        """Return a complete bounded collection and bounds.

        Returns:
            Attribute-free FeatureCollection and canonical bounds.

        Raises:
            GeometryValidationError: If no finite geometry was selected.
        """
        if not self.features or not all(math.isfinite(value) for value in self.bounds):
            raise GeometryValidationError("No matching polygon features; change the filter")
        return {"type": "FeatureCollection", "features": self.features}, tuple(self.bounds)


def _geometry_positions(geometry: dict, depth: int = 0, *, canonical: bool = True):
    """Yield bounded geometry positions.

    Args:
        geometry: Transformed GeoJSON geometry.
        depth: Current collection depth.
        canonical: Validate world bounds after transformation.

    Yields:
        Canonical longitude/latitude pairs.
    """
    if depth > MAX_GEOMETRY_NESTING_DEPTH:
        raise GeometryValidationError("AOI geometry exceeds the supported nesting depth")
    if geometry.get("type") == "GeometryCollection":
        for child in geometry.get("geometries", []):
            yield from _geometry_positions(child, depth + 1, canonical=canonical)
    else:
        yield from _positions(geometry.get("coordinates"), canonical=canonical)


def _positions(value: object, depth: int = 0, *, canonical: bool = True):
    """Yield finite bounded coordinate positions.

    Args:
        value: Nested coordinates.
        depth: Current coordinate nesting depth.
        canonical: Require longitude/latitude world bounds after transformation.

    Yields:
        Floating-point positions.
    """
    if depth > MAX_GEOMETRY_NESTING_DEPTH or not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise GeometryValidationError("AOI has malformed coordinates or excessive nesting depth")
    if value and all(isinstance(item, Real) for item in value):
        if len(value) < 2 or not all(math.isfinite(float(item)) for item in value):
            raise GeometryValidationError("AOI coordinates must contain finite positions")
        x, y = float(value[0]), float(value[1])
        if canonical and not (-180 <= x <= 180 and -90 <= y <= 90):
            raise GeometryValidationError("AOI geometry is outside canonical WGS 84 bounds")
        yield x, y
    else:
        for child in value:
            yield from _positions(child, depth + 1, canonical=canonical)
