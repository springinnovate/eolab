"""Neutral WGS 84 selection-to-source-window mechanisms."""

import math
from collections.abc import Callable, Sequence
from functools import lru_cache
from typing import cast

from affine import Affine
import numpy as np
from pyproj import CRS as ProjCRS
from pyproj import Transformer
from rasterio.crs import CRS
from rasterio.warp import transform, transform_geom
from rasterio.windows import Window

from eolab_app.sampling_box import (
    Wgs84SamplingBox,
    sampling_box_bounds,
    tessellate_sampling_box,
)
from eolab_app.raster.models import CanonicalWgs84Bounds, SelectedRasterArea
from eolab_app.raster.reader import RasterDataset
from eolab_app.raster.temporal import TemporalRasterDataset

BOUNDED_WGS84_DENSIFY_POINTS = 21
BOUNDED_SOURCE_WINDOW_PADDING_PIXELS = 1
SAMPLING_BOX_MAXIMUM_ERROR_PIXELS = 0.01
POLYGON_EDGE_ERROR_PIXELS = 0.0001


class NoRasterBoundsOverlapError(ValueError):
    """Raised when a selected WGS 84 area misses a raster source grid."""


@lru_cache(maxsize=64)
def _longitude_frame(crs: CRS | str) -> tuple[float, float] | None:
    """Describe the angular unit and longitude origin of a geographic CRS.

    Args:
        crs: Native or geographic selection coordinate system.

    Returns:
        Signed radians per longitude unit and prime meridian in radians east of
        Greenwich, or None for projected coordinates.
    """
    system = ProjCRS(crs)
    if not system.is_geographic:
        return None
    axis = next(axis for axis in system.axis_info if axis.direction in {"east", "west"})
    unit = axis.unit_conversion_factor * (1 if axis.direction == "east" else -1)
    meridian = system.prime_meridian
    return unit, meridian.longitude * meridian.unit_conversion_factor


def _transform_polygon_positions(
    source_crs: CRS | str,
    target_crs: CRS | str,
    x: list[float],
    y: list[float],
    coordinate_transform: Callable[..., tuple[list[float], list[float]]],
) -> tuple[list[float], list[float]]:
    """Project vertices while retaining the source longitude branch across meridians.

    Args:
        source_crs: Coordinate system in which each input edge is defined.
        target_crs: Raster coordinate system.
        x: Source x coordinates.
        y: Corresponding source y coordinates.
        coordinate_transform: Projection that supplies the actual target positions.

    Returns:
        Projected x and y. Between geographic systems, each longitude is moved
        by complete turns when both longitudes refer to ordinary meridians.
        Derived geographic coordinates, such as rotated poles, use the full
        coordinate operation because their longitudes also depend on latitude.
    """
    tx, ty = coordinate_transform(source_crs, target_crs, x, y)
    target = _longitude_frame(target_crs)
    if target is None or source_crs == target_crs:
        return tx, ty
    source = _longitude_frame(source_crs)
    if (
        source is not None
        and not ProjCRS(source_crs).is_derived
        and not ProjCRS(target_crs).is_derived
    ):
        period = math.tau / abs(target[0])
        for index, (original, projected) in enumerate(zip(x, tx, strict=True)):
            if math.isfinite(projected):
                reference = (original * source[0] + source[1] - target[1]) / target[0]
                tx[index] = projected + round((reference - projected) / period) * period
    return tx, ty


def get_longitude_wrap_width(dataset: RasterDataset) -> float | None:
    """Return the longitude shift that maps back to the same raster columns.

    For example, shifting longitude by 360 degrees returns to the same column
    on a global grid. Window selection, polygon masks and paired reads share
    this decision so they handle the east/west edge consistently.

    Args:
        dataset: Open source raster with its admitted grid.

    Returns:
        One full grid width in the source CRS's angular units (360 degrees
        for a global longitude grid), or None when this raster does not wrap
        across its east/west edge.
    """
    if (
        isinstance(dataset, TemporalRasterDataset)
        and dataset.cyclic_x
        and dataset.crs.is_geographic
    ):
        return abs(dataset.transform.a * dataset.width)
    return None


