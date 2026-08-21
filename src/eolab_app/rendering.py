"""Publish cataloged GeoTIFFs through the internal GeoServer."""

import asyncio
import math
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, cast
from urllib.parse import unquote, urlsplit

import httpx2
import numpy
import rasterio
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, FiniteFloat
from rasterio.enums import Resampling
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
RASTER_STATISTICS_ALGORITHM = "bounded-whole-raster-v1"
RASTER_STATISTICS_BIN_COUNT = 64
RASTER_STATISTICS_CACHE_ENTRIES = 32
RASTER_STATISTICS_MAX_SAMPLE_DIMENSION = 512
RASTER_STATISTICS_READ_CONCURRENCY = 1
SourceSignature = tuple[int, int, int, int, int]
RasterStatisticsCacheKey = tuple[str, SourceSignature, str]


@dataclass(frozen=True)
class AuthorizedRaster:
    """Current mounted source approved for public rendering operations."""

    source_path: Path
    source_signature: SourceSignature


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


class RasterPercentiles(BaseModel):
    """Percentiles calculated from finite, non-nodata sample values."""

    p05: FiniteFloat
    p50: FiniteFloat
    p95: FiniteFloat


class RasterValueRange(BaseModel):
    """Three strictly ordered values accepted by the dynamic raster style."""

    minimum: FiniteFloat
    midpoint: FiniteFloat
    maximum: FiniteFloat


class RasterHistogram(BaseModel):
    """Fixed-bin histogram calculated from the bounded raster sample."""

    counts: list[int]
    edges: list[FiniteFloat]


class RasterStatistics(BaseModel):
    """Bounded whole-raster sample used for display-range selection."""

    band: Literal[1] = 1
    source_width: int = Field(alias="sourceWidth")
    source_height: int = Field(alias="sourceHeight")
    source_pixel_count: int = Field(alias="sourcePixelCount")
    sample_width: int = Field(alias="sampleWidth")
    sample_height: int = Field(alias="sampleHeight")
    sampled_pixel_count: int = Field(alias="sampledPixelCount")
    valid_sample_count: int = Field(alias="validSampleCount")
    estimated: bool
    sample_minimum: FiniteFloat = Field(alias="sampleMinimum")
    sample_maximum: FiniteFloat = Field(alias="sampleMaximum")
    percentiles: RasterPercentiles
    histogram: RasterHistogram
    suggested_range: RasterValueRange = Field(alias="suggestedRange")


class NoValidRasterSamplesError(ValueError):
    """Raised when a bounded sample contains no finite data values."""


