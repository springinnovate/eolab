"""Build STAC metadata for remotely stored GeoTIFF objects."""

import hashlib
from typing import Any

import rasterio

from eolab_app.catalog.geotiff import (
    ACQUISITION_DATETIME_DESCRIPTION,
    FILE_EXTENSION,
    PROJECTION_EXTENSION,
    RASTER_EXTENSION,
    STAC_RASTER_DATA_TYPES,
    SUGGESTED_WARP_BOUNDS_DESCRIPTION,
    _derive_wgs84_bbox,
    _format_datetime,
    _parse_acquisition_datetime,
    _serialize_nodata,
)
from eolab_app.catalog.remote import (
    RemoteDatasetCandidate,
    RemoteObject,
    RemoteObjectAccess,
)
from eolab_app.raster.eligibility import (
    COG_MEDIA_TYPE,
    GEOTIFF_MEDIA_TYPE,
    MOUNTED_GEOTIFF_COLLECTION_ID,
)


REMOTE_FALLBACK_DATETIME_DESCRIPTION = (
    "No observation or acquisition time was found in the GeoTIFF metadata. "
    "The Item datetime uses the object store's last-modified time captured "
    "during the scan."
)


def build_remote_geotiff_item(
    candidate: RemoteDatasetCandidate,
    access: RemoteObjectAccess,
) -> dict[str, Any]:
    """Build one STAC Item through a provider virtual filesystem.

    Args:
        candidate: Single-object remote GeoTIFF candidate.
        access: Provider adapter for the internal GDAL path and public Asset.

    Returns:
        GeoTIFF Item with the mounted scanner's core raster and projection
        metadata plus explicit remote-source identity.

    Raises:
        ValueError: If candidate cardinality or raster spatial metadata is
            invalid, or an acquisition time is malformed.
        rasterio.errors.RasterioError: If GDAL cannot inspect the object.
    """
    if candidate.components:
        raise ValueError("Remote GeoTIFF candidate cannot have components")
    remote_object = candidate.primary
    with access.rasterio_environment(), rasterio.open(
        access.gdal_path(remote_object)
    ) as dataset:
        if dataset.crs is None:
            raise ValueError("GeoTIFF has no coordinate reference system")
        if dataset.width < 1 or dataset.height < 1:
            raise ValueError("GeoTIFF has invalid raster dimensions")

        bbox, used_suggested_warp_bounds = _derive_wgs84_bbox(dataset)
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
        acquisition_datetime = dataset.tags(ns="IMAGERY").get(
            "ACQUISITIONDATETIME"
        )
        if acquisition_datetime is None:
            item_datetime = remote_object.last_modified
            description = REMOTE_FALLBACK_DATETIME_DESCRIPTION
        else:
            item_datetime = _parse_acquisition_datetime(acquisition_datetime)
            description = ACQUISITION_DATETIME_DESCRIPTION
        if used_suggested_warp_bounds:
            description = f"{description} {SUGGESTED_WARP_BOUNDS_DESCRIPTION}"

        properties: dict[str, Any] = {
            "datetime": _format_datetime(item_datetime),
            "title": remote_object.display_name(),
            "description": description,
            "proj:shape": [dataset.height, dataset.width],
            "proj:transform": list(dataset.transform)[:6],
            "eolab:source_kind": "remote-object-storage",
            "eolab:source_provider": "s3",
            "eolab:source_id": remote_object.root.source_id,
        }
        if epsg_code := dataset.crs.to_epsg():
            properties["proj:epsg"] = epsg_code
        else:
            properties["proj:wkt2"] = dataset.crs.to_wkt()

        raster_bands = []
        for data_type, nodata_value in zip(
            dataset.dtypes,
            dataset.nodatavals,
            strict=True,
        ):
            band: dict[str, Any] = {
                "data_type": STAC_RASTER_DATA_TYPES.get(data_type, data_type)
            }
            if nodata_value is not None:
                band["nodata"] = _serialize_nodata(nodata_value)
            raster_bands.append(band)
        media_type = (
            COG_MEDIA_TYPE
            if dataset.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") == "COG"
            else GEOTIFF_MEDIA_TYPE
        )

    identity = _remote_identity(remote_object)
    return {
        "type": "Feature",
        "stac_version": "1.0.0",
        "stac_extensions": [
            PROJECTION_EXTENSION,
            RASTER_EXTENSION,
            FILE_EXTENSION,
        ],
        "id": f"geotiff-{identity[:24]}",
        "collection": MOUNTED_GEOTIFF_COLLECTION_ID,
        "geometry": footprint,
        "bbox": bbox,
        "properties": properties,
        "links": [],
        "assets": {
            "data": _remote_asset(
                remote_object,
                access,
                media_type,
                ["data"],
                extra={
                    "file:size": remote_object.size,
                    "raster:bands": raster_bands,
                },
            )
        },
    }


def _remote_asset(
    remote_object: RemoteObject,
    access: RemoteObjectAccess,
    media_type: str,
    roles: list[str],
    *,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build shared remote Asset identity and object-version metadata.

    Args:
        remote_object: Listing snapshot represented by the Asset.
        access: Provider adapter that emits an unsigned location.
        media_type: STAC Asset media type.
        roles: STAC Asset roles.
        extra: Optional format-specific Asset members.

    Returns:
        Credential-free Asset mapping with explicit source-kind metadata.
    """
    asset: dict[str, Any] = {
        "href": access.asset_href(remote_object),
        "type": media_type,
        "title": remote_object.display_name(),
        "roles": roles,
        "updated": _format_datetime(remote_object.last_modified),
        "eolab:source_kind": "remote-object-storage",
        "eolab:source_provider": "s3",
        "eolab:source_id": remote_object.root.source_id,
    }
    if remote_object.etag is not None:
        asset["eolab:object_etag"] = remote_object.etag
    if remote_object.version_id is not None:
        asset["eolab:object_version"] = remote_object.version_id
    if extra is not None:
        asset.update(extra)
    return asset


def _remote_identity(remote_object: RemoteObject) -> str:
    """Hash the deployment-stable current-object identity.

    Args:
        remote_object: Primary object whose source namespace, bucket, and key
            identify the logical dataset independently of mount or endpoint.

    Returns:
        Full hexadecimal SHA-256 digest.
    """
    identity_text = "\0".join((
        remote_object.root.source_id,
        remote_object.root.bucket,
        remote_object.key,
    ))
    return hashlib.sha256(identity_text.encode("utf-8")).hexdigest()
