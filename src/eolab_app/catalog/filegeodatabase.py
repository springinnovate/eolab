"""Discover and extract STAC metadata from Esri File Geodatabases."""

import hashlib
import logging
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import fiona
from rasterio.crs import CRS
from rasterio.errors import RasterioError
from rasterio.warp import transform_bounds

from eolab_app.catalog.vector import (
    MOUNTED_VECTOR_COLLECTION_ID,
    TABLE_EXTENSION,
    build_vector_table_properties,
)


OPENFILEGDB_DRIVER = "OpenFileGDB"
LOGGER = logging.getLogger(__name__)
FILE_GEODATABASE_MEDIA_TYPE = "application/vnd.esri.file-geodatabase"
PROJECTION_EXTENSION = (
    "https://stac-extensions.github.io/projection/v1.1.0/schema.json"
)
FALLBACK_DATETIME_DESCRIPTION = (
    "File Geodatabase feature classes have no standardized observation or "
    "acquisition timestamp used by EOLab. The Item datetime uses the latest "
    "filesystem modification time in the geodatabase directory tree."
)
GEOJSON_GEOMETRY_TYPES = {
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
    "GeometryCollection",
}


def discover_file_geodatabases(
    directory_path: Path,
    directory_names: tuple[str, ...],
) -> tuple[Path, ...]:
    """Recognize File Geodatabase container directories in one listing.

    Args:
        directory_path: Directory containing the listed child directories.
        directory_names: Sorted child directory names from the active walk.

    Returns:
        File Geodatabase paths in the supplied deterministic listing order.
    """
    return tuple(
        directory_path / directory_name
        for directory_name in directory_names
        if directory_name.lower().endswith(".gdb")
    )


def build_stac_items(
    source_root: Path,
    geodatabase_path: Path,
) -> tuple[dict[str, Any], ...]:
    """Build one STAC Item per readable spatial feature class.

    A failure in one layer does not suppress Items from other layers. When no
    layer succeeds and at least one layer failed, the first failure is raised
    so the metadata pipeline records the source dataset as failed.

    Args:
        source_root: Root directory mounted for scanning.
        geodatabase_path: File Geodatabase directory below the mounted root.

    Returns:
        Deterministically ordered Items for readable spatial layers. A
        geodatabase containing only nonspatial tables returns an empty tuple.

    Raises:
        ValueError: If the geodatabase is outside the source root or all
            candidate layers violate the catalog metadata contract.
        fiona.errors.FionaError: If GDAL cannot list the geodatabase layers or
            all candidate layers fail GDAL inspection.
    """
    relative_path = geodatabase_path.relative_to(source_root)
    relative_path_text = relative_path.as_posix()
    layer_names = sorted(fiona.listlayers(
        geodatabase_path,
        enabled_drivers=[OPENFILEGDB_DRIVER],
    ))
    modified_at = _geodatabase_modified_at(geodatabase_path)
    items: list[dict[str, Any]] = []
    layer_errors: list[tuple[str, Exception]] = []
    for layer_name in layer_names:
        try:
            item = build_layer_stac_item(
                source_root,
                geodatabase_path,
                relative_path_text,
                layer_name,
                modified_at,
            )
        except (
            fiona.errors.FionaError,
            OSError,
            OverflowError,
            RasterioError,
            ValueError,
        ) as error:
            layer_errors.append((layer_name, error))
            LOGGER.warning(
                "Skipping File Geodatabase layer %r in %s: %s",
                layer_name,
                relative_path_text,
                error,
            )
            continue
        if item is not None:
            items.append(item)

    if items:
        return tuple(items)
    if layer_errors:
        error_details = "; ".join(
            f"{layer_name}: {error}"
            for layer_name, error in layer_errors
        )
        raise ValueError(
            "File Geodatabase has no catalogable spatial feature classes; "
            f"layer errors: {error_details}"
        ) from layer_errors[0][1]
    return ()


