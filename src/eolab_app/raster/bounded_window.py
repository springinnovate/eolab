"""Neutral WGS 84 selection-to-source-window mechanisms."""

import math
from collections.abc import Callable, Sequence
from functools import lru_cache
from typing import cast

from pyproj import Transformer
from pyproj.exceptions import ProjError
from rasterio.crs import CRS
from rasterio.warp import transform
from rasterio.windows import Window
from shapely import from_wkb, union_all
from shapely.affinity import scale
from shapely.errors import GEOSException
from shapely.geometry import LinearRing, Point, Polygon, mapping, shape
from shapely.geometry.base import BaseGeometry

from eolab_app.projected_boundary import (
    Position,
    ProjectPositions,
    tessellate_projected_ring,
)
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
POLYGON_BOUNDARY_MAXIMUM_ERROR_PIXELS = 0.001


class NoRasterBoundsOverlapError(ValueError):
    """Raised when a selected WGS 84 area misses a raster source grid."""


@lru_cache(maxsize=8)
def _grid_transformer(source: CRS, target: CRS, *, unwrap: bool) -> Transformer:
    """Return a PROJ boundary transform with explicit prime-meridian units.

    Args:
        source: Coordinate system of the original boundary.
        target: Coordinate system of the grid being tested.
        unwrap: Keep longitudes continuous across the target antimeridian.

    Returns:
        A cached transformer in conventional x/y order.

    Raises:
        ValueError: If PROJ cannot create the coordinate operation.
    """
    try:
        return Transformer.from_crs(
            source.to_wkt(version="WKT2_2019"),
            target.to_wkt(version="WKT2_2019"),
            always_xy=True,
            force_over=unwrap,
        )
    except ProjError as error:
        raise ValueError("Selection could not be projected") from error


