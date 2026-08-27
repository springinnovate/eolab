"""Neutral WGS 84 selection-to-source-window mechanisms."""

import math
from collections.abc import Callable

import rasterio
from rasterio.warp import transform
from rasterio.windows import Window

from eolab_app.raster.models import CanonicalWgs84Bounds, SelectedRasterArea


BOUNDED_WGS84_DENSIFY_POINTS = 21
BOUNDED_SOURCE_WINDOW_PADDING_PIXELS = 1


class NoRasterBoundsOverlapError(ValueError):
    """Raised when a selected WGS 84 area misses a raster source grid."""


def densified_wgs84_bounds_ring(
    selected_bounds: CanonicalWgs84Bounds,
) -> tuple[tuple[float, float], ...]:
    """Trace all four selection edges with intermediate WGS 84 vertices.

    Args:
        selected_bounds: Canonical west, south, east, and north bounds.

    Returns:
        Closed WGS 84 polygon ring with each edge evenly densified.
    """
    west, south, east, north = selected_bounds
    edge_endpoints = (
        ((west, south), (east, south)),
        ((east, south), (east, north)),
        ((east, north), (west, north)),
        ((west, north), (west, south)),
    )
    denominator = BOUNDED_WGS84_DENSIFY_POINTS + 1
    ring: list[tuple[float, float]] = []
    for edge_index, (start, end) in enumerate(edge_endpoints):
        first_step = 0 if edge_index == 0 else 1
        for step in range(first_step, denominator + 1):
            fraction = step / denominator
            ring.append(
                (
                    start[0] + (end[0] - start[0]) * fraction,
                    start[1] + (end[1] - start[1]) * fraction,
                )
            )
    return tuple(ring)


def selected_raster_area_for_wgs84_bounds(
    dataset: rasterio.io.DatasetReader,
    selected_bounds: CanonicalWgs84Bounds,
    coordinate_transform: Callable[..., tuple[list[float], list[float]]] = transform,
) -> SelectedRasterArea:
    """Project a WGS 84 rectangle and bound it in source-pixel space.

    All four edges are densified before transformation. The transformed
    polygon is retained for masking, while its inverse-affine envelope supplies
    a bounded source window for north-up, rotated, or skewed rasters.

    Args:
        dataset: Open source raster with a coordinate reference system.
        selected_bounds: Canonical west, south, east, north WGS 84 bounds.
        coordinate_transform: CRS transformation collaborator, injectable for
            deterministic boundary tests.

    Returns:
        Projected selection polygon and integer source-pixel envelope.

    Raises:
        NoRasterBoundsOverlapError: If the selection misses the raster.
        ValueError: If the bounds cannot be transformed to the raster CRS.
    """
    wgs84_ring = densified_wgs84_bounds_ring(selected_bounds)
    projected_x, projected_y = coordinate_transform(
        "EPSG:4326",
        dataset.crs,
        [coordinate[0] for coordinate in wgs84_ring],
        [coordinate[1] for coordinate in wgs84_ring],
    )
    projected_ring = tuple(zip(projected_x, projected_y, strict=True))
    if not all(
        math.isfinite(coordinate)
        for point in projected_ring
        for coordinate in point
    ):
        raise ValueError("Selected bounds could not be projected")

    inverse_transform = ~dataset.transform
    pixel_ring = tuple(
        inverse_transform * projected_coordinate
        for projected_coordinate in projected_ring
    )
    padding = BOUNDED_SOURCE_WINDOW_PADDING_PIXELS
    column_start = max(
        0,
        math.floor(min(point[0] for point in pixel_ring)) - padding,
    )
    row_start = max(
        0,
        math.floor(min(point[1] for point in pixel_ring)) - padding,
    )
    column_stop = min(
        dataset.width,
        math.ceil(max(point[0] for point in pixel_ring)) + padding,
    )
    row_stop = min(
        dataset.height,
        math.ceil(max(point[1] for point in pixel_ring)) + padding,
    )
    if column_start >= column_stop or row_start >= row_stop:
        raise NoRasterBoundsOverlapError
    return SelectedRasterArea(
        source_window=Window(
            column_start,
            row_start,
            column_stop - column_start,
            row_stop - row_start,
        ),
        projected_geometries=({
            "type": "Polygon",
            "coordinates": [projected_ring],
        },),
    )
