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


def _polygon_rings(
    geometry: dict[str, object],
) -> tuple[tuple[tuple[float, float], ...], ...]:
    """Return every ring from one validated polygonal GeoJSON geometry.

    Args:
        geometry: Fresh Polygon or MultiPolygon GeoJSON mapping.

    Returns:
        Exterior and interior rings in deterministic geometry order.

    Raises:
        TypeError: If the validated geometry contract is malformed.
    """
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, (list, tuple)):
        raise TypeError("Selection polygon coordinates are malformed")
    polygons = [coordinates] if geometry.get("type") == "Polygon" else coordinates
    rings: list[tuple[tuple[float, float], ...]] = []
    for polygon in polygons:
        if not isinstance(polygon, (list, tuple)):
            raise TypeError("Selection polygon is malformed")
        for ring in polygon:
            if not isinstance(ring, (list, tuple)):
                raise TypeError("Selection polygon ring is malformed")
            positions: list[tuple[float, float]] = []
            for position in ring:
                if not isinstance(position, (list, tuple)) or len(position) < 2:
                    raise TypeError("Selection polygon position is malformed")
                positions.append((float(position[0]), float(position[1])))
            if len(positions) < 4:
                raise TypeError("Selection polygon ring is too short")
            rings.append(tuple(positions))
    return tuple(rings)


def _densify_polygon_rings(
    rings: tuple[tuple[tuple[float, float], ...], ...],
    maximum_coordinates: int,
) -> tuple[tuple[tuple[float, float], ...], ...]:
    """Densify Polygon edges without exceeding transformed-coordinate capacity.

    Args:
        rings: Validated closed WGS 84 polygon rings.
        maximum_coordinates: Hard limit on all transformed positions.

    Returns:
        Rings with a bounded number of evenly spaced edge positions.

    Raises:
        ValueError: If source rings already exceed transformation capacity.
    """
    segment_count = sum(max(0, len(ring) - 1) for ring in rings)
    if segment_count < 1:
        raise ValueError("Selection has no polygon edges")
    if segment_count + len(rings) > maximum_coordinates:
        raise ValueError("Selection exceeds the transformed-geometry limit")
    densify_points = min(
        BOUNDED_WGS84_DENSIFY_POINTS,
        max(
            0,
            (maximum_coordinates - len(rings))
            // segment_count
            - 1,
        ),
    )
    denominator = densify_points + 1
    densified: list[tuple[tuple[float, float], ...]] = []
    for ring in rings:
        result = [ring[0]]
        for start, end in zip(ring, ring[1:]):
            for step in range(1, denominator + 1):
                fraction = step / denominator
                result.append((
                    start[0] + (end[0] - start[0]) * fraction,
                    start[1] + (end[1] - start[1]) * fraction,
                ))
        densified.append(tuple(result))
    return tuple(densified)


def _source_window_for_projected_geometries(
    dataset: rasterio.io.DatasetReader,
    projected_geometries: tuple[dict[str, object], ...],
) -> Window:
    """Clip a projected polygon envelope to one raster's pixel grid.

    Args:
        dataset: Open source raster with an invertible affine transform.
        projected_geometries: Polygonal geometries in the source raster CRS.

    Returns:
        Integer source-pixel window containing every projected polygon.

    Raises:
        NoRasterBoundsOverlapError: If the envelope misses the raster grid.
        TypeError: If a projected polygon mapping is malformed.
    """
    projected_positions = [
        position
        for geometry in projected_geometries
        for ring in _polygon_rings(geometry)
        for position in ring
    ]
    inverse_transform = ~dataset.transform
    pixel_positions = tuple(
        inverse_transform * position for position in projected_positions
    )
    padding = BOUNDED_SOURCE_WINDOW_PADDING_PIXELS
    column_start = max(
        0,
        math.floor(min(point[0] for point in pixel_positions)) - padding,
    )
    row_start = max(
        0,
        math.floor(min(point[1] for point in pixel_positions)) - padding,
    )
    column_stop = min(
        dataset.width,
        math.ceil(max(point[0] for point in pixel_positions)) + padding,
    )
    row_stop = min(
        dataset.height,
        math.ceil(max(point[1] for point in pixel_positions)) + padding,
    )
    if column_start >= column_stop or row_start >= row_stop:
        raise NoRasterBoundsOverlapError
    return Window(
        column_start,
        row_start,
        column_stop - column_start,
        row_stop - row_start,
    )


