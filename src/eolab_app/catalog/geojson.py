"""Discover and stream metadata from GeoJSON FeatureCollections."""

import hashlib
import math
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import ijson

from eolab_app.catalog.vector import (
    MOUNTED_VECTOR_COLLECTION_ID,
    TABLE_EXTENSION,
    build_bbox_polygon,
    build_vector_source_properties,
    build_vector_table_properties,
)


GEOJSON_MEDIA_TYPE = "application/geo+json"
PROJECTION_EXTENSION = (
    "https://stac-extensions.github.io/projection/v1.1.0/schema.json"
)
MAX_PROPERTY_COLUMNS = 1_024
MAX_PROPERTY_NAME_LENGTH = 1_024
MAX_GEOMETRY_COLLECTION_DEPTH = 32
FALLBACK_DATETIME_DESCRIPTION = (
    "GeoJSON has no standardized observation or acquisition timestamp used by "
    "EOLab. The Item datetime uses the source file's filesystem modification "
    "time."
)
SUPPORTED_LEGACY_WGS84_NAMES = frozenset({
    "crs84",
    "epsg:4326",
    "ogc:crs84",
    "urn:ogc:def:crs:epsg::4326",
    "urn:ogc:def:crs:ogc:1.3:crs84",
    "http://www.opengis.net/def/crs/epsg/0/4326",
    "http://www.opengis.net/def/crs/ogc/1.3/crs84",
})
JSON_TYPE_ORDER = (
    "boolean",
    "integer",
    "number",
    "string",
    "array",
    "object",
    "null",
)
GEOMETRY_TYPE_ORDER = (
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
    "GeometryCollection",
    "null",
)
JsonEvent = tuple[str, str, Any]


@dataclass
class _RootContract:
    """Bounded validation state for the GeoJSON top-level object.

    Attributes:
        root_started: Whether the document began with an object.
        root_finished: Whether the top-level object ended normally.
        member_names: Top-level member names already encountered.
        feature_collection_type: Value of the top-level ``type`` member.
        features_is_array: Whether ``features`` is a JSON array.
        legacy_crs_is_object: Whether a non-null legacy ``crs`` object exists.
        legacy_crs_type: Value of the legacy CRS object's ``type`` member.
        legacy_crs_name: Value of the legacy CRS name property.
    """

    root_started: bool = False
    root_finished: bool = False
    member_names: set[str] = field(default_factory=set)
    feature_collection_type: str | None = None
    features_is_array: bool = False
    legacy_crs_is_object: bool = False
    legacy_crs_type: str | None = None
    legacy_crs_name: str | None = None

    def observe(self, prefix: str, event: str, value: Any) -> None:
        """Observe one incremental parser event without retaining source data.

        Args:
            prefix: Ijson path prefix for the event.
            event: Ijson event kind.
            value: Scalar value or container marker supplied by ijson.

        Returns:
            None.

        Raises:
            ValueError: If the root shape, duplicate members, or legacy CRS
                declaration violates the supported GeoJSON contract.
        """
        if prefix == "" and event == "start_map":
            if self.root_started:
                raise ValueError("GeoJSON contains multiple top-level objects")
            self.root_started = True
        elif prefix == "" and event == "end_map":
            self.root_finished = True
        elif prefix == "" and event == "map_key":
            if value in self.member_names:
                raise ValueError(
                    f"GeoJSON has duplicate top-level member: {value}"
                )
            self.member_names.add(value)
        elif prefix == "type":
            if event != "string":
                raise ValueError("GeoJSON top-level type must be a string")
            self.feature_collection_type = value
        elif prefix == "features":
            if event != "start_array":
                if event not in {"end_array"}:
                    raise ValueError("GeoJSON features member must be an array")
            else:
                self.features_is_array = True
        elif prefix == "crs":
            if event == "null":
                return
            if event != "start_map":
                if event not in {"end_map", "map_key"}:
                    raise ValueError(
                        "GeoJSON legacy crs member must be an object or null"
                    )
            else:
                self.legacy_crs_is_object = True
        elif prefix == "crs.type" and event == "string":
            self.legacy_crs_type = value
        elif prefix == "crs.properties.name" and event == "string":
            self.legacy_crs_name = value

    def validate(self) -> None:
        """Validate the completed root and explicit legacy CRS policy.

        Returns:
            None.

        Raises:
            ValueError: If the document is not one FeatureCollection or names
                a CRS other than an accepted WGS 84 representation.
        """
        if not self.root_started or not self.root_finished:
            raise ValueError("GeoJSON document must contain one top-level object")
        if self.feature_collection_type != "FeatureCollection":
            raise ValueError("GeoJSON top-level type must be FeatureCollection")
        if "features" not in self.member_names or not self.features_is_array:
            raise ValueError("GeoJSON FeatureCollection must contain features")
        if not self.legacy_crs_is_object:
            return
        if (
            self.legacy_crs_type != "name"
            or self.legacy_crs_name is None
            or self.legacy_crs_name.casefold()
            not in SUPPORTED_LEGACY_WGS84_NAMES
        ):
            raise ValueError(
                "GeoJSON legacy CRS must unambiguously name WGS 84/CRS84; "
                "reprojection is not performed"
            )


