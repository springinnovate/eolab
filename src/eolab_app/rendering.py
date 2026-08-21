"""Publish cataloged GeoTIFFs through the internal GeoServer."""

import asyncio
import math
from pathlib import Path
from typing import Any, Literal
from urllib.parse import unquote, urlsplit

import httpx2
import rasterio
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field
from rasterio.warp import transform
from rasterio.windows import Window

from eolab_app.geotiff import (
    GEOTIFF_MEDIA_TYPES,
    MOUNTED_GEOTIFF_COLLECTION_ID,
    MOUNTED_GEOTIFF_ITEM_ID_PATTERN,
    RENDERING_METADATA_KEY,
    RENDERING_POLICY,
    build_stac_item as build_geotiff_stac_item,
    inspect_geotiff_renderability,
)


GEOSERVER_WORKSPACE_NAME = "eolab"
GEOSERVER_RASTER_STYLE_NAME = "dynamic-raster"
RASTER_PIXEL_READ_CONCURRENCY = 2
SourceSignature = tuple[int, int, int, int, int]


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


class CatalogPixelRequest(CatalogRasterRequest):
    """Identify one published raster and a WGS 84 position to sample."""

    longitude: float = Field(
        strict=True,
        ge=-180,
        le=180,
        allow_inf_nan=False,
    )
    latitude: float = Field(
        strict=True,
        ge=-90,
        le=90,
        allow_inf_nan=False,
    )


class RasterPixel(BaseModel):
    """One band-1 pixel sampled from a published catalog raster."""

    longitude: float
    latitude: float
    row: int | None
    column: int | None
    in_bounds: bool = Field(alias="inBounds")
    value: float | None


def _source_signature(source_path: Path) -> SourceSignature:
    """Identify the mounted file inspected before GeoServer publication.

    Args:
        source_path: Mounted GeoTIFF to identify.

    Returns:
        Filesystem identity, size, and modification timestamps.

    Raises:
        OSError: If the source metadata cannot be read.
    """
    file_status = source_path.stat()
    return (
        file_status.st_dev,
        file_status.st_ino,
        file_status.st_size,
        file_status.st_mtime_ns,
        file_status.st_ctime_ns,
    )


class PublishedRasterRegistry:
    """Allow WMS access only to current files approved by this app process."""

    def __init__(self) -> None:
        self._sources: dict[str, tuple[Path, SourceSignature]] = {}

    def authorize(
        self,
        layer_name: str,
        source_path: Path,
        inspected_signature: SourceSignature,
    ) -> None:
        """Authorize a layer if its source is unchanged since inspection.

        Args:
            layer_name: Workspace-qualified GeoServer layer name.
            source_path: Mounted GeoTIFF backing the layer.
            inspected_signature: Source identity captured before publication.

        Raises:
            HTTPException: If the source changed or disappeared during
                publication.
        """
        try:
            current_signature = _source_signature(source_path)
        except OSError:
            current_signature = None
        if current_signature != inspected_signature:
            raise HTTPException(
                status_code=409,
                detail="The GeoTIFF changed while it was being published",
            )
        self._sources[layer_name] = (source_path, inspected_signature)

    def require_current(self, layer_name: str) -> Path:
        """Require a layer authorized from a source that has not changed.

        Args:
            layer_name: Workspace-qualified GeoServer layer name.

        Returns:
            Canonical path to the authorized mounted GeoTIFF.

        Raises:
            HTTPException: If the layer is not authorized or its source has
                changed since publication.
        """
        authorization = self._sources.get(layer_name)
        if authorization is None:
            raise HTTPException(
                status_code=400,
                detail="The WMS layer has not been approved for visualization",
            )
        source_path, approved_signature = authorization
        try:
            current_signature = _source_signature(source_path)
        except OSError:
            current_signature = None
        if current_signature != approved_signature:
            self._sources.pop(layer_name, None)
            raise HTTPException(
                status_code=409,
                detail="The visualized GeoTIFF changed; select it again",
            )
        return source_path


