"""Read embedded GeoPackage display levels without changing the original source.

Version 1 packages keep the original table and a one-to-one copy of its feature
IDs and attributes at each display level. Only geometry differs. Empty display
geometry represents a feature smaller than that level's tolerance. Producers
must preserve attribute values; admission checks structure and feature identity.
"""

from collections import defaultdict
from contextlib import closing
from dataclasses import dataclass
import math
from pathlib import Path
import sqlite3

OVERVIEW_TABLE = "eolab_vector_overviews"
OVERVIEW_METADATA_KEY = "eolab:vector_overviews"


@dataclass(frozen=True)
class GeoPackageOverview:
    """A stored display table for the same features as an original table.

    Attributes:
        layer_name: Native GeoPackage table containing display geometry.
        tolerance: Simplification distance in the original projected CRS metres.
        geometry_column: Geometry column shared by original and display tables.
    """

    layer_name: str
    tolerance: float
    geometry_column: str


def parse_catalog_overviews(value: object) -> tuple[GeoPackageOverview, ...]:
    """Validate persisted Catalog display metadata and return immutable levels.

    Args:
        value: The optional ``eolab:vector_overviews`` property from a Catalog item.

    Returns:
        Levels in ascending tolerance order, or an empty tuple when absent.

    Raises:
        ValueError: If the persisted value is malformed or levels conflict.
    """
    if value is None:
        return ()
    if not isinstance(value, list) or not value:
        raise ValueError("GeoPackage display levels must be a nonempty list")
    levels = []
    for entry in value:
        if not isinstance(entry, dict) or set(entry) != {
            "layer_name",
            "tolerance",
            "geometry_column",
        }:
            raise ValueError("GeoPackage display level metadata is invalid")
        layer_name = entry["layer_name"]
        geometry_column = entry["geometry_column"]
        tolerance = entry["tolerance"]
        if (
            not isinstance(layer_name, str)
            or not layer_name
            or not isinstance(geometry_column, str)
            or not geometry_column
            or type(tolerance) not in (int, float)
            or not math.isfinite(tolerance)
            or tolerance <= 0
        ):
            raise ValueError(
                "GeoPackage display level identity or tolerance is invalid"
            )
        levels.append(GeoPackageOverview(layer_name, float(tolerance), geometry_column))
    if (
        len({level.layer_name for level in levels}) != len(levels)
        or len({level.tolerance for level in levels}) != len(levels)
        or len({level.geometry_column for level in levels}) != 1
        or levels != sorted(levels, key=lambda level: level.tolerance)
    ):
        raise ValueError(
            "GeoPackage display levels must have unique ascending tolerances"
        )
    return tuple(levels)


def _quote_identifier(value: str) -> str:
    """Quote a SQLite identifier obtained from the package's table metadata.

    Args:
        value: Exact table or column name.

    Returns:
        Identifier with embedded double quotes escaped for SQLite.
    """
    return '"' + value.replace('"', '""') + '"'


