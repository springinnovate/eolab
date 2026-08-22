"""Application service coordinating authorized raster pixel reads."""

import asyncio
from collections.abc import Callable
from pathlib import Path

import rasterio

from eolab_app.raster.errors import RasterConflictError
from eolab_app.raster.models import CatalogPixelRequest, RasterPixel
from eolab_app.raster.pixel import read_raster_pixel
from eolab_app.raster.sources import PublishedRasterRegistry


GEOSERVER_WORKSPACE_NAME = "eolab"
RASTER_PIXEL_READ_CONCURRENCY = 2


class RasterPixelService:
    """Authorize and schedule pixel reads within a fixed capacity."""

    def __init__(
        self,
        raster_registry: PublishedRasterRegistry,
        read_concurrency: int = RASTER_PIXEL_READ_CONCURRENCY,
        pixel_reader: Callable[[Path, float, float], RasterPixel] = (
            read_raster_pixel
        ),
    ) -> None:
        """Create a bounded pixel-read service.

        Args:
            raster_registry: Current-process publication authorizations.
            read_concurrency: Maximum simultaneous Rasterio reads.
            pixel_reader: Synchronous pixel boundary, replaceable in tests.
        """
        self._raster_registry = raster_registry
        self._read_semaphore = asyncio.Semaphore(read_concurrency)
        self._pixel_reader = pixel_reader

    def _read_current(self, request: CatalogPixelRequest) -> RasterPixel:
        """Resolve and sample an approved raster in one worker-thread job.

        Args:
            request: Validated Item identity and WGS 84 position.

        Returns:
            The sampled band-1 value and source cell.

        Raises:
            RasterConflictError: If the source changed or is unreadable.
            OSError: If the source cannot be read.
            rasterio.errors.RasterioError: If GDAL cannot sample it.
            ValueError: If its CRS cannot transform the position.
        """
        layer_name = f"{GEOSERVER_WORKSPACE_NAME}:{request.item_id}"
        authorized_raster = self._raster_registry.require_current(layer_name)
        return self._pixel_reader(
            authorized_raster.source_path,
            request.longitude,
            request.latitude,
        )

    async def get(self, request: CatalogPixelRequest) -> RasterPixel:
        """Sample one pixel without exceeding raster-read capacity.

        Args:
            request: Validated Item identity and WGS 84 position.

        Returns:
            The sampled band-1 value and source cell.

        Raises:
            RasterConflictError: If the source is changed or unreadable.
            RasterRequestError: If the layer has not been approved.
        """
        await self._read_semaphore.acquire()
        read_task = asyncio.create_task(asyncio.to_thread(self._read_current, request))

        def release_read_slot(
            completed_task: asyncio.Task[RasterPixel],
        ) -> None:
            """Release capacity after the worker thread actually completes.

            Args:
                completed_task: Finished pixel-read task.
            """
            self._read_semaphore.release()
            if not completed_task.cancelled():
                completed_task.exception()

        read_task.add_done_callback(release_read_slot)
        try:
            return await asyncio.shield(read_task)
        except (OSError, ValueError, rasterio.errors.RasterioError) as error:
            raise RasterConflictError(
                "The selected raster could not be sampled"
            ) from error