@dataclass
class _Bounds:
    """Streaming WGS 84 coordinate bounds.

    Attributes:
        west: Smallest longitude encountered.
        south: Smallest latitude encountered.
        east: Largest longitude encountered.
        north: Largest latitude encountered.
    """

    west: float | None = None
    south: float | None = None
    east: float | None = None
    north: float | None = None

    def include(self, position: list[Any]) -> None:
        """Validate one RFC 7946 position and include its first two axes.

        Args:
            position: GeoJSON coordinate position with longitude and latitude.

        Returns:
            None.

        Raises:
            ValueError: If the position is too short, nonnumeric, nonfinite, or
                outside RFC 7946 longitude and latitude ranges.
        """
        if len(position) < 2:
            raise ValueError(
                "GeoJSON coordinate positions require longitude and latitude"
            )
        if any(
            isinstance(coordinate, bool)
            or not isinstance(coordinate, (int, float))
            or not math.isfinite(coordinate)
            for coordinate in position
        ):
            raise ValueError("GeoJSON coordinate positions must be finite numbers")
        longitude = float(position[0])
        latitude = float(position[1])
        if not -180 <= longitude <= 180 or not -90 <= latitude <= 90:
            raise ValueError(
                "GeoJSON coordinates must use RFC 7946 WGS 84 longitude and "
                "latitude ranges"
            )
        self.west = longitude if self.west is None else min(self.west, longitude)
        self.south = latitude if self.south is None else min(self.south, latitude)
        self.east = longitude if self.east is None else max(self.east, longitude)
        self.north = latitude if self.north is None else max(self.north, latitude)

    def as_bbox(self) -> list[float]:
        """Return complete bounds in STAC order.

        Returns:
            West, south, east, and north bounds.

        Raises:
            ValueError: If no coordinate position was encountered.
        """
        west = self.west
        south = self.south
        east = self.east
        north = self.north
        if None in (west, south, east, north):
            raise ValueError(
                "GeoJSON FeatureCollection has no spatial footprint; pgSTAC "
                "requires Item geometry"
            )
        assert west is not None
        assert south is not None
        assert east is not None
        assert north is not None
        return [west, south, east, north]


def discover_geojson_datasets(
    directory_path: Path,
    file_names: tuple[str, ...],
) -> tuple[Path, ...]:
    """Recognize GeoJSON files from one deterministic directory listing.

    Args:
        directory_path: Directory containing the listed files.
        file_names: Sorted file names supplied by the active directory walk.

    Returns:
        GeoJSON paths matching ``.geojson`` case-insensitively. Generic JSON
        files are intentionally excluded.
    """
    return tuple(
        directory_path / file_name
        for file_name in file_names
        if Path(file_name).suffix.lower() == ".geojson"
    )


