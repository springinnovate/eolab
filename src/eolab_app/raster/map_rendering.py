"""Deliver bounded map windows from authorized original raster sources."""

import asyncio
from pathlib import Path
from typing import Any

import numpy as np
import rasterio
from pydantic import BaseModel, ConfigDict, Field
from rasterio.warp import transform

from eolab_app.raster.models import Wgs84Bounds
from eolab_app.raster.source_models import RasterSourceRequest
from eolab_app.raster.source_access import RasterSourceAccess, read_private_raster
from eolab_app.raster.source_contract import (
    read_native_raster_block,
    require_pixel_source_structure,
    require_raster_analysis_georeferencing,
    require_signed_raster_dependencies,
    source_work_for_blocks,
)
from eolab_app.source_files import SourceFileError

MAX_WINDOW_BLOCKS = 4096
MAX_WINDOW_DECODED_BYTES = 512 * 1024**2


class RasterMapGrid(BaseModel):
    """Choose a map viewport and a display grid of at most 512 by 512 cells."""

    model_config = ConfigDict(extra="forbid")
    bounds: Wgs84Bounds
    width: int = Field(strict=True, ge=1, le=512)
    height: int = Field(strict=True, ge=1, le=512)


class RasterMapWindowRequest(RasterSourceRequest, RasterMapGrid):
    """Request a bounded display grid from a path-free raster source."""


def read_raster_map_window(path: Path, request: RasterMapGrid) -> dict[str, Any]:
    """Read nearest native cells at Web Mercator display-pixel centers.

    Native blocks are admitted before any pixel read. Embedded masks, NoData
    and nonfinite values use the ordinary source reader's validity contract;
    neither overviews nor display colors can change the sampled values.

    Args:
        path: Authorized original GeoTIFF held for the complete read.
        request: Validated viewport and bounded display dimensions.

    Returns:
        Row-major display values, null for invalid or outside-source cells.

    Raises:
        ValueError: If projection, source structure or decoded work is unsupported.
        RasterioError: If the original data cannot be read.
    """
    bounds = request.bounds
    if bounds.south < -85.05112878 or bounds.north > 85.05112878:
        raise ValueError("Choose an area within the map's supported latitudes.")
    with (
        rasterio.Env(GDAL_CACHEMAX=32 * 1024**2, GDAL_NUM_THREADS="1"),
        rasterio.open(path, driver="GTiff") as dataset,
    ):
        require_signed_raster_dependencies(dataset, path)
        require_raster_analysis_georeferencing(dataset)
        require_pixel_source_structure(dataset)
        mx, my = transform(
            "EPSG:4326",
            "EPSG:3857",
            [bounds.west, bounds.east],
            [bounds.south, bounds.north],
        )
        xs = mx[0] + (np.arange(request.width) + 0.5) * (mx[1] - mx[0]) / request.width
        ys = (
            my[1] - (np.arange(request.height) + 0.5) * (my[1] - my[0]) / request.height
        )
        x, y = np.meshgrid(xs, ys)
        sx, sy = transform(
            "EPSG:3857", dataset.crs, x.ravel().tolist(), y.ravel().tolist()
        )
        inverse = ~dataset.transform
        sx, sy = np.asarray(sx), np.asarray(sy)
        columns = inverse.a * sx + inverse.b * sy + inverse.c
        rows = inverse.d * sx + inverse.e * sy + inverse.f
        inside = (
            np.isfinite(columns)
            & np.isfinite(rows)
            & (columns >= 0)
            & (columns < dataset.width)
            & (rows >= 0)
            & (rows < dataset.height)
        )
        positions = np.flatnonzero(inside)
        columns, rows = np.floor(columns[inside]).astype(np.int64), np.floor(
            rows[inside]
        ).astype(np.int64)
        bh, bw = dataset.block_shapes[0]
        blocks: dict[tuple[int, int], list[int]] = {}
        for index, (row, column) in enumerate(zip(rows, columns, strict=True)):
            block = (int(row) // bh, int(column) // bw)
            blocks.setdefault(block, []).append(index)
            if len(blocks) > MAX_WINDOW_BLOCKS:
                raise ValueError(
                    "This view covers too much raster data. Zoom in to see more detail."
                )
        count, decoded = source_work_for_blocks(dataset, tuple(blocks))
        if count > MAX_WINDOW_BLOCKS or decoded > MAX_WINDOW_DECODED_BYTES:
            raise ValueError(
                "This view covers too much raster data. Zoom in to see more detail."
            )
        values = np.full(request.width * request.height, np.nan, dtype=np.float64)
        for block, indexes in blocks.items():
            window = dataset.block_window(1, *block)
            data = read_native_raster_block(dataset, window)
            selected = data[
                rows[indexes] - int(window.row_off),
                columns[indexes] - int(window.col_off),
            ]
            values[positions[indexes]] = selected.astype(np.float64).filled(np.nan)
        cells = values.astype(object)
        cells[~np.isfinite(values)] = None
        return {
            "bounds": [bounds.west, bounds.south, bounds.east, bounds.north],
            "width": request.width,
            "height": request.height,
            "values": cells.tolist(),
        }


class RasterMapWindows:
    """Authorize and supervise viewport reads for the raster display adapter."""

    def __init__(self, sources: RasterSourceAccess) -> None:
        """Use the composed source authority and admit at most two active windows.

        Args:
            sources: Neutral catalog/private access, independent of analysis services.
        """
        self.sources = sources
        self.slots = asyncio.Semaphore(2)

    async def read(
        self, request: RasterMapWindowRequest, owner: str | None = None
    ) -> dict[str, Any]:
        """Return an authorized display grid after bounded native work has stopped.

        Args:
            request: Checked opaque identity and viewport grid.
            owner: Server-derived private session identity, when required.

        Returns:
            Source identity, version and display grid; no paths or download URLs.

        Raises:
            SourceFileError: If busy, unavailable or unsupported for display.
            RasterFeatureError: If source authorization or native reading fails.
            asyncio.CancelledError: After native work stops and its lease is released.
        """
        if self.slots.locked():
            raise SourceFileError("Raster display is busy. Try again shortly.", 429)
        async with self.slots, self.sources.open(request.source, owner) as source:
            try:
                result = await read_private_raster(
                    read_raster_map_window, source.source_path, request
                )
            except ValueError as error:
                raise SourceFileError(str(error), 422) from error
            return {
                "source": request.source.model_dump(by_alias=True),
                "version": source.version,
                **result,
            }