def selected_raster_area_for_wgs84_polygons(
    dataset: rasterio.io.DatasetReader,
    geometries: tuple[dict[str, object], ...],
    maximum_coordinates: int,
    coordinate_transform: Callable[..., tuple[list[float], list[float]]] = transform,
) -> SelectedRasterArea:
    """Project and bound an immutable polygonal selection for one raster grid.

    Every polygon edge is densified under a fixed transformed-coordinate
    ceiling before explicit longitude/latitude transformation. The resulting
    Polygon and MultiPolygon mappings remain separate; ``geometry_mask`` unions
    them so overlaps can never count a grid cell twice.

    Args:
        dataset: Open source raster with a coordinate reference system.
        geometries: Validated polygonal WGS 84 GeoJSON values.
        maximum_coordinates: Hard transformation capacity owned by the caller.
        coordinate_transform: Injectable CRS transformation mechanism.

    Returns:
        Projected polygonal geometry and clipped source-pixel envelope.

    Raises:
        NoRasterBoundsOverlapError: If the AOI envelope misses the raster.
        ValueError: If transformation produces a non-finite position or exceeds
            the explicit transformed-geometry ceiling.
        TypeError: If immutable geometry violates its owned contract.
    """
    geometry_ring_groups: list[
        tuple[str, tuple[tuple[tuple[float, float], ...], ...]]
    ] = []
    all_rings: list[tuple[tuple[float, float], ...]] = []
    for geometry in geometries:
        rings = _polygon_rings(geometry)
        geometry_ring_groups.append((str(geometry["type"]), rings))
        all_rings.extend(rings)
    densified_rings = _densify_polygon_rings(tuple(all_rings), maximum_coordinates)
    longitudes = [point[0] for ring in densified_rings for point in ring]
    latitudes = [point[1] for ring in densified_rings for point in ring]
    projected_x, projected_y = coordinate_transform(
        "EPSG:4326",
        dataset.crs,
        longitudes,
        latitudes,
    )
    projected_positions = tuple(zip(projected_x, projected_y, strict=True))
    if not all(
        math.isfinite(ordinate)
        for position in projected_positions
        for ordinate in position
    ):
        raise ValueError("Selection could not be projected")

    projected_rings: list[tuple[tuple[float, float], ...]] = []
    position_index = 0
    for ring in densified_rings:
        projected_rings.append(
            projected_positions[position_index:position_index + len(ring)]
        )
        position_index += len(ring)

    projected_geometries: list[dict[str, object]] = []
    ring_index = 0
    for geometry_type, source_rings in geometry_ring_groups:
        ring_counts = []
        if geometry_type == "Polygon":
            ring_counts = [len(source_rings)]
        else:
            source_geometry = geometries[len(projected_geometries)]
            coordinates = source_geometry["coordinates"]
            if not isinstance(coordinates, (list, tuple)):
                raise TypeError("Selection MultiPolygon is malformed")
            ring_counts = [len(polygon) for polygon in coordinates]
        polygons = []
        for ring_count in ring_counts:
            polygon_rings = projected_rings[ring_index:ring_index + ring_count]
            ring_index += ring_count
            polygons.append(polygon_rings)
        projected_geometries.append({
            "type": geometry_type,
            "coordinates": polygons[0] if geometry_type == "Polygon" else polygons,
        })

    projected_tuple = tuple(projected_geometries)
    return SelectedRasterArea(
        source_window=_source_window_for_projected_geometries(
            dataset,
            projected_tuple,
        ),
        projected_geometries=projected_tuple,
    )
