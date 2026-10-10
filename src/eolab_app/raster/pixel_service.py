"""Application service coordinating authorized raster pixel reads."""

import asyncio
from collections.abc import Callable
from pathlib import Path

import rasterio

from eolab_app.raster.errors import RasterConflictError
from eolab_app.raster.models import (
    CatalogPixelRequest,
    RasterPixel,
)
from eolab_app.raster.pixel import read_raster_pixel
from eolab_app.raster.source_access import (
    RasterSourceAccess,
    RasterReadSource,
    read_private_raster,
)
from eolab_app.raster.source_models import (
    RasterPixelSourceRequest,
    raster_source_reference,
)
from eolab_app.source_files import finish_source_task

class RasterPixelService:
    """Authorize and schedule rendering-independent pixel reads."""

    def __init__(
        self,
        source_access: RasterSourceAccess,
        read_concurrency: int,
        pixel_reader: Callable[[Path, float, float], RasterPixel] = (read_raster_pixel),
    ) -> None:
        """Create a bounded pixel-read service.

        Args:
            source_access: Scoped catalog/private source authorization.
            read_concurrency: Maximum simultaneous Rasterio reads.
            pixel_reader: Synchronous pixel boundary, replaceable in tests.
        """
        self._source_access = source_access
        self._read_semaphore = asyncio.Semaphore(read_concurrency)
        self._pixel_reader = pixel_reader

    async def _read_current(
        self,
        authorized_raster: RasterReadSource,
        request: CatalogPixelRequest | RasterPixelSourceRequest,
    ) -> RasterPixel:
        """Sample one source while retaining read capacity and identity.

        Args:
            authorized_raster: Original source retained for the complete native read.
            request: Validated source and WGS 84 position.

        Returns:
            The sampled band-one value and source cell.

        Raises:
            RasterConflictError: If the source changes around the read.
            OSError: If the source cannot be read.
            rasterio.errors.RasterioError: If GDAL cannot sample it.
            ValueError: If its CRS cannot transform the position.
        """

        execute = (
            read_private_raster if authorized_raster.private else asyncio.to_thread
        )
        pixel = await execute(
            self._pixel_reader,
            authorized_raster.source_path,
            request.longitude,
            request.latitude,
        )
        return pixel

    async def get(
        self,
        request: CatalogPixelRequest | RasterPixelSourceRequest,
        owner: str | None = None,
    ) -> RasterPixel:
        """Read an original cell while its catalog or private source is authorized.

        Args:
            request: Existing catalog request or explicit source and coordinate.
            owner: Server-derived session hash for a private source.

        Returns:
            Existing band-one pixel result.

        Raises:
            RasterFeatureError: If the source cannot be read.
            SourceFileError: If private access changes before delivery.
        """
        async with self._source_access.open(
            raster_source_reference(request), owner
        ) as source:
            return await self._get(request, source)

    async def _get(
        self,
        request: CatalogPixelRequest | RasterPixelSourceRequest,
        authorized_raster: RasterReadSource,
    ) -> RasterPixel:
        """Keep pixel read capacity until its native reader has stopped.

        Args:
            request: Validated source identity and WGS 84 position.
            authorized_raster: Original source retained by the caller's access scope.

        Returns:
            The sampled band-one value and source cell.

        Raises:
            RasterFeatureError: If the source cannot be read.
            RasterConflictError: If the source is stale or cannot be sampled.
        """
        await self._read_semaphore.acquire()
        read_task = asyncio.create_task(
            self._read_current(authorized_raster, request)
        )

        def retrieve_task_exception(
            completed_task: asyncio.Task[RasterPixel],
        ) -> None:
            """Retrieve a worker failure after HTTP cancellation.

            Args:
                completed_task: Finished pixel-read task.
            """
            self._read_semaphore.release()
            if not completed_task.cancelled():
                completed_task.exception()

        read_task.add_done_callback(retrieve_task_exception)
        try:
            return await asyncio.shield(read_task)
        except asyncio.CancelledError:
            if authorized_raster.private:
                read_task.cancel()
                await finish_source_task(read_task)
            raise
        except RasterConflictError:
            raise
        except (OSError, ValueError, rasterio.errors.RasterioError) as error:
            raise RasterConflictError(
                "The selected raster could not be sampled"
            ) from error