def _read_raster_pixel(
    source_path: Path,
    longitude: float,
    latitude: float,
) -> RasterPixel:
    """Read one band-1 pixel at a WGS 84 position.

    Args:
        source_path: Authorized mounted GeoTIFF.
        longitude: WGS 84 longitude.
        latitude: WGS 84 latitude.

    Returns:
        Sample value and source cell, or an out-of-bounds response.

    Raises:
        OSError: If the source cannot be read.
        rasterio.errors.RasterioError: If GDAL cannot open or sample it.
        ValueError: If its coordinate reference system cannot transform the
            requested position.
    """
    with rasterio.open(source_path) as dataset:
        x_coordinates, y_coordinates = transform(
            "EPSG:4326",
            dataset.crs,
            [longitude],
            [latitude],
        )
        if not all(
            math.isfinite(coordinate)
            for coordinate in (x_coordinates[0], y_coordinates[0])
        ):
            return RasterPixel(
                longitude=longitude,
                latitude=latitude,
                row=None,
                column=None,
                inBounds=False,
                value=None,
            )
        row, column = dataset.index(x_coordinates[0], y_coordinates[0])
        if not (0 <= row < dataset.height and 0 <= column < dataset.width):
            return RasterPixel(
                longitude=longitude,
                latitude=latitude,
                row=None,
                column=None,
                inBounds=False,
                value=None,
            )

        sample = dataset.read(
            1,
            window=Window(column, row, 1, 1),
            masked=True,
        )
        value = None if sample.count() == 0 else float(sample[0, 0])
        if value is not None and not math.isfinite(value):
            value = None
        return RasterPixel(
            longitude=longitude,
            latitude=latitude,
            row=row,
            column=column,
            inBounds=True,
            value=value,
        )


def _read_current_raster_pixel(
    request: CatalogPixelRequest,
    raster_registry: PublishedRasterRegistry,
) -> RasterPixel:
    """Resolve and sample an approved raster in one worker-thread job.

    Args:
        request: Validated Item identity and WGS 84 position.
        raster_registry: Current-process publication authorizations.

    Returns:
        The sampled band-1 value and source cell.

    Raises:
        HTTPException: If the layer is unapproved or its source changed.
        OSError: If the source cannot be read.
        rasterio.errors.RasterioError: If GDAL cannot sample the source.
        ValueError: If its coordinate reference system cannot transform the
            requested position.
    """
    layer_name = f"{GEOSERVER_WORKSPACE_NAME}:{request.item_id}"
    source_path = raster_registry.require_current(layer_name)
    return _read_raster_pixel(
        source_path,
        request.longitude,
        request.latitude,
    )


async def sample_catalog_raster_pixel(
    request: CatalogPixelRequest,
    raster_registry: PublishedRasterRegistry,
    read_semaphore: asyncio.Semaphore,
) -> RasterPixel:
    """Sample one pixel without exceeding the app's raster-read capacity.

    Args:
        request: Validated Item identity and WGS 84 position.
        raster_registry: Current-process publication authorizations.
        read_semaphore: Limit for concurrent Rasterio reads.

    Returns:
        The sampled band-1 value and source cell.

    Raises:
        HTTPException: If the source is unapproved, changed, or unreadable.
    """
    await read_semaphore.acquire()
    read_task = asyncio.create_task(
        asyncio.to_thread(
            _read_current_raster_pixel,
            request,
            raster_registry,
        )
    )

    # HTTP cancellation cannot stop a GDAL thread. Keep its slot occupied until
    # the actual read ends, and retrieve any exception from a detached task.
    def release_read_slot(completed_task: asyncio.Task[RasterPixel]) -> None:
        read_semaphore.release()
        if not completed_task.cancelled():
            completed_task.exception()

    read_task.add_done_callback(release_read_slot)
    try:
        return await asyncio.shield(read_task)
    except (OSError, ValueError, rasterio.errors.RasterioError) as error:
        raise HTTPException(
            status_code=409,
            detail="The selected raster could not be sampled",
        ) from error