def build_stac_item(source_root: Path, geojson_path: Path) -> dict[str, Any]:
    """Stream one GeoJSON FeatureCollection into a vector STAC Item.

    Memory use is independent of the FeatureCollection's feature count. The
    parser retains at most one feature plus aggregate bounds, geometry types,
    and a capped property-column map.

    Args:
        source_root: Root directory mounted for scanning.
        geojson_path: GeoJSON FeatureCollection below the mounted root.

    Returns:
        A STAC Item with WGS 84 bounds, Table Extension schema metadata, and a
        source-file Asset.

    Raises:
        ValueError: If the document is malformed, is not a FeatureCollection,
            exceeds schema bounds, declares an unsupported legacy CRS, has
            invalid geometry, or has no spatial footprint.
        OSError: If the source file cannot be opened or inspected.
    """
    relative_path = geojson_path.relative_to(source_root)
    relative_path_text = relative_path.as_posix()
    root_contract = _RootContract()
    bounds = _Bounds()
    feature_count = 0
    geometry_types: set[str] = set()
    field_types: dict[str, set[str]] = {}

    try:
        with geojson_path.open("rb") as source:
            parser_events = ijson.parse(source, use_float=True)
            observed_events = _observe_root(parser_events, root_contract)
            for feature in ijson.items(observed_events, "features.item"):
                feature_count += 1
                _summarize_feature(
                    feature,
                    feature_count,
                    bounds,
                    geometry_types,
                    field_types,
                )
        root_contract.validate()
    except (ijson.JSONError, UnicodeDecodeError) as error:
        raise ValueError(f"GeoJSON is malformed: {error}") from error

    bbox = bounds.as_bbox()
    geometry_type = _join_types(geometry_types, GEOMETRY_TYPE_ORDER)
    field_columns = tuple(
        (field_name, _join_types(types, JSON_TYPE_ORDER))
        for field_name, types in field_types.items()
    )
    modified_at = datetime.fromtimestamp(
        geojson_path.stat().st_mtime,
        tz=timezone.utc,
    ).isoformat().replace("+00:00", "Z")
    properties = {
        "title": relative_path_text,
        "description": FALLBACK_DATETIME_DESCRIPTION,
        "datetime": modified_at,
        "proj:epsg": 4326,
        "proj:bbox": bbox,
        **build_vector_source_properties("geojson", "data", None),
        **build_vector_table_properties(
            feature_count,
            geometry_type,
            field_columns,
        ),
    }
    footprint = build_bbox_polygon(bbox)
    item_identifier = hashlib.sha256(
        relative_path_text.encode("utf-8")
    ).hexdigest()
    return {
        "type": "Feature",
        "stac_version": "1.0.0",
        "stac_extensions": [PROJECTION_EXTENSION, TABLE_EXTENSION],
        "id": f"geojson-{item_identifier[:24]}",
        "collection": MOUNTED_VECTOR_COLLECTION_ID,
        "geometry": footprint,
        "bbox": bbox,
        "properties": properties,
        "links": [],
        "assets": {
            "data": {
                "href": geojson_path.resolve().as_uri(),
                "type": GEOJSON_MEDIA_TYPE,
                "title": relative_path_text,
                "roles": ["data"],
                "updated": modified_at,
            }
        },
    }


def _observe_root(
    parser_events: Iterable[JsonEvent],
    root_contract: _RootContract,
) -> Iterator[JsonEvent]:
    """Yield parser events while validating bounded top-level metadata.

    Args:
        parser_events: Incremental ``(prefix, event, value)`` parser events.
        root_contract: Mutable top-level validation state.

    Yields:
        The original parser events for downstream feature materialization.

    Raises:
        ValueError: If root validation fails while observing an event.
    """
    for prefix, event, value in parser_events:
        root_contract.observe(prefix, event, value)
        yield prefix, event, value