def prepare_raster_for_wgs84_bounds(
    dataset: RasterDataset, selected_bounds: CanonicalWgs84Bounds
) -> None:
    """Place a cyclic raster's column seam outside the requested area.

    The first bounds supplied to an open read handle choose its grid origin.
    Later polygon masks retain that view. Interior and full-period selections
    keep the original grid; other origins align with existing logical blocks.
    Every source column occurs once. Ordinary and noncyclic rasters are unchanged.

    Args:
        dataset: Open source, before window or sample plans have been made.
        selected_bounds: Canonical WGS84 rectangle covering the selection.
    """
    if get_longitude_wrap_width(dataset) is None:
        return
    ring = densified_wgs84_bounds_ring(selected_bounds)
    x, y = _transform_polygon_positions(
        "EPSG:4326",
        dataset.crs,
        [point[0] for point in ring],
        [point[1] for point in ring],
        transform,
    )
    inverse = ~dataset.transform
    columns = [(inverse * point)[0] for point in zip(x, y)]
    left, right = min(columns), max(columns)
    padding = BOUNDED_SOURCE_WINDOW_PADDING_PIXELS
    if (
        left >= padding
        and right <= dataset.width - padding
        or right - left >= dataset.width
    ):
        first_column = 0
    else:
        block_width = dataset.block_shapes[0][1]
        first_column = (math.floor(left) - padding) // block_width * block_width
    cast(TemporalRasterDataset, dataset).prepare_column_view(first_column)


