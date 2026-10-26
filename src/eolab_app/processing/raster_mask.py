"""Calculation-owned, disk-backed polygon masks aligned to the source raster."""

from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import rasterio
from rasterio.features import rasterize
from rasterio.vrt import WarpedVRT
from rasterio.windows import Window, transform as window_transform

from eolab_app.bounded_vector import PolygonRasterizer
from eolab_app.processing.aggregate_models import RasterAggregateLimits

MASK_TILE_SIDE = 512


@contextmanager
def temporary_polygon_mask(
    dataset: rasterio.io.DatasetReader | WarpedVRT,
    raster_window: Window,
    polygons: tuple[dict[str, object], ...] | PolygonRasterizer,
    directory: Path,
    limits: RasterAggregateLimits,
    *,
    all_touched: bool = False,
) -> Iterator[rasterio.io.DatasetReader | None]:
    """Rasterize selected polygons to a tiled file and remove it after use.

    No full-grid NumPy mask is allocated. GDAL writes the selected pixel grid
    using its normal tile buffers. The worker cleans an interrupted attempt after
    its native process stops; no disk-space estimate precedes the write.

    Args:
        dataset: Source raster supplying the CRS and pixel alignment.
        raster_window: Source-pixel rectangle covered by the mask.
        polygons: Projected geometry dictionaries or a PolygonRasterizer retaining
            the calculation's filtered polygons. Empty means no mask is needed.
        directory: Private directory owned by this calculation attempt.
        limits: Shared job and ground-area settings; writes have no byte ceiling.
        all_touched: Include every pixel touched by a polygon when True;
            otherwise use the existing pixel-center inclusion rule.

    Yields:
        Read-only byte mask (one inside, zero outside), or None when unnecessary.

    Raises:
        OSError: If the file cannot be written, read or removed.
        ValueError: If prepared geometry is unavailable or invalid.
    """
    if not polygons:
        yield None
        return
    path = directory / "polygon-mask.tif"
    width, height = int(raster_window.width), int(raster_window.height)
    transform = window_transform(raster_window, dataset.transform)
    try:
        shapes = (
            polygons.iter_projected_polygons()
            if isinstance(polygons, PolygonRasterizer)
            else iter(polygons)
        )
        rasterize(
            shapes,
            transform=transform,
            all_touched=all_touched,
            default_value=1,
            fill=0,
            dtype="uint8",
            skip_invalid=False,
            dst_path=path,
            dst_kwds={
                "driver": "GTiff",
                "width": width,
                "height": height,
                "count": 1,
                "crs": dataset.crs,
                "transform": transform,
                "tiled": True,
                "blockxsize": MASK_TILE_SIDE,
                "blockysize": MASK_TILE_SIDE,
                "BIGTIFF": "YES",
            },
        )
        with rasterio.open(path) as mask:
            yield mask
    finally:
        path.unlink(missing_ok=True)