def _summarize_feature(
    feature: Any,
    feature_number: int,
    bounds: _Bounds,
    geometry_types: set[str],
    field_types: dict[str, set[str]],
) -> None:
    """Merge one materialized feature into bounded dataset metadata.

    Args:
        feature: Parsed GeoJSON feature value.
        feature_number: One-based position in the FeatureCollection.
        bounds: Mutable aggregate spatial bounds.
        geometry_types: Mutable aggregate geometry-type set.
        field_types: Mutable capped property-name to JSON-type mapping.

    Returns:
        None.

    Raises:
        ValueError: If the feature, geometry, properties, or schema size is
            invalid.
    """
    if not isinstance(feature, dict) or feature.get("type") != "Feature":
        raise ValueError(f"GeoJSON feature {feature_number} must have type Feature")
    if "geometry" not in feature:
        raise ValueError(f"GeoJSON feature {feature_number} has no geometry member")
    geometry = feature["geometry"]
    if geometry is None:
        geometry_types.add("null")
    else:
        geometry_types.add(_summarize_geometry(geometry, bounds, 0))

    if "properties" not in feature:
        raise ValueError(
            f"GeoJSON feature {feature_number} has no properties member"
        )
    feature_properties = feature["properties"]
    if feature_properties is None:
        return
    if not isinstance(feature_properties, dict):
        raise ValueError(
            f"GeoJSON feature {feature_number} properties must be an object or null"
        )
    for field_name, field_value in feature_properties.items():
        if len(field_name) > MAX_PROPERTY_NAME_LENGTH:
            raise ValueError(
                "GeoJSON property name exceeds the supported "
                f"{MAX_PROPERTY_NAME_LENGTH}-character bound"
            )
        if field_name not in field_types:
            if len(field_types) == MAX_PROPERTY_COLUMNS:
                raise ValueError(
                    "GeoJSON schema exceeds the supported "
                    f"{MAX_PROPERTY_COLUMNS}-column bound"
                )
            field_types[field_name] = set()
        field_types[field_name].add(_json_type(field_value))


def _summarize_geometry(
    geometry: Any,
    bounds: _Bounds,
    collection_depth: int,
) -> str:
    """Validate one geometry recursively and merge its coordinate bounds.

    Args:
        geometry: Parsed GeoJSON geometry object.
        bounds: Mutable aggregate spatial bounds.
        collection_depth: Current GeometryCollection nesting depth.

    Returns:
        Declared GeoJSON geometry type.

    Raises:
        ValueError: If the geometry type, coordinates, or collection nesting
            violates the supported RFC 7946 contract.
    """
    if not isinstance(geometry, dict):
        raise ValueError("GeoJSON geometry must be an object or null")
    geometry_type = geometry.get("type")
    if geometry_type == "GeometryCollection":
        if collection_depth == MAX_GEOMETRY_COLLECTION_DEPTH:
            raise ValueError(
                "GeoJSON GeometryCollection nesting exceeds the supported "
                f"depth of {MAX_GEOMETRY_COLLECTION_DEPTH}"
            )
        geometries = geometry.get("geometries")
        if not isinstance(geometries, list):
            raise ValueError(
                "GeoJSON GeometryCollection geometries must be an array"
            )
        for child_geometry in geometries:
            _summarize_geometry(child_geometry, bounds, collection_depth + 1)
        return geometry_type

    coordinates = geometry.get("coordinates")
    if geometry_type == "Point":
        _include_position(coordinates, bounds)
    elif geometry_type == "MultiPoint":
        _include_position_array(coordinates, bounds, "MultiPoint")
    elif geometry_type == "LineString":
        _include_line(coordinates, bounds, "LineString")
    elif geometry_type == "MultiLineString":
        _include_multi_line(coordinates, bounds)
    elif geometry_type == "Polygon":
        _include_polygon(coordinates, bounds, "Polygon")
    elif geometry_type == "MultiPolygon":
        if not isinstance(coordinates, list):
            raise ValueError("GeoJSON MultiPolygon coordinates must be an array")
        for polygon in coordinates:
            _include_polygon(polygon, bounds, "MultiPolygon")
    else:
        raise ValueError(f"GeoJSON has unsupported geometry type: {geometry_type}")
    return geometry_type


def _include_position(position: Any, bounds: _Bounds) -> None:
    """Validate and aggregate one GeoJSON coordinate position.

    Args:
        position: Candidate coordinate position.
        bounds: Mutable aggregate spatial bounds.

    Returns:
        None.

    Raises:
        ValueError: If the position is not a JSON array or has invalid axes.
    """
    if not isinstance(position, list):
        raise ValueError("GeoJSON coordinate position must be an array")
    bounds.include(position)