def _periodic_polygon_copies(
    dataset: RasterDataset,
    geometries: tuple[dict[str, object], ...],
    maximum_output_coordinates: int | None,
) -> tuple[dict[str, object], ...]:
    """Place equivalent polygon longitudes over the raster's existing coverage.

    Native geographic rasters keep their original grid, including regional
    grids crossing the date line and grids using positive longitudes. Temporal
    rasters retain their admitted cyclic or noncyclic longitude policy.

    Args:
        dataset: Open source whose native grid or temporal column view is fixed.
        geometries: Projected Polygon or MultiPolygon mappings.
        maximum_output_coordinates: Coordinate capacity including translated
            copies, or None for caller-supervised unlimited geometry.

    Returns:
        Polygons translated by complete longitude periods where they meet the
        grid. A polygon with no overlapping longitude copy is retained outside
        the grid so callers can report an ordinary no-overlap result.
        Rasterizing the union includes overlapping cell portions once.

    Raises:
        ValueError: If periodic copies exceed the caller's coordinate capacity.
    """
    period = get_longitude_wrap_width(dataset)
    if (
        period is None
        and not isinstance(dataset, TemporalRasterDataset)
        and dataset.crs.is_geographic
    ):
        unit, _ = _longitude_frame(dataset.crs)
        period = math.tau / abs(unit)
    if period is None:
        return geometries
    grid_left, grid_right = sorted((dataset.bounds.left, dataset.bounds.right))
    copies: list[dict[str, object]] = []
    output_coordinates = 0
    for geometry in geometries:
        longitudes = [point[0] for ring in _polygon_rings(geometry) for point in ring]
        left, right = min(longitudes), max(longitudes)
        first = math.floor((grid_left - right) / period) + 1
        last = math.ceil((grid_right - left) / period) - 1
        shifts = range(first, last + 1) if first <= last else range(1)
        if geometry["type"] == "Polygon":
            polygons = (
                cast(Sequence[Sequence[tuple[float, float]]], geometry["coordinates"]),
            )
        else:
            polygons = cast(
                Sequence[Sequence[Sequence[tuple[float, float]]]],
                geometry["coordinates"],
            )
        for shift in shifts:
            offset = shift * period
            output_coordinates += len(longitudes)
            if (
                maximum_output_coordinates is not None
                and output_coordinates > maximum_output_coordinates
            ):
                raise ValueError(
                    "Periodic polygons exceed the projected-coordinate limit"
                )
            if offset == 0:
                copies.append(geometry)
                continue
            translated = [
                [[(x + offset, y) for x, y in ring] for ring in polygon]
                for polygon in polygons
            ]
            copies.append(
                {
                    "type": geometry["type"],
                    "coordinates": (
                        translated[0] if geometry["type"] == "Polygon" else translated
                    ),
                }
            )
    return tuple(copies)


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
    dataset: RasterDataset,
    selected_bounds: CanonicalWgs84Bounds,
    coordinate_transform: Callable[..., tuple[list[float], list[float]]] = transform,
    *,
    maximum_output_coordinates: int | None = None,
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
        maximum_output_coordinates: Caller budget for longitude copies of the
            rectangle, or None for unlimited Processing reads.

    Returns:
        Projected selection polygon and integer source-pixel envelope.

    Raises:
        NoRasterBoundsOverlapError: If the selection misses the raster.
        ValueError: If the bounds cannot be transformed to the raster CRS.
    """
    prepare_raster_for_wgs84_bounds(dataset, selected_bounds)
    wgs84_ring = densified_wgs84_bounds_ring(selected_bounds)
    projected_x, projected_y = _transform_polygon_positions(
        "EPSG:4326",
        dataset.crs,
        [coordinate[0] for coordinate in wgs84_ring],
        [coordinate[1] for coordinate in wgs84_ring],
        coordinate_transform,
    )
    projected_ring = tuple(zip(projected_x, projected_y, strict=True))
    if not all(
        math.isfinite(coordinate) for point in projected_ring for coordinate in point
    ):
        raise ValueError("Selected bounds could not be projected")

    geometries = _periodic_polygon_copies(
        dataset,
        ({"type": "Polygon", "coordinates": [projected_ring]},),
        maximum_output_coordinates,
    )
    return SelectedRasterArea(
        source_window=_source_window_for_projected_geometries(dataset, geometries),
        projected_geometries=geometries,
    )


def selected_raster_area_for_sampling_box(
    dataset: RasterDataset,
    sampling_box: Wgs84SamplingBox,
    maximum_coordinates: int | None,
    coordinate_transform: Callable[..., tuple[list[float], list[float]]] = transform,
) -> SelectedRasterArea:
    """Project a geodesic box within one hundredth of a native pixel.

    The inverse affine measures error in actual raster pixels, including rotated
    or anisotropic grids. Existing polygon inclusion and window mechanisms then
    receive this read-local ring; no geometry is stored with the descriptor.

    Args:
        dataset: Open georeferenced raster with its admitted grid.
        sampling_box: Boundary-validated center and kilometer side length.
        maximum_coordinates: Interactive projection capacity, or None for Processing.
        coordinate_transform: Injectable WGS84-to-source CRS transformation.

    Returns:
        Projected polygon and its clipped, padded native-pixel window.

    Raises:
        NoRasterBoundsOverlapError: If the polygon misses the raster.
        ValueError: If projection, convergence or coordinate capacity fails.
    """
    prepare_raster_for_wgs84_bounds(dataset, sampling_box_bounds(sampling_box))
    inverse = ~dataset.transform
    projected_positions: dict[tuple[float, float], tuple[float, float]] = {}

    def project_pixels(
        positions: tuple[tuple[float, float], ...],
    ) -> tuple[tuple[float, float], ...]:
        """Return source-pixel positions for measuring geodesic chord error.

        Args:
            positions: WGS84 positions selected by adaptive subdivision.

        Returns:
            Floating native columns and rows in the same order.
        """
        x, y = _transform_polygon_positions(
            "EPSG:4326",
            dataset.crs,
            [point[0] for point in positions],
            [point[1] for point in positions],
            coordinate_transform,
        )
        projected = tuple(zip(x, y, strict=True))
        projected_positions.update(zip(positions, projected, strict=True))
        return tuple(inverse * point for point in projected)

    ring = tessellate_sampling_box(
        sampling_box,
        project_pixels,
        maximum_error_pixels=SAMPLING_BOX_MAXIMUM_ERROR_PIXELS,
        maximum_coordinates=maximum_coordinates,
    )
    projected_ring = tuple(projected_positions[point] for point in ring)
    geometries = _periodic_polygon_copies(
        dataset,
        ({"type": "Polygon", "coordinates": [projected_ring]},),
        maximum_coordinates,
    )
    return SelectedRasterArea(
        source_window=_source_window_for_projected_geometries(dataset, geometries),
        projected_geometries=geometries,
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
    maximum_coordinates: int | None,
    initial_edge_points: int,
) -> tuple[tuple[tuple[float, float], ...], ...]:
    """Densify polygon edges without exceeding transformed-coordinate capacity.

    Args:
        rings: Validated closed polygon rings in their source coordinate system.
        maximum_coordinates: Hard limit on all transformed positions.
        initial_edge_points: Requested number of intermediate samples per edge.

    Returns:
        Rings with a bounded number of evenly spaced edge positions.

    Raises:
        ValueError: If source rings already exceed transformation capacity.
    """
    segment_count = sum(max(0, len(ring) - 1) for ring in rings)
    if segment_count < 1:
        raise ValueError("Selection has no polygon edges")
    if (
        maximum_coordinates is not None
        and segment_count + len(rings) > maximum_coordinates
    ):
        raise ValueError("Selection exceeds the transformed-geometry limit")
    densify_points = (
        initial_edge_points
        if maximum_coordinates is None
        else min(
            initial_edge_points,
            max(
                0,
                (maximum_coordinates - len(rings)) // segment_count - 1,
            ),
        )
    )
    denominator = densify_points + 1
    densified: list[tuple[tuple[float, float], ...]] = []
    for ring in rings:
        result = [ring[0]]
        for start, end in zip(ring, ring[1:]):
            for step in range(1, denominator):
                fraction = step / denominator
                result.append(
                    (
                        start[0] + (end[0] - start[0]) * fraction,
                        start[1] + (end[1] - start[1]) * fraction,
                    )
                )
            result.append(end)
        densified.append(tuple(result))
    return tuple(densified)


@lru_cache(maxsize=64)
def _edge_transformer(source_crs: CRS | str, target_crs: CRS | str) -> Transformer:
    """Get the continuous-longitude operation for measuring projected edge curvature.

    Args:
        source_crs: CRS in which polygon edges are straight.
        target_crs: CRS in which chord error is measured.

    Returns:
        A reusable x/y transformer accepting longitudes beyond a single turn.
    """
    return Transformer.from_crs(source_crs, target_crs, always_xy=True, force_over=True)


def _refine_raster_rings(
    rings: tuple[tuple[tuple[float, float], ...], ...],
    source_crs: CRS | str,
    target_crs: CRS | str,
    grid_transform: Affine,
    maximum_coordinates: int | None,
    maximum_error: float,
    maximum_segment: float,
    longitude_period: float | None,
) -> tuple[tuple[tuple[float, float], ...], ...]:
    """Bisect native edges whose projected quarter points deviate from the pixel chord.

    Args:
        rings: Closed rings sampled on their original straight edges.
        source_crs: Coordinate system of the input positions.
        target_crs: Destination grid's coordinate system.
        grid_transform: Pixel-to-map affine, including rotation and skew.
        maximum_coordinates: Maximum retained positions across the rings, or None.
        maximum_error: Maximum chord deviation measured in grid units.
        maximum_segment: Maximum chord length in grid units, or infinity.
        longitude_period: Full longitude turn in destination x units for a
            cylindrical projection. Geographic CRSs supply their own period.

    Returns:
        Source-coordinate rings refined to the destination pixel tolerance.

    Raises:
        ValueError: If projection, numerical convergence or coordinate capacity fails.
    """
    if math.isinf(maximum_segment) and CRS.from_user_input(
        source_crs
    ) == CRS.from_user_input(target_crs):
        return rings
    transformer = _edge_transformer(source_crs, target_crs)
    frame = _longitude_frame(target_crs)
    period = math.tau / abs(frame[0]) if frame is not None else longitude_period
    inverse = ~grid_transform
    to_pixels = np.array([[inverse.a, inverse.d], [inverse.b, inverse.e]])
    fractions = np.array([0, 0.25, 0.5, 0.75, 1])[None, :, None]
    count = sum(map(len, rings))
    refined = []
    for ring in rings:
        points = np.asarray(ring)
        while True:
            split = np.zeros(len(points) - 1, dtype=bool)
            # Limit transient probe arrays even for an unlimited Processing job.
            for start in range(0, len(split), 4096):
                edges = points[start : start + 4097]
                probes = (
                    edges[:-1, None, :] + np.diff(edges, axis=0)[:, None, :] * fractions
                )
                x, y = transformer.transform(probes[:, :, 0], probes[:, :, 1])
                if period is not None:
                    x = np.unwrap(x, period=period, axis=1)
                mapped = np.stack((x, y), axis=-1)
                if not np.isfinite(mapped).all():
                    raise ValueError("Selection could not be projected")
                relative = (mapped[:, 1:, :] - mapped[:, :1, :]) @ to_pixels
                chord = relative[:, -1:, :]
                tested = relative[:, :-1, :]
                length_squared = np.sum(chord * chord, axis=2)
                along = np.clip(
                    np.sum(tested * chord, axis=2) / np.maximum(length_squared, 1e-30),
                    0,
                    1,
                )
                error = np.linalg.norm(tested - along[:, :, None] * chord, axis=2)
                split[start : start + len(edges) - 1] = np.any(
                    error > maximum_error, axis=1
                ) | (length_squared[:, 0] > maximum_segment**2)
            if not split.any():
                break
            count += int(split.sum())
            if maximum_coordinates is not None and count > maximum_coordinates:
                raise ValueError("Selection exceeds the transformed-geometry limit")
            left, right = points[:-1][split], points[1:][split]
            middle = left + (right - left) / 2
            if np.any(np.all(middle == left, axis=1) | np.all(middle == right, axis=1)):
                raise ValueError("Selection edge accuracy did not converge")
            offsets = np.concatenate(([0], np.cumsum(1 + split)))
            next_points = np.empty((offsets[-1] + 1, 2))
            next_points[offsets] = points
            next_points[offsets[:-1][split] + 1] = middle
            points = next_points
        refined.append(tuple(map(tuple, points.tolist())))
    return tuple(refined)


def _source_window_for_projected_geometries(
    dataset: RasterDataset,
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


def project_raster_polygons(
    dataset: RasterDataset,
    geometries: tuple[dict[str, object], ...],
    maximum_coordinates: int | None,
    coordinate_transform: Callable[..., tuple[list[float], list[float]]] = transform,
    *,
    source_crs: CRS | str = "EPSG:4326",
    maximum_output_coordinates: int | None,
    initial_edge_points: int = BOUNDED_WGS84_DENSIFY_POINTS,
) -> tuple[dict[str, object], ...]:
    """Project bounded polygons without clipping their source-pixel envelope.

    Native edges are refined to pixel accuracy before polygon projection.
    Rasterizing the resulting polygon union counts overlapping cells once.

    Args:
        dataset: Open source raster with a coordinate reference system.
        geometries: Validated polygon coordinates in their original CRS.
        maximum_coordinates: Hard transformation capacity owned by the caller.
        coordinate_transform: Injectable CRS transformation mechanism.
        source_crs: CRS in which the input edges are straight.
        maximum_output_coordinates: Output-coordinate capacity including periodic
            copies, or None when the caller permits unlimited geometry.
        initial_edge_points: Initial intermediate samples per original edge.

    Returns:
        Projected polygonal geometries, including those outside the raster.

    Raises:
        ValueError: If transformation produces a non-finite position or exceeds
            the explicit transformed-geometry ceiling.
        TypeError: If immutable geometry violates its owned contract.
    """
    return _periodic_polygon_copies(
        dataset,
        project_polygons_to_crs(
            source_crs,
            dataset.crs,
            geometries,
            maximum_coordinates,
            coordinate_transform,
            grid_transform=dataset.transform,
            initial_edge_points=initial_edge_points,
        ),
        maximum_output_coordinates,
    )


def _with_polygon_rings(
    geometries: tuple[dict[str, object], ...],
    rings: Sequence[Sequence[tuple[float, float]]],
) -> tuple[dict[str, object], ...]:
    """Replace rings in traversal order while preserving holes and multipart grouping.

    Args:
        geometries: Polygonal mappings defining the nesting of the rings.
        rings: Replacement closed rings in the same order.

    Returns:
        GeoJSON mappings with the replacement coordinates.
    """
    positions = iter(rings)
    result = []
    for geometry in geometries:
        coordinates = cast(Sequence[Sequence[object]], geometry["coordinates"])
        single = geometry["type"] == "Polygon"
        polygons = [
            [next(positions) for _ in polygon]
            for polygon in ([coordinates] if single else coordinates)
        ]
        result.append(
            {
                "type": geometry["type"],
                "coordinates": polygons[0] if single else polygons,
            }
        )
    return tuple(result)


def project_polygons_to_crs(
    source_crs: CRS | str,
    target_crs: CRS | str,
    geometries: tuple[dict[str, object], ...],
    maximum_coordinates: int | None,
    coordinate_transform: Callable[..., tuple[list[float], list[float]]] = transform,
    *,
    grid_transform: Affine | None = None,
    initial_edge_points: int = BOUNDED_WGS84_DENSIFY_POINTS,
    maximum_error: float = POLYGON_EDGE_ERROR_PIXELS,
    maximum_segment: float = math.inf,
    longitude_period: float | None = None,
) -> tuple[dict[str, object], ...]:
    """Densify and project polygons without depending on raster coverage.

    Args:
        source_crs: Coordinate system of the supplied polygons.
        target_crs: Validated destination coordinate system.
        geometries: Validated Polygon or MultiPolygon mappings in source_crs.
        maximum_coordinates: Transformed-coordinate ceiling, or None for
            caller-supervised unlimited geometry.
        coordinate_transform: Injectable transformation between coordinate systems.
        grid_transform: If given, refine projected chords to destination pixel accuracy.
        initial_edge_points: Initial intermediate samples per original edge.
        maximum_error: Chord deviation in grid units when a grid is given.
        maximum_segment: Maximum chord length on that grid, or infinity.
        longitude_period: Full turn in destination x units for a cylindrical
            accuracy grid. Used only to measure chords across a longitude cut.

    Returns:
        Separate polygon mappings in the requested CRS, preserving holes and
        all geometry outside any particular source raster's footprint.

    Raises:
        ValueError: If coordinates cannot be projected or exceed the ceiling.
        TypeError: If the geometry violates the polygon input contract.
    """
    all_rings = tuple(
        ring for geometry in geometries for ring in _polygon_rings(geometry)
    )
    densified_rings = _densify_polygon_rings(
        all_rings, maximum_coordinates, initial_edge_points
    )
    if grid_transform is not None:
        densified_rings = _refine_raster_rings(
            densified_rings,
            source_crs,
            target_crs,
            grid_transform,
            maximum_coordinates,
            maximum_error,
            maximum_segment,
            longitude_period,
        )
    if CRS.from_user_input(source_crs).is_projected and source_crs != target_crs:
        # GDAL cuts whole polygons at the antimeridian and reconstructs polar
        # interiors, including holes. A longitude chosen per vertex cannot do that.
        geometries = tuple(
            transform_geom(
                source_crs,
                "EPSG:4326",
                _with_polygon_rings(geometries, densified_rings),
            )
        )
        source_crs = "EPSG:4326"
        densified_rings = tuple(
            ring for geometry in geometries for ring in _polygon_rings(geometry)
        )
        if (
            maximum_coordinates is not None
            and sum(map(len, densified_rings)) > maximum_coordinates
        ):
            raise ValueError("Selection exceeds the transformed-geometry limit")
    x = [point[0] for ring in densified_rings for point in ring]
    y = [point[1] for ring in densified_rings for point in ring]
    projected_x, projected_y = _transform_polygon_positions(
        source_crs,
        target_crs,
        x,
        y,
        coordinate_transform,
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
            projected_positions[position_index : position_index + len(ring)]
        )
        position_index += len(ring)

    return _with_polygon_rings(geometries, projected_rings)


def selected_raster_area_for_wgs84_polygons(
    dataset: RasterDataset,
    geometries: tuple[dict[str, object], ...],
    maximum_coordinates: int | None,
    coordinate_transform: Callable[..., tuple[list[float], list[float]]] = transform,
    *,
    selected_bounds: CanonicalWgs84Bounds | None = None,
) -> SelectedRasterArea:
    """Project a bounded polygon union and clip its complete envelope to a raster.

    Choose the cyclic column view before projecting periodic polygon copies.
    A view already chosen by an earlier selection keeps ownership of the grid.

    Args:
        dataset: Open georeferenced raster.
        geometries: Validated exact polygonal WGS84 mappings.
        maximum_coordinates: Caller-owned transformed-coordinate capacity.
        coordinate_transform: Injectable longitude/latitude transformation.
        selected_bounds: Existing WGS84 envelope of the polygon union, when the
            caller has one; otherwise derive it from the supplied coordinates.

    Returns:
        Projected polygons and their padded integral source window.

    Raises:
        NoRasterBoundsOverlapError: If the complete envelope misses the raster.
        ValueError: If projection fails or exceeds coordinate capacity.
        TypeError: If a polygon mapping is malformed.
    """
    if get_longitude_wrap_width(dataset) is not None:
        if selected_bounds is None:
            positions = [
                point
                for geometry in geometries
                for ring in _polygon_rings(geometry)
                for point in ring
            ]
            selected_bounds = (
                min(point[0] for point in positions),
                min(point[1] for point in positions),
                max(point[0] for point in positions),
                max(point[1] for point in positions),
            )
        prepare_raster_for_wgs84_bounds(dataset, selected_bounds)
    projected_tuple = project_raster_polygons(
        dataset,
        geometries,
        maximum_coordinates,
        coordinate_transform,
        maximum_output_coordinates=maximum_coordinates,
    )
    return SelectedRasterArea(
        source_window=_source_window_for_projected_geometries(
            dataset,
            projected_tuple,
        ),
        projected_geometries=projected_tuple,
    )
