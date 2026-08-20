"""Publish cataloged GeoTIFFs through the internal GeoServer."""

import math
from pathlib import Path
from typing import Any, Literal
from urllib.parse import unquote, urlsplit

import httpx2
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from eolab_app.geotiff import (
    GEOTIFF_MEDIA_TYPE,
    MOUNTED_GEOTIFF_COLLECTION_ID,
    MOUNTED_GEOTIFF_ITEM_ID_PATTERN,
)


GEOSERVER_WORKSPACE_NAME = "eolab"
GEOSERVER_RASTER_STYLE_NAME = "dynamic-raster"


class CatalogRasterRequest(BaseModel):
    """Identify one catalog Item without accepting browser-supplied paths."""

    model_config = ConfigDict(extra="forbid")

    collection_id: Literal[MOUNTED_GEOTIFF_COLLECTION_ID] = Field(
        alias="collectionId",
    )
    item_id: str = Field(
        alias="itemId",
        pattern=MOUNTED_GEOTIFF_ITEM_ID_PATTERN,
        strict=True,
    )


class PublishedRaster(BaseModel):
    """Browser-safe identity of one published WMS layer."""

    layer_name: str = Field(alias="layerName")
    bbox: tuple[float, float, float, float]


def _mounted_geotiff_path(item: dict[str, Any], scan_mount_path: Path) -> Path:
    """Resolve the scanner-owned data Asset to a readable mounted GeoTIFF."""
    assets = item.get("assets")
    data_asset = assets.get("data") if isinstance(assets, dict) else None
    if not isinstance(data_asset, dict) or (
        data_asset.get("type") != GEOTIFF_MEDIA_TYPE
        or data_asset.get("roles") != ["data"]
        or not isinstance(data_asset.get("href"), str)
    ):
        raise HTTPException(
            status_code=422,
            detail="The Item has no renderable GeoTIFF data Asset",
        )

    asset_href = data_asset["href"]
    asset_uri = urlsplit(asset_href)
    mount_uri = urlsplit(scan_mount_path.resolve().as_uri())
    mount_uri_path = unquote(mount_uri.path).rstrip("/")
    asset_uri_path = unquote(asset_uri.path)
    if (
        asset_uri.scheme != "file"
        or asset_uri.netloc != mount_uri.netloc
        or asset_uri.query
        or asset_uri.fragment
        or not asset_uri_path.startswith(f"{mount_uri_path}/")
    ):
        raise HTTPException(
            status_code=422,
            detail="The GeoTIFF Asset is outside the mounted scan source",
        )

    relative_path = Path(asset_uri_path[len(mount_uri_path) + 1 :])
    try:
        source_path = (scan_mount_path / relative_path).resolve(strict=True)
    except OSError as error:
        raise HTTPException(
            status_code=409,
            detail="The cataloged GeoTIFF is no longer available",
        ) from error
    resolved_mount_path = scan_mount_path.resolve()
    if (
        not source_path.is_relative_to(resolved_mount_path)
        or not source_path.is_file()
        or source_path.suffix.lower() not in {".tif", ".tiff"}
    ):
        raise HTTPException(
            status_code=422,
            detail="The GeoTIFF Asset is outside the mounted scan source",
        )
    return source_path


async def publish_catalog_raster(
    request: CatalogRasterRequest,
    scan_mount_path: Path,
    catalog_client: httpx2.AsyncClient,
    geoserver_client: httpx2.AsyncClient,
    catalog_internal_url: str,
    geoserver_internal_url: str,
) -> PublishedRaster:
    """Resolve a STAC Item and idempotently publish its GeoTIFF in GeoServer."""
    catalog_item_url = (
        f"{catalog_internal_url.rstrip('/')}/collections/"
        f"{request.collection_id}/items/{request.item_id}"
    )
    try:
        item_response = await catalog_client.get(
            catalog_item_url,
            headers={"Accept": "application/geo+json"},
        )
    except httpx2.RequestError as error:
        raise HTTPException(
            status_code=502,
            detail="The STAC catalog service is unavailable",
        ) from error
    if item_response.status_code == 404:
        raise HTTPException(status_code=404, detail="Catalog Item not found")
    if item_response.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail="The STAC catalog returned an unexpected response",
        )

    try:
        item = item_response.json()
    except ValueError as error:
        raise HTTPException(
            status_code=502,
            detail="The STAC catalog returned an invalid Item",
        ) from error
    if (
        not isinstance(item, dict)
        or item.get("id") != request.item_id
        or item.get("collection") != request.collection_id
    ):
        raise HTTPException(
            status_code=502,
            detail="The STAC catalog returned an invalid Item",
        )
    source_path = _mounted_geotiff_path(item, scan_mount_path)
    bbox = item.get("bbox")
    if (
        not isinstance(bbox, list)
        or len(bbox) != 4
        or any(
            isinstance(coordinate, bool)
            or not isinstance(coordinate, (int, float))
            or not math.isfinite(coordinate)
            for coordinate in bbox
        )
        or not (-180 <= bbox[0] < bbox[2] <= 180)
        or not (-90 <= bbox[1] < bbox[3] <= 90)
    ):
        raise HTTPException(
            status_code=502,
            detail="The STAC catalog returned an invalid Item bounding box",
        )

    resource_name = request.item_id
    geoserver_rest_url = f"{geoserver_internal_url.rstrip('/')}/rest"
    try:
        store_response = await geoserver_client.put(
            f"{geoserver_rest_url}/workspaces/{GEOSERVER_WORKSPACE_NAME}"
            f"/coveragestores/{resource_name}/external.geotiff",
            params={"configure": "first", "coverageName": resource_name},
            content=source_path.as_uri(),
            headers={
                "Accept": "application/json",
                "Content-Type": "text/plain",
            },
        )
        if store_response.status_code != 201:
            raise HTTPException(
                status_code=502,
                detail="GeoServer could not publish the selected GeoTIFF",
            )
        layer_url = (
            f"{geoserver_rest_url}/workspaces/{GEOSERVER_WORKSPACE_NAME}"
            f"/layers/{resource_name}"
        )
        style_response = await geoserver_client.put(
            f"{layer_url}.xml",
            content=(
                "<layer><defaultStyle>"
                f"<name>{GEOSERVER_RASTER_STYLE_NAME}</name>"
                f"<workspace>{GEOSERVER_WORKSPACE_NAME}</workspace>"
                "</defaultStyle></layer>"
            ),
            headers={"Content-Type": "application/xml"},
        )
    except httpx2.RequestError as error:
        raise HTTPException(
            status_code=502,
            detail="The rendering service is unavailable",
        ) from error
    if style_response.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail="GeoServer could not style the selected GeoTIFF",
        )

    return PublishedRaster(
        layerName=f"{GEOSERVER_WORKSPACE_NAME}:{resource_name}",
        bbox=tuple(bbox),
    )