def _include_position_array(
    positions: Any,
    bounds: _Bounds,
    geometry_name: str,
) -> None:
    """Aggregate an array of positions.

    Args:
        positions: Candidate JSON array of coordinate positions.
        bounds: Mutable aggregate spatial bounds.
        geometry_name: Geometry name used in validation errors.

    Returns:
        None.

    Raises:
        ValueError: If the value is not an array or contains invalid positions.
    """
    if not isinstance(positions, list):
        raise ValueError(f"GeoJSON {geometry_name} coordinates must be an array")
    for position in positions:
        _include_position(position, bounds)


def _include_line(coordinates: Any, bounds: _Bounds, geometry_name: str) -> None:
    """Validate and aggregate a GeoJSON line coordinate array.

    Args:
        coordinates: Candidate JSON array of positions.
        bounds: Mutable aggregate spatial bounds.
        geometry_name: Geometry name used in validation errors.

    Returns:
        None.

    Raises:
        ValueError: If fewer than two positions exist or a position is invalid.
    """
    if not isinstance(coordinates, list) or len(coordinates) < 2:
        raise ValueError(
            f"GeoJSON {geometry_name} requires at least two positions"
        )
    _include_position_array(coordinates, bounds, geometry_name)


def _include_multi_line(coordinates: Any, bounds: _Bounds) -> None:
    """Validate and aggregate a MultiLineString coordinate array.

    Args:
        coordinates: Candidate JSON array of line coordinate arrays.
        bounds: Mutable aggregate spatial bounds.

    Returns:
        None.

    Raises:
        ValueError: If the value is not an array or a line is invalid.
    """
    if not isinstance(coordinates, list):
        raise ValueError("GeoJSON MultiLineString coordinates must be an array")
    for line in coordinates:
        _include_line(line, bounds, "MultiLineString")


def _include_polygon(coordinates: Any, bounds: _Bounds, geometry_name: str) -> None:
    """Validate and aggregate a Polygon coordinate array.

    Args:
        coordinates: Candidate JSON array of linear rings.
        bounds: Mutable aggregate spatial bounds.
        geometry_name: Geometry name used in validation errors.

    Returns:
        None.

    Raises:
        ValueError: If rings are missing, too short, unclosed, or invalid.
    """
    if not isinstance(coordinates, list) or not coordinates:
        raise ValueError(f"GeoJSON {geometry_name} requires at least one ring")
    for ring in coordinates:
        if not isinstance(ring, list) or len(ring) < 4:
            raise ValueError(
                f"GeoJSON {geometry_name} linear rings require at least four "
                "positions"
            )
        if ring[0] != ring[-1]:
            raise ValueError(
                f"GeoJSON {geometry_name} linear rings must be closed"
            )
        _include_position_array(ring, bounds, geometry_name)


def _json_type(value: Any) -> str:
    """Return the precise JSON type of one property value.

    Args:
        value: Parsed JSON property value.

    Returns:
        One of the bounded scalar or container type labels used in table
        metadata.

    Raises:
        TypeError: If ijson returns a value outside JSON's data model.
    """
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    raise TypeError(f"Unsupported parsed JSON property type: {type(value).__name__}")


def _join_types(types: set[str], preferred_order: tuple[str, ...]) -> str:
    """Create one deterministic and lossless Table Extension type string.

    Args:
        types: Observed JSON or geometry type names.
        preferred_order: Canonical output ordering for the type vocabulary.

    Returns:
        One type or a pipe-delimited union of observed types. Integer is folded
        into number when both numeric representations occur.

    Raises:
        ValueError: If no type was observed.
    """
    normalized_types = set(types)
    if "integer" in normalized_types and "number" in normalized_types:
        normalized_types.remove("integer")
    if not normalized_types:
        raise ValueError("GeoJSON metadata type summary cannot be empty")
    ordered_types = [
        type_name
        for type_name in preferred_order
        if type_name in normalized_types
    ]
    ordered_types.extend(sorted(normalized_types - set(preferred_order)))
    return " | ".join(ordered_types)
