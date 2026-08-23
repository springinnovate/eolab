"""Build STAC metadata for remotely stored Shapefile object groups."""

import math
from typing import Any

import fiona
from rasterio.crs import CRS
from rasterio.warp import transform_bounds

from eolab_app.catalog.geotiff import _format_datetime
from eolab_app.catalog.remote import (
    RemoteDatasetCandidate,
    RemoteObject,
    RemoteObjectAccess,
)
from eolab_app.catalog.remote_geotiff import _remote_asset, _remote_identity
from eolab_app.catalog.shapefile import (
    COMPONENT_EXTENSION_ORDER,
    GEOJSON_GEOMETRY_TYPES,
    PROJECTION_EXTENSION,
    REQUIRED_COMPONENT_EXTENSIONS,
    SHAPEFILE_COMPONENT_TYPES,
)
from eolab_app.catalog.vector import (
    MOUNTED_VECTOR_COLLECTION_ID,
    TABLE_EXTENSION,
    build_bbox_polygon,
    build_vector_table_properties,
)


REMOTE_SHAPEFILE_DATETIME_DESCRIPTION = (
    "Shapefile has no standardized observation or acquisition timestamp used "
    "by EOLab. The Item datetime uses the latest object-store last-modified "
    "time among the files that form the remote dataset."
)
MAXIMUM_REMOTE_SHAPEFILE_COMPONENT_BYTES = 128 * 1024 * 1024
MAXIMUM_REMOTE_SHAPEFILE_TOTAL_BYTES = 256 * 1024 * 1024


def build_remote_shapefile_item(
    candidate: RemoteDatasetCandidate,
    access: RemoteObjectAccess,
) -> dict[str, Any]:
    """Build one STAC Item from exact remote Shapefile components.

    Args:
        candidate: Primary `.shp` object and deterministically grouped sidecars.
        access: Provider adapter for GDAL paths and unsigned Asset locations.

    Returns:
        Vector Item with the mounted Shapefile's core projection and table
        metadata while retaining one Asset per remote object.

    Raises:
        ValueError: If required components, CRS, bounds, or geometry metadata
            violate the Shapefile contract.
        fiona.errors.FionaError: If GDAL cannot inspect the remote dataset.
    """
    components: dict[str, RemoteObject] = {}
    for component in candidate.components:
        extension = _component_extension(component.key)
        if extension in components:
            raise ValueError(
                "Shapefile has duplicate components for "
                f"{extension}: {components[extension].key}, {component.key}"
            )
        if extension is not None:
            components[extension] = component
    missing_extensions = REQUIRED_COMPONENT_EXTENSIONS - components.keys()
    if missing_extensions:
        missing_list = ", ".join(sorted(missing_extensions))
        raise ValueError(f"Shapefile is missing required components: {missing_list}")

    metadata_components = tuple(
        component
        for extension, component in components.items()
        if extension in REQUIRED_COMPONENT_EXTENSIONS | {".cpg"}
    )
    with access.materialize_components(
        metadata_components,
        maximum_component_bytes=MAXIMUM_REMOTE_SHAPEFILE_COMPONENT_BYTES,
        maximum_total_bytes=MAXIMUM_REMOTE_SHAPEFILE_TOTAL_BYTES,
    ) as local_paths:
        with fiona.open(
            local_paths[components[".dbf"]],
            enabled_drivers=["ESRI Shapefile"],
        ) as attribute_table:
            attribute_fields = attribute_table.schema["properties"]

        with fiona.open(
            local_paths[candidate.primary],
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
                "title": candidate.primary.display_name(),
                "description": REMOTE_SHAPEFILE_DATETIME_DESCRIPTION,
                "eolab:source_kind": "remote-object-storage",
                "eolab:source_provider": "s3",
                "eolab:source_id": candidate.primary.root.source_id,
                **build_vector_table_properties(
                    feature_count,
                    geometry_type,
                    (
                        (field_name, str(field_type))
                        for field_name, field_type in attribute_fields.items()
                    ),
                ),
            }
            if epsg_code := dataset.crs.to_epsg():
                properties["proj:epsg"] = epsg_code
            else:
                properties["proj:wkt2"] = wkt2

            bbox = None
            if feature_count:
                native_bbox = list(dataset.bounds)
                bbox = list(transform_bounds(
                    CRS.from_wkt(wkt2),
                    "EPSG:4326",
                    *native_bbox,
                ))
                if not all(
                    math.isfinite(coordinate)
                    for coordinate in native_bbox + bbox
                ):
                    raise ValueError(
                        "Shapefile bounds could not be transformed to WGS 84"
                    )
                properties["proj:bbox"] = native_bbox

    properties["datetime"] = _format_datetime(max(
        component.last_modified for component in components.values()
    ))
    footprint = build_bbox_polygon(bbox) if bbox is not None else None
    assets = {}
    for extension in COMPONENT_EXTENSION_ORDER:
        component = components.get(extension)
        if component is None:
            continue
        asset_key = extension.removeprefix(".").replace(".", "_")
        roles = [
            "data" if extension in {".shp", ".shx", ".dbf"} else "metadata"
        ]
        assets[asset_key] = _remote_asset(
            component,
            access,
            SHAPEFILE_COMPONENT_TYPES[extension],
            roles,
        )

    item = {
        "type": "Feature",
        "stac_version": "1.0.0",
        "stac_extensions": [PROJECTION_EXTENSION, TABLE_EXTENSION],
        "id": f"shapefile-{_remote_identity(candidate.primary)[:24]}",
        "collection": MOUNTED_VECTOR_COLLECTION_ID,
        "geometry": footprint,
        "properties": properties,
        "links": [],
        "assets": assets,
    }
    if bbox is not None:
        item["bbox"] = bbox
    return item


def _component_extension(key: str) -> str | None:
    """Return the recognized canonical component extension.

    Args:
        key: Exact remote object key.

    Returns:
        Lower-case recognized extension or ``None``.
    """
    lower_key = key.lower()
    for extension in SHAPEFILE_COMPONENT_TYPES:
        if lower_key.endswith(extension):
            return extension
    return None