def _mounted_geotiff_path(item: dict[str, Any], scan_mount_path: Path) -> Path:
    """Resolve the scanner-owned data Asset to a readable mounted GeoTIFF.

    Args:
        item: Authoritative STAC Item from the catalog.
        scan_mount_path: Read-only root shared by the scanner and GeoServer.

    Returns:
        Canonical path to the mounted GeoTIFF.

    Raises:
        HTTPException: If the data Asset is missing, unavailable, not a
            GeoTIFF, or outside the scan mount.
    """
    assets = item.get("assets")
    data_asset = assets.get("data") if isinstance(assets, dict) else None
    if not isinstance(data_asset, dict) or (
        data_asset.get("type") not in GEOTIFF_MEDIA_TYPES
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


async def _load_catalog_item(
    request: CatalogRasterRequest,
    catalog_client: httpx2.AsyncClient,
    catalog_internal_url: str,
) -> dict[str, Any]:
    """Load the authoritative scanner-owned STAC Item.

    Args:
        request: Validated Collection and Item identity.
        catalog_client: Shared client for the internal STAC API.
        catalog_internal_url: Internal STAC API base URL.

    Returns:
        STAC Item matching the requested identity.

    Raises:
        HTTPException: If the catalog is unavailable, the Item is missing, or
            the response violates the requested identity.
    """
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
    return item


async def update_catalog_raster_assessment(
    request: CatalogRasterRequest,
    scan_mount_path: Path,
    catalog_client: httpx2.AsyncClient,
    catalog_internal_url: str,
) -> dict[str, Any]:
    """Update one Item with the current raster visualization assessment.

    Existing assessments under the current policy are returned unchanged.
    Otherwise, the function rebuilds the Item from its mounted GeoTIFF and
    upserts that one Item without scanning sibling datasets.

    Args:
        request: Validated Collection and Item identity.
        scan_mount_path: Read-only root containing the cataloged GeoTIFF.
        catalog_client: Shared client for the internal STAC API.
        catalog_internal_url: Internal STAC API base URL.

    Returns:
        The existing or newly assessed STAC Item.

    Raises:
        HTTPException: If the Item cannot be loaded, its GeoTIFF cannot be
            assessed, the mounted file no longer matches the Item, or the
            updated Item cannot be saved.
    """
    item = await _load_catalog_item(
        request,
        catalog_client,
        catalog_internal_url,
    )
    source_path = _mounted_geotiff_path(item, scan_mount_path)
    existing_assessment = item["assets"]["data"].get(RENDERING_METADATA_KEY)
    if (
        existing_assessment is not None
        and existing_assessment.get("policy") == RENDERING_POLICY
    ):
        return item

    try:
        updated_item = await asyncio.to_thread(
            build_geotiff_stac_item,
            scan_mount_path,
            source_path,
        )
    except ValueError as error:
        raise HTTPException(
            status_code=409,
            detail=f"Visualization unavailable: {error}",
        ) from error
    except (OSError, rasterio.errors.RasterioError) as error:
        raise HTTPException(
            status_code=409,
            detail=(
                "Visualization unavailable: the raster metadata could not "
                "be read."
            ),
        ) from error

    if updated_item["id"] != request.item_id:
        raise HTTPException(
            status_code=409,
            detail="The mounted GeoTIFF no longer matches the catalog Item",
        )
    try:
        update_response = await catalog_client.post(
            f"{catalog_internal_url.rstrip('/')}/collections/"
            f"{request.collection_id}/bulk_items",
            json={
                "method": "upsert",
                "items": {request.item_id: updated_item},
            },
        )
    except httpx2.RequestError as error:
        raise HTTPException(
            status_code=502,
            detail="The STAC catalog service is unavailable",
        ) from error
    if not update_response.is_success:
        raise HTTPException(
            status_code=502,
            detail="The STAC catalog could not save the raster assessment",
        )
    return updated_item


async def publish_catalog_raster(
    request: CatalogRasterRequest,
    scan_mount_path: Path,
    catalog_client: httpx2.AsyncClient,
    geoserver_client: httpx2.AsyncClient,
    catalog_internal_url: str,
    geoserver_internal_url: str,
    raster_registry: PublishedRasterRegistry,
) -> PublishedRaster:
    """Resolve and idempotently publish one approved catalog GeoTIFF.

    Args:
        request: Validated Collection and Item identity.
        scan_mount_path: Read-only root shared with GeoServer.
        catalog_client: Shared client for the internal STAC API.
        geoserver_client: Authenticated client for GeoServer REST requests.
        catalog_internal_url: Internal STAC API base URL.
        geoserver_internal_url: Internal GeoServer base URL.
        raster_registry: Registry authorizing public WMS access to current
            source files.

    Returns:
        Browser-safe WMS layer identity and WGS 84 bounding box.

    Raises:
        HTTPException: If the Item or source is unavailable or ineligible, the
            current source no longer passes assessment, or GeoServer cannot
            publish and style the layer.
    """
    item = await _load_catalog_item(
        request,
        catalog_client,
        catalog_internal_url,
    )
    source_path = _mounted_geotiff_path(item, scan_mount_path)
    rendering_metadata = item["assets"]["data"].get(RENDERING_METADATA_KEY)
    if (
        rendering_metadata is None
        or rendering_metadata.get("policy") != RENDERING_POLICY
    ):
        raise HTTPException(
            status_code=409,
            detail="Visualization unavailable: assess this raster first.",
        )
    if not rendering_metadata["eligible"]:
        raise HTTPException(
            status_code=409,
            detail=rendering_metadata["reason"],
        )

    try:
        inspected_source_signature = await asyncio.to_thread(
            _source_signature,
            source_path,
        )
        current_rendering_metadata = await asyncio.to_thread(
            inspect_geotiff_renderability,
            source_path,
        )
    except (OSError, rasterio.errors.RasterioError) as error:
        raise HTTPException(
            status_code=409,
            detail=(
                "Visualization unavailable: the raster metadata can no "
                "longer be read."
            ),
        ) from error
    if not current_rendering_metadata["eligible"]:
        raise HTTPException(
            status_code=409,
            detail=current_rendering_metadata["reason"],
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

    layer_name = f"{GEOSERVER_WORKSPACE_NAME}:{resource_name}"
    await asyncio.to_thread(
        raster_registry.authorize,
        layer_name,
        source_path,
        inspected_source_signature,
    )
    return PublishedRaster(
        layerName=layer_name,
        bbox=tuple(item["bbox"]),
    )