def grid_boundary_projection(source: CRS | str, target: CRS) -> ProjectPositions:
    """Return the PROJ operation used to refine a boundary in the target grid.

    Geographic targets use continuous longitudes for edge refinement. Their
    final geometry can then be split at the antimeridian by GDAL. Projected
    targets use their normal coordinate domain; the boundary refinement checks
    continuity so a cut cannot become a chord through the wrong area.

    Args:
        source: CRS in which the original boundary edges are defined.
        target: CRS of the calculation grid.

    Returns:
        Batch callback returning target positions for boundary accuracy tests.

    Raises:
        ValueError: If a coordinate operation cannot be created or evaluated.
    """
    source_crs = CRS.from_user_input(source)
    transformer = _grid_transformer(source_crs, target, unwrap=target.is_geographic)

    def project(positions: tuple[Position, ...]) -> tuple[Position, ...]:
        """Project boundary probes through the target coordinate domain.

        Args:
            positions: Nonempty batch of source positions supplied by refinement.

        Returns:
            Target coordinates in the same order as the supplied positions.

        Raises:
            ValueError: If PROJ cannot transform a source position.
        """
        xs, ys = zip(*positions, strict=True)
        try:
            x, y = transformer.transform(xs, ys, errcheck=True)
        except ProjError as error:
            raise ValueError("Selection could not be projected") from error
        return tuple(zip(x, y, strict=True))

    return project


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
    x, y = transform(
        "EPSG:4326",
        dataset.crs,
        [point[0] for point in ring],
        [point[1] for point in ring],
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
    """Place polygon copies inside one cyclic view without repeating its cells.

    Args:
        dataset: Open source whose request-local column view is already chosen.
        geometries: Projected Polygon or MultiPolygon mappings.
        maximum_output_coordinates: Coordinate capacity including translated
            copies, or None for caller-supervised unlimited geometry.

    Returns:
        Polygons translated by complete longitude periods where they meet the
        view. Rasterizing their union includes seam-crossing cell portions once.

    Raises:
        ValueError: If periodic copies exceed the caller's coordinate capacity.
    """
    period = get_longitude_wrap_width(dataset)
    if period is None:
        return geometries
    copies: list[dict[str, object]] = []
    output_coordinates = 0
    for geometry in geometries:
        longitudes = [point[0] for ring in _polygon_rings(geometry) for point in ring]
        left, right = min(longitudes), max(longitudes)
        first = math.ceil((dataset.bounds.left - right) / period)
        last = math.floor((dataset.bounds.right - left) / period)
        if geometry["type"] == "Polygon":
            polygons = (
                cast(Sequence[Sequence[tuple[float, float]]], geometry["coordinates"]),
            )
        else:
            polygons = cast(
                Sequence[Sequence[Sequence[tuple[float, float]]]],
                geometry["coordinates"],
            )
        for shift in range(first, last + 1):
            offset = shift * period
            if (
                right + offset <= dataset.bounds.left
                or left + offset >= dataset.bounds.right
            ):
                continue
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
    prepare_raster_for_wgs84_bounds(dataset, selected_bounds)
    wgs84_ring = densified_wgs84_bounds_ring(selected_bounds)
    projected_x, projected_y = coordinate_transform(
        "EPSG:4326",
        dataset.crs,
        [coordinate[0] for coordinate in wgs84_ring],
        [coordinate[1] for coordinate in wgs84_ring],
    )
    projected_ring = tuple(zip(projected_x, projected_y, strict=True))
    if not all(
        math.isfinite(coordinate) for point in projected_ring for coordinate in point
    ):
        raise ValueError("Selected bounds could not be projected")

    geometries = _periodic_polygon_copies(
        dataset,
        ({"type": "Polygon", "coordinates": [projected_ring]},),
        2 * len(projected_ring),
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
        x, y = coordinate_transform(
            "EPSG:4326",
            dataset.crs,
            [point[0] for point in positions],
            [point[1] for point in positions],
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
) -> tuple[tuple[tuple[float, float], ...], ...]:
    """Densify polygon edges without exceeding transformed-coordinate capacity.

    Args:
        rings: Validated closed polygon rings in their source coordinate system.
        maximum_coordinates: Hard limit on all transformed positions.

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
        BOUNDED_WGS84_DENSIFY_POINTS
        if maximum_coordinates is None
        else min(
            BOUNDED_WGS84_DENSIFY_POINTS,
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
            for step in range(1, denominator + 1):
                fraction = step / denominator
                result.append(
                    (
                        start[0] + (end[0] - start[0]) * fraction,
                        start[1] + (end[1] - start[1]) * fraction,
                    )
                )
        densified.append(tuple(result))
    return tuple(densified)


def _refine_polygon_rings(
    rings: tuple[tuple[Position, ...], ...],
    source_crs: CRS | str,
    target_crs: CRS,
    pixel_size: tuple[float, float],
    maximum_coordinates: int | None,
) -> tuple[tuple[Position, ...], ...]:
    """Subdivide straight edges to the polygon tolerance in destination pixels.

    Args:
        rings: Closed polygon rings in the source CRS.
        source_crs: Coordinate system of the original edges.
        target_crs: Coordinate system in which the polygons will be rasterized.
        pixel_size: Positive target X and Y pixel sizes.
        maximum_coordinates: Capacity for derived positions, or None for unlimited work.

    Returns:
        Rings with source positions added where the projected edges curve.

    Raises:
        ValueError: If projection, convergence, or coordinate capacity fails.
    """
    x_size, y_size = pixel_size

    refined = []
    remaining_coordinates = maximum_coordinates
    for ring in rings:
        project = grid_boundary_projection(source_crs, target_crs)

        def project_pixels(positions: tuple[Position, ...]) -> tuple[Position, ...]:
            """Transform this ring's probes to target pixels for chord tests."""
            return tuple((x / x_size, y / y_size) for x, y in project(positions))

        boundary = tessellate_projected_ring(
            ring,
            project_pixels,
            maximum_error_pixels=POLYGON_BOUNDARY_MAXIMUM_ERROR_PIXELS,
            maximum_coordinates=remaining_coordinates,
            check_continuity=target_crs.is_projected,
        )
        refined.append(boundary)
        if remaining_coordinates is not None:
            remaining_coordinates -= len(boundary)
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


def project_wgs84_polygons(
    dataset: RasterDataset,
    geometries: tuple[dict[str, object], ...],
    maximum_coordinates: int | None,
    coordinate_transform: Callable[..., tuple[list[float], list[float]]] = transform,
    *,
    maximum_output_coordinates: int | None,
) -> tuple[dict[str, object], ...]:
    """Project bounded polygons without clipping their source-pixel envelope.

    Every polygon edge is densified under a fixed transformed-coordinate
    ceiling before explicit longitude/latitude transformation. The resulting
    Polygon and MultiPolygon mappings remain separate; ``geometry_mask`` unions
    them so overlaps can never count a grid cell twice.

    Args:
        dataset: Open source raster with a coordinate reference system.
        geometries: Validated polygonal WGS 84 GeoJSON values.
        maximum_coordinates: Hard transformation capacity owned by the caller.
        coordinate_transform: Injectable CRS transformation mechanism.
        maximum_output_coordinates: Output-coordinate capacity including periodic
            copies, or None when the caller permits unlimited geometry.

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
            "EPSG:4326",
            dataset.crs,
            geometries,
            maximum_coordinates,
            coordinate_transform,
        ),
        maximum_output_coordinates,
    )


def project_geographic_polygons(
    source_crs: CRS | str,
    target_crs: CRS,
    geometries: tuple[dict[str, object], ...],
) -> tuple[dict[str, object], ...]:
    """Return geographic polygons with split seams and preserved holes.

    Restore the geographic target's angular units after splitting. The temporary
    degree CRS retains its datum and prime meridian; source edges must already
    be refined to the caller's accuracy before this final transformation. Split
    rings independently so a hole enclosing a pole remains separate from its
    shell. For a projected ring enclosing a pole on another datum, apply the
    datum operation first, then let GDAL cut the cap on that datum's polar plane.
    GEOS subtracts each part's holes before joining the resulting parts.

    Args:
        source_crs: Coordinate system of the refined source polygons.
        target_crs: Geographic output coordinate system, in any angular unit.
        geometries: Refined polygons, including their holes.

    Returns:
        Polygon mappings in target_crs, split at its longitude boundary.

    Raises:
        ValueError: If GDAL cannot transform or split the polygons.
    """
    from osgeo import gdal, ogr, osr

    to_degrees = target_crs.units_factor[1] / math.radians(1)
    uses_degrees = math.isclose(to_degrees, 1, rel_tol=0, abs_tol=1e-12)
    source_wkt = CRS.from_user_input(source_crs).to_wkt(version="WKT2_2019")
    target_wkt = target_crs.to_wkt(version="WKT2_2019")
    projected_geometries: list[dict[str, object]] = []
    try:
        if not uses_degrees:
            with osr.ExceptionMgr():
                degrees = osr.SpatialReference(wkt=target_wkt)
                degrees.SetAngularUnits("degree", math.radians(1))
                target_wkt = degrees.ExportToWkt(["FORMAT=WKT2_2019"])
        with osr.ExceptionMgr():
            source = osr.SpatialReference(wkt=source_wkt)
            target = osr.SpatialReference(wkt=target_wkt)
            source.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
            target.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
            coordinates = osr.CoordinateTransformation(source, target)
            projector = ogr.GeomTransformer(coordinates, ["WRAPDATELINE=YES"])
        target_poles: list[tuple[float, Point]] = []
        if source.IsProjected() and not source.IsSameGeogCS(target):
            # A pole outside the source projection has no location to test.
            with osr.ExceptionMgr(useExceptions=False), gdal.quiet_errors():
                reverse = coordinates.GetInverse()
                if reverse is not None:
                    for latitude in (-90.0, 90.0):
                        x, y, _, _, error = reverse.TransformPointWithErrorCode(
                            0, latitude, 0, 0
                        )
                        if error == 0:
                            target_poles.append((latitude, Point(x, y)))

        def split_ring(ring: LinearRing) -> BaseGeometry:
            """Project one refined ring and cut it at the target's longitude seam.

            Args:
                ring: Exterior or hole in the original coordinate system.

            Returns:
                A valid shell or set of shell pieces in target degrees.

            Raises:
                ValueError: If GDAL cannot produce a valid geographic ring.
                RuntimeError: If a native coordinate operation fails.
            """
            polygon = Polygon(ring)
            native = ogr.CreateGeometryFromWkb(polygon.wkb)
            splitter = projector
            poles = [
                latitude for latitude, point in target_poles if polygon.covers(point)
            ]
            if len(poles) == 1:
                # A datum shift can move the pole away from the source origin.
                # Transform the vertices through the requested datum operation
                # before using a stereographic plane just for GDAL's cap cut.
                with osr.ExceptionMgr(), ogr.ExceptionMgr():
                    polar = target.Clone()
                    polar.SetPS(poles[0], 0, 1, 0, 0)
                    to_polar = osr.CoordinateTransformation(target, polar)
                    native.Transform(coordinates)
                    native.Transform(to_polar)
                    from_polar = to_polar.GetInverse()
                    splitter = ogr.GeomTransformer(from_polar, ["WRAPDATELINE=YES"])
            # GDAL may report a failed intermediate cut and still return a
            # valid final cap. Check the geometry it returns.
            with ogr.ExceptionMgr(useExceptions=False):
                transformed = splitter.Transform(native)
            if transformed is None:
                raise ValueError("Selection could not be projected")
            projected = from_wkb(bytes(transformed.ExportToWkb()))
            if not projected.is_valid:
                raise ValueError("Selection could not be projected")
            return projected

        for geometry in geometries:
            original = shape(geometry)
            polygons = (
                original.geoms if original.geom_type == "MultiPolygon" else (original,)
            )
            parts = []
            for polygon in polygons:
                shell = split_ring(polygon.exterior)
                holes = [split_ring(hole) for hole in polygon.interiors]
                parts.append(shell.difference(union_all(holes)))
            projected = union_all(parts)
            if not uses_degrees:
                projected = scale(
                    projected,
                    xfact=1 / to_degrees,
                    yfact=1 / to_degrees,
                    origin=(0, 0),
                )
            projected_geometries.append(mapping(projected))
    except (RuntimeError, GEOSException) as error:
        raise ValueError("Selection could not be projected") from error
    return tuple(projected_geometries)


def project_polygons_to_crs(
    source_crs: CRS | str,
    target_crs: CRS | str,
    geometries: tuple[dict[str, object], ...],
    maximum_coordinates: int | None,
    coordinate_transform: Callable[..., tuple[list[float], list[float]]] = transform,
    *,
    pixel_size: tuple[float, float] | None = None,
) -> tuple[dict[str, object], ...]:
    """Densify and project polygons without depending on raster coverage.

    Args:
        source_crs: Coordinate system of the supplied polygons.
        target_crs: Validated destination coordinate system.
        geometries: Validated Polygon or MultiPolygon mappings in source_crs.
        maximum_coordinates: Transformed-coordinate ceiling, or None for
            caller-supervised unlimited geometry.
        coordinate_transform: Batch transformation for final projected coordinates.
        pixel_size: Positive X/Y sizes to refine edges to one thousandth of a
            target pixel. Geographic targets split at the antimeridian. Equal
            CRSs retain the original geometry. Omit it for fixed subdivision.

    Returns:
        Separate polygon mappings in the requested CRS, preserving holes and
        all geometry outside any particular source raster's footprint. Refined
        multipart polygons are unioned in projected targets so parts that meet
        after projection form a valid area.

    Raises:
        ValueError: If coordinates cannot be projected or exceed the ceiling.
        BoundaryConvergenceError: If a projected boundary cannot meet the accuracy.
        TypeError: If the geometry violates the polygon input contract.
    """
    geometry_ring_groups: list[
        tuple[str, tuple[tuple[tuple[float, float], ...], ...]]
    ] = []
    all_rings: list[tuple[tuple[float, float], ...]] = []
    for geometry in geometries:
        rings = _polygon_rings(geometry)
        geometry_ring_groups.append((str(geometry["type"]), rings))
        all_rings.extend(rings)
    target = CRS.from_user_input(target_crs)
    split_at_dateline = pixel_size is not None and target.is_geographic
    if pixel_size is None:
        densified_rings = _densify_polygon_rings(tuple(all_rings), maximum_coordinates)
    elif CRS.from_user_input(source_crs) == target:
        if (
            maximum_coordinates is not None
            and sum(map(len, all_rings)) > maximum_coordinates
        ):
            raise ValueError("Selection exceeds the transformed-geometry limit")
        return geometries
    else:
        densified_rings = _refine_polygon_rings(
            tuple(all_rings),
            source_crs,
            target,
            pixel_size,
            maximum_coordinates,
        )
    projected_rings = densified_rings
    if not split_at_dateline:
        x = [point[0] for ring in densified_rings for point in ring]
        y = [point[1] for ring in densified_rings for point in ring]
        projected_x, projected_y = coordinate_transform(source_crs, target, x, y)
        projected_positions = tuple(zip(projected_x, projected_y, strict=True))
        if not all(
            math.isfinite(ordinate)
            for position in projected_positions
            for ordinate in position
        ):
            raise ValueError("Selection could not be projected")
        position_index = 0
        rings = []
        for ring in densified_rings:
            rings.append(
                projected_positions[position_index : position_index + len(ring)]
            )
            position_index += len(ring)
        projected_rings = tuple(rings)

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
            polygon_rings = projected_rings[ring_index : ring_index + ring_count]
            ring_index += ring_count
            polygons.append(polygon_rings)
        projected_geometry = {
            "type": geometry_type,
            "coordinates": polygons[0] if geometry_type == "Polygon" else polygons,
        }
        if (
            pixel_size is not None
            and target.is_projected
            and geometry_type == "MultiPolygon"
        ):
            try:
                projected_geometry = mapping(union_all(shape(projected_geometry).geoms))
            except GEOSException as error:
                raise ValueError(
                    "Projected polygon parts could not be joined"
                ) from error
        projected_geometries.append(projected_geometry)

    if split_at_dateline:
        return project_geographic_polygons(
            source_crs, target, tuple(projected_geometries)
        )
    return tuple(projected_geometries)


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
    projected_tuple = project_wgs84_polygons(
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