def build_layer_stac_item(
    source_root: Path,
    geodatabase_path: Path,
    relative_path_text: str,
    layer_name: str,
    modified_at: datetime,
) -> dict[str, Any] | None:
    """Build one STAC Item from a File Geodatabase spatial layer.

    Args:
        source_root: Root directory mounted for scanning.
        geodatabase_path: File Geodatabase directory below the mounted root.
        relative_path_text: Mount-relative POSIX path of the geodatabase.
        layer_name: Exact GDAL layer name to inspect and identify.
        modified_at: Latest modification time in the container directory tree.

    Returns:
        A complete STAC Item for a spatial layer, or ``None`` for a
        nonspatial table.

    Raises:
        ValueError: If GDAL selects a different driver or required spatial
            metadata is missing, non-finite, or unsupported.
        fiona.errors.FionaError: If GDAL cannot open or inspect the layer.
        rasterio.errors.RasterioError: If the layer CRS or bounds cannot be
            transformed to WGS 84.
    """
    with fiona.open(
        geodatabase_path,
        layer=layer_name,
        enabled_drivers=[OPENFILEGDB_DRIVER],
    ) as layer:
        if layer.driver != OPENFILEGDB_DRIVER:
            raise ValueError(
                f"File Geodatabase layer opened with {layer.driver!r} instead "
                f"of {OPENFILEGDB_DRIVER!r}"
            )

        declared_geometry_type = layer.schema.get("geometry")
        if declared_geometry_type in {None, "None"}:
            return None
        geometry_type = str(declared_geometry_type).removeprefix("3D ")
        if geometry_type not in GEOJSON_GEOMETRY_TYPES:
            raise ValueError(
                "File Geodatabase layer has unsupported geometry type: "
                f"{declared_geometry_type}"
            )
        if not layer.crs:
            raise ValueError(
                f"File Geodatabase layer {layer_name!r} has no coordinate "
                "reference system"
            )

        feature_count = len(layer)
        if not feature_count:
            raise ValueError(
                f"File Geodatabase layer {layer_name!r} has no features from "
                "which to derive a spatial footprint"
            )
        wkt2 = layer.crs.to_wkt(version="WKT2_2019")
        properties: dict[str, Any] = {
            "title": f"{relative_path_text}/{layer_name}",
            "description": FALLBACK_DATETIME_DESCRIPTION,
            "datetime": _format_datetime(modified_at),
            "eolab:layer_name": layer_name,
            **build_vector_table_properties(
                feature_count,
                geometry_type,
                (
                    (field_name, str(field_type))
                    for field_name, field_type in (
                        layer.schema.get("properties") or {}
                    ).items()
                ),
            ),
        }
        layer_alias = layer.get_tag_item("ALIAS_NAME")
        if layer_alias:
            properties["eolab:layer_alias"] = layer_alias
        if epsg_code := layer.crs.to_epsg():
            properties["proj:epsg"] = epsg_code
        else:
            properties["proj:wkt2"] = wkt2

        native_bbox = list(layer.bounds)
        bbox = list(
            transform_bounds(CRS.from_wkt(wkt2), "EPSG:4326", *native_bbox)
        )
        if not all(
            math.isfinite(coordinate) for coordinate in native_bbox + bbox
        ):
            raise ValueError(
                "File Geodatabase layer bounds could not be transformed to "
                "WGS 84"
            )
        if native_bbox[0] > native_bbox[2] or native_bbox[1] > native_bbox[3]:
            raise ValueError(
                "File Geodatabase layer has invalid native bounds"
            )
        if bbox[0] > bbox[2] or bbox[1] > bbox[3]:
            raise ValueError(
                "File Geodatabase layer has invalid WGS 84 bounds"
            )
        properties["proj:bbox"] = native_bbox

    west, south, east, north = bbox
    footprint = {
        "type": "Polygon",
        "coordinates": [[
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south],
        ]],
    }

    identity = f"{relative_path_text}\0{layer_name}"
    item_identifier = hashlib.sha256(identity.encode("utf-8")).hexdigest()
    item: dict[str, Any] = {
        "type": "Feature",
        "stac_version": "1.0.0",
        "stac_extensions": [PROJECTION_EXTENSION, TABLE_EXTENSION],
        "id": f"file-geodatabase-{item_identifier[:24]}",
        "collection": MOUNTED_VECTOR_COLLECTION_ID,
        "geometry": footprint,
        "properties": properties,
        "links": [],
        "assets": {
            "data": {
                "href": geodatabase_path.resolve().as_uri(),
                "type": FILE_GEODATABASE_MEDIA_TYPE,
                "title": geodatabase_path.relative_to(
                    source_root
                ).as_posix(),
                "roles": ["data"],
                "updated": _format_datetime(modified_at),
                "eolab:layer_name": layer_name,
            },
        },
    }
    item["bbox"] = bbox
    return item


def _geodatabase_modified_at(geodatabase_path: Path) -> datetime:
    """Return the latest filesystem modification time in a geodatabase tree.

    Args:
        geodatabase_path: File Geodatabase container directory.

    Returns:
        Latest modification time among the container and all descendants, in
        UTC.

    Raises:
        OSError: If the container tree cannot be listed or a path cannot be
            inspected.
    """
    modified_timestamp = geodatabase_path.stat().st_mtime
    for component_path in geodatabase_path.rglob("*"):
        modified_timestamp = max(
            modified_timestamp,
            component_path.stat().st_mtime,
        )
    return datetime.fromtimestamp(modified_timestamp, tz=timezone.utc)


def _format_datetime(value: datetime) -> str:
    """Format one timezone-aware datetime as canonical UTC text.

    Args:
        value: Datetime to format.

    Returns:
        ISO 8601 text using ``Z`` as the UTC designator.

    Raises:
        ValueError: If the datetime has no timezone information.
    """
    if value.tzinfo is None:
        raise ValueError("File Geodatabase datetime must be timezone-aware")
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