@dataclass
class _RasterStatisticsWork:
    """One coalesced statistics task and its active HTTP waiters."""

    task: asyncio.Task[RasterStatistics]
    waiter_count: int = 0


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

    def require_current(self, layer_name: str) -> AuthorizedRaster:
        """Require a layer authorized from a source that has not changed.

        Args:
            layer_name: Workspace-qualified GeoServer layer name.

        Returns:
            Canonical path and approved signature for the mounted GeoTIFF.

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
            raise HTTPException(
                status_code=409,
                detail="The visualized GeoTIFF changed; select it again",
            )
        return AuthorizedRaster(source_path, approved_signature)


def _bounded_raster_sample_shape(
    source_width: int,
    source_height: int,
    maximum_sample_dimension: int = RASTER_STATISTICS_MAX_SAMPLE_DIMENSION,
) -> tuple[int, int]:
    """Return an aspect-preserving sample size within a square bound.

    Args:
        source_width: Raster width in source pixels.
        source_height: Raster height in source pixels.
        maximum_sample_dimension: Maximum height or width of the sample.

    Returns:
        Sample height and width.
    """
    if max(source_width, source_height) <= maximum_sample_dimension:
        return source_height, source_width

    scale = maximum_sample_dimension / max(source_width, source_height)
    sample_height = max(1, math.floor(source_height * scale))
    sample_width = max(1, math.floor(source_width * scale))
    return sample_height, sample_width


def _strict_raster_value_range(
    sample_minimum: float,
    sample_maximum: float,
    p05: float,
    p50: float,
    p95: float,
) -> RasterValueRange:
    """Derive a finite, strictly ordered style range from sample values.

    Args:
        sample_minimum: Lowest sampled value.
        sample_maximum: Highest sampled value.
        p05: Fifth sample percentile.
        p50: Median sample value.
        p95: Ninety-fifth sample percentile.

    Returns:
        Strict range accepted by the WMS style contract.
    """
    if p05 < p50 < p95:
        return RasterValueRange(minimum=p05, midpoint=p50, maximum=p95)

    percentile_padding = max(
        max(abs(value) for value in (p05, p50, p95)) * 1e-6,
        1e-12,
    )
    padded_minimum = p05 - percentile_padding if p05 == p50 else p05
    padded_maximum = p95 + percentile_padding if p50 == p95 else p95
    if (
        all(
            math.isfinite(value)
            for value in (padded_minimum, p50, padded_maximum)
        )
        and padded_minimum < p50 < padded_maximum
    ):
        return RasterValueRange(
            minimum=padded_minimum,
            midpoint=p50,
            maximum=padded_maximum,
        )

    if sample_minimum < sample_maximum:
        midpoint = sample_minimum / 2 + sample_maximum / 2
        if sample_minimum < midpoint < sample_maximum:
            return RasterValueRange(
                minimum=sample_minimum,
                midpoint=midpoint,
                maximum=sample_maximum,
            )

        lower_value = math.nextafter(sample_minimum, -math.inf)
        if math.isfinite(lower_value):
            return RasterValueRange(
                minimum=lower_value,
                midpoint=sample_minimum,
                maximum=sample_maximum,
            )
        upper_value = math.nextafter(sample_maximum, math.inf)
        return RasterValueRange(
            minimum=sample_minimum,
            midpoint=sample_maximum,
            maximum=upper_value,
        )

    constant_value = sample_minimum
    scale_relative_padding = max(abs(constant_value) * 1e-6, 1e-12)
    lower_value = constant_value - scale_relative_padding
    upper_value = constant_value + scale_relative_padding
    if (
        all(
            math.isfinite(value)
            for value in (lower_value, constant_value, upper_value)
        )
        and lower_value < constant_value < upper_value
    ):
        return RasterValueRange(
            minimum=lower_value,
            midpoint=constant_value,
            maximum=upper_value,
        )

    lower_value = math.nextafter(constant_value, -math.inf)
    upper_value = math.nextafter(constant_value, math.inf)
    if math.isfinite(lower_value) and math.isfinite(upper_value):
        return RasterValueRange(
            minimum=lower_value,
            midpoint=constant_value,
            maximum=upper_value,
        )
    if math.isfinite(lower_value):
        return RasterValueRange(
            minimum=math.nextafter(lower_value, -math.inf),
            midpoint=lower_value,
            maximum=constant_value,
        )
    return RasterValueRange(
        minimum=constant_value,
        midpoint=upper_value,
        maximum=math.nextafter(upper_value, math.inf),
    )


def _read_raster_statistics(source_path: Path) -> RasterStatistics:
    """Read a fixed-size whole-raster sample and summarize band 1.

    Args:
        source_path: Authorized mounted GeoTIFF.

    Returns:
        Finite sample distribution and a suggested display range.

    Raises:
        NoValidRasterSamplesError: If the sample has no finite data values.
        OSError: If the source cannot be read.
        rasterio.errors.RasterioError: If GDAL cannot open or sample it.
    """
    with rasterio.open(source_path) as dataset:
        sample_height, sample_width = _bounded_raster_sample_shape(
            dataset.width,
            dataset.height,
        )
        sample = dataset.read(
            1,
            out_shape=(sample_height, sample_width),
            masked=True,
            resampling=Resampling.nearest,
        )
        source_width = dataset.width
        source_height = dataset.height

    sample_values = numpy.asarray(
        sample.compressed(),
        dtype=numpy.float64,
    )
    sample_values = sample_values[numpy.isfinite(sample_values)]
    if sample_values.size == 0:
        raise NoValidRasterSamplesError

    sample_minimum = float(numpy.min(sample_values))
    sample_maximum = float(numpy.max(sample_values))
    p05, p50, p95 = (
        float(value)
        for value in numpy.percentile(sample_values, (5, 50, 95))
    )
    suggested_range = _strict_raster_value_range(
        sample_minimum,
        sample_maximum,
        p05,
        p50,
        p95,
    )
    histogram_minimum = (
        sample_minimum
        if sample_minimum < sample_maximum
        else suggested_range.minimum
    )
    histogram_maximum = (
        sample_maximum
        if sample_minimum < sample_maximum
        else suggested_range.maximum
    )
    counts, edges = numpy.histogram(
        sample_values,
        bins=RASTER_STATISTICS_BIN_COUNT,
        range=(histogram_minimum, histogram_maximum),
    )
    source_pixel_count = source_width * source_height
    sampled_pixel_count = sample_width * sample_height
    return RasterStatistics(
        sourceWidth=source_width,
        sourceHeight=source_height,
        sourcePixelCount=source_pixel_count,
        sampleWidth=sample_width,
        sampleHeight=sample_height,
        sampledPixelCount=sampled_pixel_count,
        validSampleCount=int(sample_values.size),
        estimated=sampled_pixel_count < source_pixel_count,
        sampleMinimum=sample_minimum,
        sampleMaximum=sample_maximum,
        percentiles=RasterPercentiles(p05=p05, p50=p50, p95=p95),
        histogram=RasterHistogram(
            counts=[int(count) for count in counts],
            edges=[float(edge) for edge in edges],
        ),
        suggestedRange=suggested_range,
    )


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
    authorized_raster = raster_registry.require_current(layer_name)
    return _read_raster_pixel(
        authorized_raster.source_path,
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


class RasterStatisticsService:
    """Cache and serialize bounded statistics reads for published rasters."""

    def __init__(
        self,
        raster_registry: PublishedRasterRegistry,
        read_concurrency: int = RASTER_STATISTICS_READ_CONCURRENCY,
        cache_entries: int = RASTER_STATISTICS_CACHE_ENTRIES,
    ) -> None:
        self._raster_registry = raster_registry
        self._read_semaphore = asyncio.Semaphore(read_concurrency)
        self._cache_entries = cache_entries
        self._cache: OrderedDict[
            RasterStatisticsCacheKey,
            RasterStatistics,
        ] = OrderedDict()
        self._inflight: dict[
            RasterStatisticsCacheKey,
            _RasterStatisticsWork,
        ] = {}
        self._active_read_tasks: set[asyncio.Task[RasterStatistics]] = set()
        self._state_lock = asyncio.Lock()

    async def get(self, request: CatalogRasterRequest) -> RasterStatistics:
        """Return current statistics, coalescing identical source reads.

        Args:
            request: Validated Item identity for one published raster.

        Returns:
            Cached or newly computed bounded raster statistics.

        Raises:
            HTTPException: If the raster is not current or cannot be sampled.
        """
        layer_name = f"{GEOSERVER_WORKSPACE_NAME}:{request.item_id}"
        authorized_raster = await asyncio.to_thread(
            self._raster_registry.require_current,
            layer_name,
        )
        cache_key = (
            layer_name,
            authorized_raster.source_signature,
            RASTER_STATISTICS_ALGORITHM,
        )
        async with self._state_lock:
            cached_statistics = self._cache.get(cache_key)
            if cached_statistics is not None:
                self._cache.move_to_end(cache_key)
                return cached_statistics

            work = self._inflight.get(cache_key)
            if work is None:
                read_task = asyncio.create_task(
                    self._compute(
                        layer_name,
                        authorized_raster,
                        cache_key,
                    )
                )
                read_task.add_done_callback(self._retrieve_task_exception)
                work = _RasterStatisticsWork(read_task)
                self._inflight[cache_key] = work
            work.waiter_count += 1

        try:
            return await asyncio.shield(work.task)
        except HTTPException:
            raise
        except NoValidRasterSamplesError as error:
            raise HTTPException(
                status_code=409,
                detail=(
                    "No finite, non-nodata pixels were found in the bounded "
                    "raster sample"
                ),
            ) from error
        except (OSError, ValueError, rasterio.errors.RasterioError) as error:
            raise HTTPException(
                status_code=409,
                detail="The selected raster statistics could not be read",
            ) from error
        finally:
            await self._release_waiter(cache_key, work)

    async def _release_waiter(
        self,
        cache_key: RasterStatisticsCacheKey,
        work: _RasterStatisticsWork,
    ) -> None:
        """Cancel abandoned work only while it remains queued for capacity."""
        async with self._state_lock:
            work.waiter_count -= 1
            if (
                work.waiter_count == 0
                and self._inflight.get(cache_key) is work
                and work.task not in self._active_read_tasks
            ):
                self._inflight.pop(cache_key)
                work.task.cancel()

    async def _compute(
        self,
        layer_name: str,
        authorized_raster: AuthorizedRaster,
        cache_key: RasterStatisticsCacheKey,
    ) -> RasterStatistics:
        """Compute one source signature while retaining its capacity slot."""
        read_task = cast(
            asyncio.Task[RasterStatistics],
            asyncio.current_task(),
        )
        try:
            async with self._read_semaphore:
                async with self._state_lock:
                    self._active_read_tasks.add(read_task)
                current_raster = await asyncio.to_thread(
                    self._raster_registry.require_current,
                    layer_name,
                )
                if current_raster != authorized_raster:
                    raise HTTPException(
                        status_code=409,
                        detail="The visualized GeoTIFF changed; select it again",
                    )
                statistics = await asyncio.to_thread(
                    _read_raster_statistics,
                    authorized_raster.source_path,
                )
                current_raster = await asyncio.to_thread(
                    self._raster_registry.require_current,
                    layer_name,
                )
                if current_raster != authorized_raster:
                    raise HTTPException(
                        status_code=409,
                        detail="The visualized GeoTIFF changed; select it again",
                    )

                async with self._state_lock:
                    self._cache[cache_key] = statistics
                    self._cache.move_to_end(cache_key)
                    while len(self._cache) > self._cache_entries:
                        self._cache.popitem(last=False)
                return statistics
        finally:
            async with self._state_lock:
                self._active_read_tasks.discard(read_task)
                work = self._inflight.get(cache_key)
                if work is not None and work.task is read_task:
                    self._inflight.pop(cache_key)

    @staticmethod
    def _retrieve_task_exception(
        completed_task: asyncio.Task[RasterStatistics],
    ) -> None:
        """Retrieve failures from work that outlived a canceled HTTP request."""
        if not completed_task.cancelled():
            completed_task.exception()


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
