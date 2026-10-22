"""Application service coordinating authorized raster pixel reads."""

import asyncio
from collections.abc import Callable

import rasterio

from eolab_app.raster.reader import RasterData
from eolab_app.raster.errors import RasterConflictError
from eolab_app.raster.models import (
    CatalogPixelRequest,
    RasterPixel,
)
from eolab_app.raster.pixel import read_raster_pixel
from eolab_app.raster.source_access import (
    RasterSourceAccess,
    RasterReadSource,
)
from eolab_app.raster.source_models import (
    RasterPixelSourceRequest,
    raster_source_reference,
)


class RasterPixelService:
    """Authorize and schedule rendering-independent pixel reads."""

    def __init__(
        self,
        source_access: RasterSourceAccess,
        read_concurrency: int,
        pixel_reader: Callable[[RasterData, float, float], RasterPixel] = (
            read_raster_pixel
        ),
    ) -> None:
        """Create a bounded pixel-read service.

        Args:
            source_access: Scoped catalog/private source authorization.
            read_concurrency: Maximum simultaneous native raster reads.
            pixel_reader: Synchronous function that reads one pixel from an authorized raster.
        """

        self._source_access = source_access
        self._read_semaphore = asyncio.Semaphore(read_concurrency)
        self._pixel_reader = pixel_reader

    async def _read_authorized_pixel(
        self,
        authorized_raster: RasterReadSource,
        request: CatalogPixelRequest | RasterPixelSourceRequest,
    ) -> RasterPixel:
        """Read the requested pixel from an authorized raster on a worker thread.

        Args:
            authorized_raster: Original source resolved for this interactive read.
            request: Validated source and WGS 84 position.

        Returns:
            The sampled band-one value and source cell.

        Raises:
            OSError: If the source cannot be read.
            rasterio.errors.RasterioError: If GDAL cannot sample it.
            ValueError: If its CRS cannot transform the position.
        """

        pixel = await asyncio.to_thread(
            self._pixel_reader,
            authorized_raster.data,
            request.longitude,
            request.latitude,
        )
        return pixel

    async def get(
        self,
        request: CatalogPixelRequest | RasterPixelSourceRequest,
        owner: str | None = None,
    ) -> RasterPixel:
        """Authorize an original raster and read one cell through the shared reader.

        Short reads do not retain temporary files. If cleanup races the read,
        the ordinary reader reports that the source is unavailable. Cancellation
        discards the response while the read keeps its concurrency slot until done.

        Args:
            request: Existing catalog request or explicit source and coordinate.
            owner: Server-derived session hash for a private source.

        Returns:
            Band-one value and the source cell containing the requested coordinate.

        Raises:
            RasterFeatureError: If the source cannot be read.
            SourceFileError: If private ownership, expiry or file resolution fails.
        """
        source = await self._source_access.resolve(
            raster_source_reference(request), owner
        )
        return await self._read_with_concurrency_limit(request, source)

    async def _read_with_concurrency_limit(
        self,
        request: CatalogPixelRequest | RasterPixelSourceRequest,
        authorized_raster: RasterReadSource,
    ) -> RasterPixel:
        """Read one pixel while holding a concurrency slot until the reader stops.

        Args:
            request: Validated source identity and WGS 84 position.
            authorized_raster: Original source resolved without requiring rendering or a transfer lease.

        Returns:
            The sampled band-one value and source cell.

        Raises:
            RasterFeatureError: If the source cannot be read.
            RasterConflictError: If the source is stale or cannot be sampled.
        """
        await self._read_semaphore.acquire()
        read_task = asyncio.create_task(
            self._read_authorized_pixel(authorized_raster, request)
        )

        def release_pixel_reader(
            completed_task: asyncio.Task[RasterPixel],
        ) -> None:
            """Release the pixel-read slot and collect any unobserved worker exception.

            Args:
                completed_task: Finished pixel-read task.
            """
            self._read_semaphore.release()
            if not completed_task.cancelled():
                completed_task.exception()

        read_task.add_done_callback(release_pixel_reader)
        try:
            return await asyncio.shield(read_task)
        except asyncio.CancelledError:
            raise
        except RasterConflictError:
            raise
        except (OSError, ValueError, rasterio.errors.RasterioError) as error:
            raise RasterConflictError(
                "The selected raster could not be sampled"
            ) from error
