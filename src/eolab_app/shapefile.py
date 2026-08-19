"""Extract STAC metadata from ESRI Shapefile datasets."""

import hashlib
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import fiona
from rasterio.crs import CRS
from rasterio.warp import transform_bounds


PROJECTION_EXTENSION = (
    "https://stac-extensions.github.io/projection/v1.1.0/schema.json"
)
TABLE_EXTENSION = "https://stac-extensions.github.io/table/v1.2.0/schema.json"
SHAPEFILE_COMPONENT_TYPES = {
    ".shp": "application/vnd.shp",
    ".shx": "application/vnd.shx",
    ".dbf": "application/vnd.dbf",
    ".prj": "text/plain",
    ".cpg": "text/plain",
    ".qix": "application/octet-stream",
    ".sbn": "application/octet-stream",
    ".sbx": "application/octet-stream",
    ".shp.xml": "application/xml",
}
REQUIRED_COMPONENT_EXTENSIONS = {".shp", ".shx", ".dbf", ".prj"}
COMPONENT_EXTENSION_ORDER = tuple(SHAPEFILE_COMPONENT_TYPES)
FALLBACK_DATETIME_DESCRIPTION = (
    "Shapefile has no standardized observation or acquisition timestamp used "
    "by EOLab. The Item datetime uses the latest filesystem modification time "
    "among the files that form the Shapefile dataset."
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


def discover_shapefile_datasets(
    directory_path: Path,
    file_names: list[str],
) -> list[tuple[Path, tuple[Path, ...]]]:
    """Group Shapefile components already listed during a directory walk.

    Args:
        directory_path: Directory containing the listed files.
        file_names: File names returned by the active directory walk.

    Returns:
        One primary `.shp` path and its recognized components per exact base
        name. Extension matching is case-insensitive.
    """
    components_by_stem: dict[str, list[Path]] = {}
    for file_name in file_names:
        component_extension = _component_extension(file_name)
        if component_extension is None:
            continue
        component_stem = file_name[: -len(component_extension)]
        components_by_stem.setdefault(component_stem, []).append(
            directory_path / file_name
        )

    datasets: list[tuple[Path, tuple[Path, ...]]] = []
    for component_paths in components_by_stem.values():
        shapefile_paths = [
            component_path
            for component_path in component_paths
            if _component_extension(component_path.name) == ".shp"
        ]
        if shapefile_paths:
            datasets.append(
                (
                    min(shapefile_paths, key=lambda path: path.name),
                    tuple(sorted(component_paths, key=lambda path: path.name)),
                )
            )
    return datasets


def build_stac_item(
    source_root: Path,
    shapefile_path: Path,
    component_paths: tuple[Path, ...],
) -> dict[str, Any]:
    """Build one STAC Item from a Shapefile and its companion files.

    Args:
        source_root: Root directory mounted for scanning.
        shapefile_path: Primary `.shp` file below the mounted root.
        component_paths: Recognized same-directory files with the same exact
            base name.

    Returns:
        A STAC Item with table, projection, and multipart Asset metadata.

    Raises:
        ValueError: If required components, CRS, bounds, or the declared
            geometry type violate the Shapefile catalog contract.
        fiona.errors.FionaError: If GDAL cannot open or inspect the dataset.
    """
    relative_path = shapefile_path.relative_to(source_root)
    relative_path_text = relative_path.as_posix()
    components: dict[str, Path] = {}
    for component_path in component_paths:
        component_extension = _component_extension(component_path.name)
        if component_extension in components:
            raise ValueError(
                "Shapefile has duplicate components for "
                f"{component_extension}: {components[component_extension].name}, "
                f"{component_path.name}"
            )
        components[component_extension] = component_path

    missing_extensions = REQUIRED_COMPONENT_EXTENSIONS - components.keys()
    if missing_extensions:
        missing_list = ", ".join(sorted(missing_extensions))
        raise ValueError(f"Shapefile is missing required components: {missing_list}")

    with fiona.open(
        components[".dbf"],
        enabled_drivers=["ESRI Shapefile"],
    ) as attribute_table:
        attribute_fields = attribute_table.schema["properties"]

    with fiona.open(
        shapefile_path,
        enabled_drivers=["ESRI Shapefile"],
    ) as dataset:
        if not dataset.crs:
            raise ValueError("Shapefile has no coordinate reference system")

        feature_count = len(dataset)
        wkt2 = dataset.crs.to_wkt(version="WKT2_2019")
        geometry_type = dataset.schema["geometry"].removeprefix("3D ")
        if geometry_type not in GEOJSON_GEOMETRY_TYPES:
            raise ValueError(
                f"Shapefile has unsupported geometry type: {geometry_type}"
            )

        properties: dict[str, Any] = {
            "title": relative_path_text,
            "description": FALLBACK_DATETIME_DESCRIPTION,
            "table:row_count": feature_count,
            "table:columns": [
                {"name": "geometry", "type": geometry_type},
                *(
                    {"name": field_name, "type": str(field_type)}
                    for field_name, field_type in attribute_fields.items()
                ),
            ],
            "table:primary_geometry": "geometry",
        }
        if epsg_code := dataset.crs.to_epsg():
            properties["proj:epsg"] = epsg_code
        else:
            properties["proj:wkt2"] = wkt2

        bbox = None
        if feature_count:
            native_bbox = list(dataset.bounds)
            bbox = list(
                transform_bounds(CRS.from_wkt(wkt2), "EPSG:4326", *native_bbox)
            )
            if not all(
                math.isfinite(coordinate) for coordinate in native_bbox + bbox
            ):
                raise ValueError(
                    "Shapefile bounds could not be transformed to WGS 84"
                )
            properties["proj:bbox"] = native_bbox

    component_modified_at = {
        extension: datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
        for extension, path in components.items()
    }
    properties["datetime"] = _format_datetime(max(component_modified_at.values()))

    footprint = None
    if bbox is not None:
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
    assets = {}
    for extension in COMPONENT_EXTENSION_ORDER:
        if component_path := components.get(extension):
            asset_key = extension.removeprefix(".").replace(".", "_")
            asset_roles = (
                ["data"]
                if extension in {".shp", ".shx", ".dbf"}
                else ["metadata"]
            )
            assets[asset_key] = {
                "href": component_path.resolve().as_uri(),
                "type": SHAPEFILE_COMPONENT_TYPES[extension],
                "title": component_path.relative_to(source_root).as_posix(),
                "roles": asset_roles,
                "updated": _format_datetime(component_modified_at[extension]),
            }

    item_identifier = hashlib.sha256(relative_path_text.encode("utf-8")).hexdigest()
    item = {
        "type": "Feature",
        "stac_version": "1.0.0",
        "stac_extensions": [
            PROJECTION_EXTENSION,
            TABLE_EXTENSION,
        ],
        "id": f"shapefile-{item_identifier[:24]}",
        "collection": "eolab-mounted-vectors",
        "geometry": footprint,
        "properties": properties,
        "links": [],
        "assets": assets,
    }
    if bbox is not None:
        item["bbox"] = bbox
    return item


def _component_extension(file_name: str) -> str | None:
    """Return a recognized Shapefile component extension."""
    lower_file_name = file_name.lower()
    for extension in SHAPEFILE_COMPONENT_TYPES:
        if lower_file_name.endswith(extension):
            return extension
    return None


def _format_datetime(value: datetime) -> str:
    """Format a UTC timestamp for STAC."""
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