def read_geopackage_overviews(path: Path) -> dict[str, tuple[GeoPackageOverview, ...]]:
    """Admit embedded display tables and associate them with original layers.

    Checks schema, projected metre CRS, feature IDs and spatial-index presence at
    the source boundary. Attribute equality is the package producer's contract;
    consumers do not rescan or fingerprint admitted immutable source values.

    Args:
        path: Authorized GeoPackage file to inspect read-only.

    Returns:
        Original table names mapped to ordered display levels. Ordinary packages
        without embedded display metadata return an empty mapping.

    Raises:
        ValueError: If declared relationships or backing tables are invalid.
        sqlite3.Error: If the GeoPackage or its metadata cannot be read.
    """
    from pyproj import CRS

    with closing(
        sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    ) as connection:
        if (
            connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                (OVERVIEW_TABLE,),
            ).fetchone()
            is None
        ):
            return {}
        rows = connection.execute(
            f"SELECT version, source_layer, overview_layer, tolerance FROM {OVERVIEW_TABLE} "
            "ORDER BY source_layer, tolerance"
        ).fetchall()
        if not rows:
            raise ValueError("GeoPackage display metadata has no levels")
        geometries = {
            row[0]: row[1:]
            for row in connection.execute(
                "SELECT table_name, column_name, geometry_type_name, srs_id, z, m "
                "FROM gpkg_geometry_columns"
            )
        }
        result: dict[str, list[dict[str, object]]] = defaultdict(list)
        display_names: set[str] = set()
        checked_sources: dict[str, list[tuple[object, ...]]] = {}
        for version, source, display, tolerance in rows:
            if version != 1 or type(version) is not int:
                raise ValueError("Unsupported GeoPackage display metadata version")
            if (
                not isinstance(source, str)
                or not isinstance(display, str)
                or source == display
                or display in display_names
                or source not in geometries
                or display not in geometries
            ):
                raise ValueError(
                    "GeoPackage display metadata refers to conflicting or missing layers"
                )
            original_geometry = geometries[source]
            if geometries[display] != original_geometry:
                raise ValueError(
                    "GeoPackage display geometry schema must match its original layer"
                )
            column, geometry_type, srs_id, z, m = original_geometry
            if geometry_type not in {"POLYGON", "MULTIPOLYGON"} or z or m:
                raise ValueError(
                    "GeoPackage display levels require two-dimensional polygons"
                )
            source_identifier = _quote_identifier(source)
            display_identifier = _quote_identifier(display)
            if source not in checked_sources:
                crs_row = connection.execute(
                    "SELECT definition FROM gpkg_spatial_ref_sys WHERE srs_id=?",
                    (srs_id,),
                ).fetchone()
                if crs_row is None:
                    raise ValueError(
                        "GeoPackage display source is missing its coordinate system"
                    )
                crs = CRS.from_wkt(crs_row[0])
                if not crs.is_projected or any(
                    axis.unit_conversion_factor != 1 for axis in crs.axis_info
                ):
                    raise ValueError(
                        "GeoPackage display levels require a projected metre CRS"
                    )
                checked_sources[source] = connection.execute(
                    f"PRAGMA table_info({source_identifier})"
                ).fetchall()
            source_columns = checked_sources[source]
            if (
                connection.execute(
                    f"PRAGMA table_info({display_identifier})"
                ).fetchall()
                != source_columns
            ):
                raise ValueError(
                    "GeoPackage display attributes must match their original schema"
                )
            primary_keys = [entry[1] for entry in source_columns if entry[5]]
            if len(primary_keys) != 1:
                raise ValueError(
                    "GeoPackage display levels require one feature ID column"
                )
            fid = _quote_identifier(primary_keys[0])
            for first, second in (
                (source_identifier, display_identifier),
                (display_identifier, source_identifier),
            ):
                if (
                    connection.execute(
                        f"SELECT {fid} FROM {first} EXCEPT SELECT {fid} FROM {second} LIMIT 1"
                    ).fetchone()
                    is not None
                ):
                    raise ValueError(
                        "GeoPackage display feature IDs differ from the original layer"
                    )
            index_name = f"rtree_{display}_{column}"
            if (
                connection.execute(
                    "SELECT 1 FROM gpkg_extensions WHERE table_name=? AND column_name=? "
                    "AND extension_name='gpkg_rtree_index'",
                    (display, column),
                ).fetchone()
                is None
                or connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                    (index_name,),
                ).fetchone()
                is None
            ):
                raise ValueError("GeoPackage display layers require a spatial index")
            result[source].append(
                {
                    "layer_name": display,
                    "tolerance": tolerance,
                    "geometry_column": column,
                }
            )
            display_names.add(display)
        if display_names.intersection(result):
            raise ValueError("A GeoPackage display layer cannot be an original layer")
        return {
            source: parse_catalog_overviews(levels) for source, levels in result.items()
        }
