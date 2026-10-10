"""Trace prepared terrain and summarize native raster values within downstream coverage.

All work runs sequentially in the existing supervised native process. Source
paths and geometries exist only in that process and its private attempt directory.
"""

from dataclasses import dataclass, replace
import hashlib
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray
from pyproj import CRS, Geod, Transformer
import rasterio
from rasterio.features import geometry_mask, shapes
from rasterio.shutil import copy as copy_raster
from rasterio.transform import Affine
from rasterio.windows import Window
from shapely import get_num_coordinates
from shapely.geometry import box, mapping, shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from eolab_app.bounded_vector import polygon_records, native_bbox_for_wgs84_bounds
from eolab_app.attribute_filter import VectorFilter, ogr_predicate
from eolab_app.catalog_selection import (
    ResolvedCatalogSelection,
    SelectionUnavailableError,
)
from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing.aggregate_models import (
    AggregateArea,
    AggregateArtifact,
    RasterAggregateLimits,
)
from eolab_app.processing.artifact_manifest import ProducedFile
from eolab_app.processing.artifacts import write_progress
from eolab_app.processing.clip_models import ClipGrid, RasterClipLimits
from eolab_app.processing.downstream_models import (
    DownstreamRequest,
    DownstreamPlan,
    DownstreamNumericalPolicy,
    VectorStartingMask,
    MAX_ROUTING_CELLS,
    MAX_VALUE_CELLS,
    MAX_WATERSHEDS,
    MAX_COORDINATES,
    MAX_TERMINALS,
    MAX_DISTANCE_PAIRS,
    FLOW_THRESHOLD,
)
from eolab_app.processing.ground_area import PixelAreaCalculator
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.raster_expression import Calculation, compile_expression, walk
from eolab_app.processing.raster_input import (
    native_work,
    select_area,
    validate_supported_raster,
)
from eolab_app.processing.statistics_csv import statistics_csv
from eolab_app.raster.bounded_window import project_wgs84_polygons
from eolab_app.raster.source_contract import (
    read_native_raster_window,
    source_block_indexes_for_window,
)

# Planning allowances, not exact array sizes: the measured four-million-cell
# reference peaks near 542 MiB. This estimate reserves about 988 MiB, including
# interpreter/native-library overhead and overlapping routing/distance arrays.
ESTIMATED_MEMORY_BYTES_PER_CELL = 192
NATIVE_PROCESS_BASE_MEMORY_BYTES = 256 * 1024**2
# Reserve uncompressed routing DEM/direction/accumulation, seed/mask rasters,
# EcoShard scratch and both staged/final outputs with creation/overview headroom.
# Compression savings in the synthetic reference are deliberately not assumed.
ESTIMATED_SCRATCH_BYTES_PER_CELL = 128
SCRATCH_FILE_OVERHEAD_BYTES = 64 * 1024**2


@dataclass(frozen=True)
class DownstreamSources:
    """Authorized native inputs, retained only for the current worker phase.

    Attributes:
        rasters: Confined DEM, values and optional starting-mask paths.
        network: Complete prepared watershed selection.
        starting: Filtered vector starting selection, if that input is a vector.
    """

    rasters: dict[str, Path]
    network: ResolvedCatalogSelection
    starting: ResolvedCatalogSelection | None


@dataclass(frozen=True)
class Watershed:
    """One source watershed's geometry and next connection, ending at a real sink."""

    geometry: BaseGeometry
    downstream: int | str | None


def read_network(
    sources: DownstreamSources,
    request: DownstreamRequest,
    starting: BaseGeometry | None = None,
    selected: tuple[int | str, ...] | None = None,
) -> dict[int | str, Watershed]:
    """Read only starting partitions and their downstream connections from original data.

    ID types, uniqueness, links and acyclicity are guaranteed by the installed
    hydrology report. The authorized reader checks that the source still matches
    that report before and after reading. Native queries must return every
    requested ID; this boundary also enforces per-run geometry/work limits.

    Uses the ordinary spatial and attribute predicates. The full-network source
    authorization remains unchanged; temporary restrictions only reduce its scope.

    Args:
        sources: Authorized complete network reader.
        request: Captured field mappings and prepared configuration.
        starting: Exact geographic starting area used for the initial spatial query.
        selected: Previously admitted IDs when rereading an execution plan.

    Returns:
        Process-local downstream records within retained feature/coordinate budgets.

    Raises:
        ProcessingError: If coverage, identifiers or retained geometry exceed limits.
        SelectionUnavailableError: If the original vector changed.
    """
    topology = request.hydrology.definition.topology
    fields = tuple(
        dict.fromkeys(
            name
            for name in (
                topology.idField,
                topology.downstreamField,
                topology.terminal.field,
                topology.terminal.equalsField,
                topology.terminalIdField,
            )
            if name is not None
        )
    )
    result: dict[int | str, Watershed] = {}
    coordinates = 0

    def read_batch(
        resolved: ResolvedCatalogSelection,
        bbox: tuple[float, float, float, float] | None,
        intersect: bool,
    ) -> None:
        """Read one restricted source batch into the calculation-local network.

        Args:
            resolved: Original authorized source with a narrower native predicate.
            bbox: Optional conservative source-CRS search envelope.
            intersect: Require a positive-area intersection with the starting mask.

        Raises:
            ProcessingError: If duplicate identities or geometry limits are encountered.
        """
        nonlocal coordinates
        with polygon_records(resolved, fields, bbox) as records:
            for geometry, properties in records:
                polygon = shape(geometry)
                if intersect and (
                    not polygon.intersects(starting)
                    or polygon.intersection(starting).area == 0
                ):
                    continue
                identifier = properties[topology.idField]
                if identifier in result:
                    continue
                coordinates += int(get_num_coordinates(polygon))
                if len(result) >= MAX_WATERSHEDS or coordinates > MAX_COORDINATES:
                    raise ProcessingError(
                        "model_too_large",
                        "The selected drainage exceeds this worker's feature or geometry limit.",
                        413,
                    )
                downstream = properties[topology.downstreamField]
                result[identifier] = Watershed(
                    polygon,
                    None if topology.terminal.matches(properties) else downstream,
                )

    if selected is None:
        bbox = native_bbox_for_wgs84_bounds(sources.network, starting.bounds)
        read_batch(sources.network, bbox, True)
        if not result:
            raise ProcessingError(
                "no_hydrology_coverage",
                "The starting mask does not intersect the prepared watershed network.",
                422,
            )
    pending = set(selected or ()) - result.keys()
    pending.update(
        item.downstream
        for item in result.values()
        if item.downstream is not None and item.downstream not in result
    )
    while pending:
        batch = sorted(pending)[:12]
        predicate = VectorFilter.model_validate(
            {
                "enabled": True,
                "match": "any",
                "rules": [
                    {"field": topology.idField, "operator": "eq", "value": identifier}
                    for identifier in batch
                ],
            }
        )
        selection = sources.network.selection.model_copy(update={"filter": predicate})
        restricted = replace(
            sources.network, selection=selection, where=ogr_predicate(predicate)
        )
        read_batch(restricted, None, False)
        # Native query completeness is an external-reader contract, not a second
        # validation of the prepared network. Avoid retrying an empty batch forever.
        if set(batch) - result.keys():
            raise ProcessingError(
                "source_read_failed",
                "The watershed source did not return all requested records. Retry the run or check the source dataset.",
                422,
            )
        pending.difference_update(batch)
        pending.update(
            result[identifier].downstream
            for identifier in batch
            if result[identifier].downstream is not None
            and result[identifier].downstream not in result
        )
    return result


def starting_geometry(
    sources: DownstreamSources, limits: RasterClipLimits
) -> BaseGeometry:
    """Read the selected vector polygons or positive raster mask cells as a starting area.

    Args:
        sources: Authorized native inputs.
        limits: Existing source structure and coordinate budgets.

    Returns:
        Process-local geometry used to find intersecting watershed partitions.

    Raises:
        ProcessingError: If the mask is empty, unsupported or exceeds the geometry budget.
    """
    if sources.starting is None:
        with rasterio.open(sources.rasters["starting_mask"]) as dataset:
            validate_supported_raster(dataset, sources.rasters["starting_mask"])
            if dataset.width * dataset.height > MAX_ROUTING_CELLS:
                raise ProcessingError(
                    "model_too_large",
                    "The starting mask exceeds the native read limit. Clip it to the intended starting area first.",
                    413,
                )
            window = Window(0, 0, dataset.width, dataset.height)
            native_work(
                dataset, window, limits.max_native_blocks, limits.max_decoded_bytes
            )
            values = read_native_raster_window(dataset, window)
            positive = (~np.ma.getmaskarray(values)) & (values.data > 0)
            if not positive.any():
                raise ProcessingError(
                    "empty_starting_mask",
                    "The starting raster has no positive valid cells.",
                    422,
                )
            from rasterio.warp import transform_geom

            polygons = []
            coordinates = 0
            for geometry, _ in shapes(
                positive.astype(np.uint8), mask=positive, transform=dataset.transform
            ):
                polygon = shape(transform_geom(dataset.crs, "EPSG:4326", geometry))
                coordinates += int(get_num_coordinates(polygon))
                if coordinates > limits.max_coordinates:
                    raise ProcessingError(
                        "model_too_large",
                        "The starting mask is too fragmented for this calculation. Choose a smaller area.",
                        413,
                    )
                polygons.append(polygon)
            return unary_union(polygons)
    polygons = []
    coordinates = 0
    with polygon_records(sources.starting, ()) as records:
        for geometry, _ in records:
            polygon = shape(geometry)
            coordinates += int(get_num_coordinates(polygon))
            if coordinates > limits.max_coordinates:
                raise ProcessingError(
                    "model_too_large",
                    "The starting features exceed the geometry limit. Apply a narrower filter.",
                    413,
                )
            polygons.append(polygon)
    if not polygons:
        raise ProcessingError(
            "empty_starting_mask",
            "The starting filter matches no polygon features.",
            422,
        )
    return unary_union(polygons)


def select_downstream_watersheds(
    network: dict[int | str, Watershed], starting: BaseGeometry
) -> tuple[int | str, ...]:
    """Follow downstream links from intersecting starting partitions to real sinks.

    Args:
        network: Complete checked network in geographic coordinates.
        starting: Starting footprint; exact seed cells are selected separately.

    Returns:
        Stable ordered watershed IDs, with no geometry added to the starting mask.

    Raises:
        ProcessingError: If the mask is outside the prepared network coverage.
    """
    selected: set[int | str] = set()
    for identifier, watershed in network.items():
        if not watershed.geometry.intersects(starting):
            continue
        current = identifier
        path: set[int | str] = set()
        while current not in selected:
            path.add(current)
            downstream = network[current].downstream
            if downstream is None:
                break
            current = downstream
        selected.update(path)
    if not selected:
        raise ProcessingError(
            "no_hydrology_coverage",
            "The starting mask does not intersect the prepared watershed network.",
            422,
        )
    return tuple(sorted(selected))


def plan_native_grid(
    dataset: Any, geometry: BaseGeometry, limit: int, limits: RasterClipLimits
) -> ClipGrid:
    """Measure an original raster window before allocating its data or distance arrays.

    Args:
        dataset: Validated original raster.
        geometry: Geographic bounding region for this calculation.
        limit: Maximum admitted window cells for this input.
        limits: Deployment source-block and decoded-byte limits.

    Returns:
        Native window and grid metadata with conservative work estimates.

    Raises:
        ProcessingError: If source work, cell count or memory exceeds capacity.
    """
    selected = select_area(
        dataset, "bounds", geometry.bounds, (), limits.max_coordinates
    )
    window = selected.source_window
    width, height = int(window.width), int(window.height)
    cells = width * height
    # Terrain, routing scratch, distances, transformed centers and validity arrays.
    if (
        cells > limit
        or cells * ESTIMATED_MEMORY_BYTES_PER_CELL + NATIVE_PROCESS_BASE_MEMORY_BYTES
        > limits.process_memory_bytes
    ):
        raise ProcessingError(
            "model_too_large",
            f"This downstream run needs {cells:,} native cells; choose a smaller starting area or prepared watershed network.",
            413,
        )
    blocks, _, decoded = native_work(
        dataset, window, limits.max_native_blocks, limits.max_decoded_bytes
    )
    raw = cells * (np.dtype(dataset.dtypes[0]).itemsize + 1)
    return ClipGrid(
        crs=dataset.crs.to_wkt(),
        transform=tuple(dataset.window_transform(window))[:6],
        window=(int(window.col_off), int(window.row_off), width, height),
        width=width,
        height=height,
        dtype=dataset.dtypes[0],
        nodata=None if dataset.nodata is None else str(dataset.nodata),
        nativeBlocks=blocks,
        decodedBytes=decoded,
        estimatedRawBytes=raw,
        reservedBytes=cells * ESTIMATED_SCRATCH_BYTES_PER_CELL
        + SCRATCH_FILE_OVERHEAD_BYTES,
    )


def plan_downstream(
    sources: DownstreamSources, request: DownstreamRequest, limits: RasterClipLimits
) -> DownstreamPlan:
    """Admit watershed expansion and native input work without writing scratch files.

    Args:
        sources: Authorized native source paths and vector descriptors.
        request: Validated captured model inputs.
        limits: Worker memory, disk, source and geometry limits.

    Returns:
        Path-free calculation plan and conservative scratch reservation.

    Raises:
        ProcessingError: If coverage, source structure or resource limits fail.
    """
    starting = starting_geometry(sources, limits)
    network = read_network(sources, request, starting)
    identifiers = select_downstream_watersheds(network, starting)
    groups = watershed_groups(network, identifiers)
    region = unary_union([network[item].geometry for item in identifiers])
    if not region.covers(starting):
        raise ProcessingError(
            "incomplete_starting_coverage",
            "Part of the starting mask is outside the prepared watershed network. Choose a covered area.",
            422,
        )
    with rasterio.open(sources.rasters["dem"]) as dataset:
        validate_supported_raster(dataset, sources.rasters["dem"])
        routing = plan_native_grid(dataset, region, MAX_ROUTING_CELLS, limits)
        if len(groups) * routing.width * routing.height > MAX_ROUTING_CELLS:
            raise ProcessingError(
                "model_too_large",
                "The combined drainage networks exceed routing work capacity. Choose a smaller area.",
                413,
            )
        if (
            dataset.transform.b
            or dataset.transform.d
            or dataset.transform.a <= 0
            or dataset.transform.e >= 0
        ):
            raise ProcessingError(
                "unsupported_dem",
                "Routing requires a north-up prepared elevation raster.",
                422,
            )
        if (
            not CRS(dataset.crs)
            .geodetic_crs.to_2d()
            .equals(CRS(4326), ignore_axis_order=True)
        ):
            raise ProcessingError(
                "unsupported_dem",
                "Distance buffers require prepared WGS84 terrain.",
                422,
            )
    with rasterio.open(sources.rasters["values"]) as dataset:
        validate_supported_raster(dataset, sources.rasters["values"])
        values = plan_native_grid(dataset, region, MAX_VALUE_CELLS, limits)
    if sources.starting is None:
        with rasterio.open(sources.rasters["starting_mask"]) as dataset:
            plan_native_grid(dataset, starting, MAX_ROUTING_CELLS, limits)
    reserved = routing.reservedBytes + values.reservedBytes
    if reserved > limits.max_stored_bytes:
        raise ProcessingError(
            "model_too_large",
            "This downstream run exceeds available Processing disk capacity.",
            413,
        )
    return DownstreamPlan(
        inputs=request,
        grid=values,
        routingGrid=routing,
        watersheds=identifiers,
        reservedBytes=reserved,
    )


def grid_centers(grid: ClipGrid) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """Compute geographic cell centers for an already admitted native grid.

    Args:
        grid: Bounded native raster window.

    Returns:
        Longitude and latitude arrays with the grid's shape.

    Raises:
        ProcessingError: If coordinates cannot be transformed to finite WGS84 positions.
    """
    rows, columns = np.indices((grid.height, grid.width), dtype=np.float64)
    transform = Affine(*grid.transform)
    x, y = transform * (columns + 0.5, rows + 0.5)
    projector = Transformer.from_crs(
        grid.crs, 4326, always_xy=True, allow_ballpark=False
    )
    lon, lat = projector.transform(x, y, errcheck=True)
    if not np.all(np.isfinite(lon) & np.isfinite(lat)) or np.any(np.abs(lat) > 90):
        raise ProcessingError(
            "unsupported_grid",
            "Raster cell centers cannot be located safely on the globe.",
            422,
        )
    return lon, lat


def buffer_cell_mask(
    lon: NDArray[np.float64],
    lat: NDArray[np.float64],
    origins: NDArray[np.bool_],
    metres: float,
) -> NDArray[np.bool_]:
    """Expand a cell mask to include cell centers within the requested buffer distance.

    Use reached downstream cells as origins to buffer a flow path. Use original
    starting cells as origins to build the maximum-distance mask applied afterward.

    A Cartesian tree finds candidates using Earth-centered chord distances.
    Chords are lower bounds on surface distance; ambiguous candidates are checked
    with WGS84 geodesics, avoiding a degrees-to-metres pixel-size approximation.

    Args:
        lon: Longitude of each admitted grid center.
        lat: Latitude of each admitted grid center.
        origins: Boolean mask of starting cells; True cells are always retained.
        metres: Inclusive nonnegative distance threshold.

    Returns:
        Boolean mask with True at original cells and all cell centers within
        the inclusive distance in metres, with the same shape as origins.

    Raises:
        ProcessingError: If ambiguous candidate checks exceed the work budget.
    """
    from scipy.spatial import cKDTree

    if not origins.any() or origins.all() or metres == 0:
        return origins.copy()
    earth = Transformer.from_crs(4979, 4978, always_xy=True)
    points = np.column_stack(
        earth.transform(lon.ravel(), lat.ravel(), np.zeros(lon.size))
    )
    selected = np.flatnonzero(origins.ravel())
    tree = cKDTree(points[selected])
    geod = Geod(ellps="WGS84")
    result = origins.ravel().copy()
    work = 0
    for offset in range(0, lon.size, 8192):
        indexes = np.arange(offset, min(offset + 8192, lon.size))
        chords, nearest = tree.query(points[indexes], workers=1)
        possible = indexes[(chords <= metres) & ~result[indexes]]
        near = selected[nearest[(chords <= metres) & ~result[indexes]]]
        _, _, distances = geod.inv(
            lon.ravel()[possible],
            lat.ravel()[possible],
            lon.ravel()[near],
            lat.ravel()[near],
        )
        result[possible[distances <= metres]] = True
        for index in possible[distances > metres]:
            count = tree.query_ball_point(points[index], metres, return_length=True)
            work += count
            if work > MAX_DISTANCE_PAIRS:
                raise ProcessingError(
                    "model_too_large",
                    "The buffer needs too many distance comparisons. Choose a smaller area.",
                    413,
                )
            candidates = selected[tree.query_ball_point(points[index], metres)]
            _, _, exact = geod.inv(
                np.full(len(candidates), lon.ravel()[index]),
                np.full(len(candidates), lat.ravel()[index]),
                lon.ravel()[candidates],
                lat.ravel()[candidates],
            )
            result[index] = bool(np.any(exact <= metres))
    return result.reshape(lon.shape)


def sample_native_mask(
    path: Path,
    lon: NDArray[np.float64],
    lat: NDArray[np.float64],
    limits: RasterClipLimits,
) -> NDArray[np.bool_]:
    """Read positive mask values at routing centers without interpolating values.

    Args:
        path: Authorized mask raster.
        lon: Routing center longitudes.
        lat: Routing center latitudes.
        limits: Native source read budgets.

    Returns:
        True for centers falling in positive, finite, unmasked native mask cells.

    Raises:
        ProcessingError: If the required native mask window exceeds its budget.
    """
    with rasterio.open(path) as dataset:
        validate_supported_raster(dataset, path)
        projection = Transformer.from_crs(
            4326, dataset.crs, always_xy=True, allow_ballpark=False
        )
        x, y = projection.transform(lon, lat, errcheck=True)
        cols, rows = (~dataset.transform) * (x, y)
        cols, rows = np.floor(cols).astype(np.int64), np.floor(rows).astype(np.int64)
        inside = (
            (rows >= 0) & (cols >= 0) & (rows < dataset.height) & (cols < dataset.width)
        )
        result = np.zeros(lon.shape, dtype=bool)
        if not inside.any():
            return result
        x0, x1 = int(cols[inside].min()), int(cols[inside].max()) + 1
        y0, y1 = int(rows[inside].min()), int(rows[inside].max()) + 1
        window = Window(x0, y0, x1 - x0, y1 - y0)
        if window.width * window.height > MAX_ROUTING_CELLS:
            raise ProcessingError(
                "model_too_large",
                "The starting raster mask exceeds the native read limit.",
                413,
            )
        native_work(dataset, window, limits.max_native_blocks, limits.max_decoded_bytes)
        values = read_native_raster_window(dataset, window)
        valid = (~np.ma.getmaskarray(values)) & (values.data > 0)
        result[inside] = valid[rows[inside] - y0, cols[inside] - x0]
        return result


def write_grid(
    path: Path, data: NDArray[Any], grid: ClipGrid, nodata: int | float
) -> None:
    """Write a calculation-local native-grid GeoTIFF for routing or publication.

    Args:
        path: New file confined to the admitted attempt directory.
        data: One complete admitted grid.
        grid: Original CRS and alignment.
        nodata: Explicit outside-domain sentinel.

    Raises:
        RasterioError: If GDAL cannot create the file.
    """
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=grid.width,
        height=grid.height,
        count=1,
        dtype=data.dtype,
        crs=grid.crs,
        transform=Affine(*grid.transform),
        nodata=nodata,
        tiled=True,
        blockxsize=256,
        blockysize=256,
        compress="DEFLATE",
        NUM_THREADS="1",
    ) as target:
        target.write(data, 1)


def watershed_groups(
    network: dict[int | str, Watershed], selected: tuple[int | str, ...]
) -> dict[int | str, list[BaseGeometry]]:
    """Separate selected partitions by real sink so virtual links cannot convey flow.

    Args:
        network: Current prepared network records.
        selected: Admitted downstream partition identities.

    Returns:
        Process-local polygon groups, one for each real terminal drainage.

    Raises:
        ProcessingError: If the terminal count exceeds the per-run budget.
    """
    groups: dict[int | str, list[BaseGeometry]] = {}
    for identifier in selected:
        current = identifier
        while network[current].downstream is not None:
            current = network[current].downstream
        groups.setdefault(current, []).append(network[identifier].geometry)
    if len(groups) > MAX_TERMINALS:
        raise ProcessingError(
            "model_too_large",
            "The starting mask reaches too many drainage networks. Choose a smaller area.",
            413,
        )
    return groups


def calculate_downstream(
    sources: DownstreamSources,
    spec: DownstreamPlan,
    directory: Path,
    limits: RasterClipLimits,
) -> AggregateArtifact:
    """Compute combined downstream coverage and summarize native values in one process.

    Args:
        sources: Reauthorized original files and selections.
        spec: Admitted windows, watershed IDs and captured model inputs.
        directory: Private scratch directory covered by this attempt's reservation.
        limits: Worker resource policy; cancellation is enforced by its supervisor.

    Returns:
        Statistics plus complete coverage and starting-mask raster artifacts.

    Raises:
        ProcessingError: If coverage, staleness, native work or output limits fail.
        RasterioError: If a native read or output fails.
    """
    from ecoshard.geoprocessing import routing
    import numexpr

    # EcoShard configures numexpr at import; this admitted operation is sequential.
    numexpr.set_num_threads(1)
    request = spec.inputs
    checked = plan_downstream(sources, request, limits)
    if (
        checked.grid != spec.grid
        or checked.routingGrid != spec.routingGrid
        or checked.watersheds != spec.watersheds
        or checked.reservedBytes != spec.reservedBytes
    ):
        raise ProcessingError(
            "source_changed", "The model inputs changed after preparation.", 409
        )
    network = read_network(sources, request, selected=spec.watersheds)
    groups = watershed_groups(network, spec.watersheds)
    if (
        len(groups) * spec.routingGrid.width * spec.routingGrid.height
        > MAX_ROUTING_CELLS
    ):
        raise ProcessingError(
            "model_too_large",
            "The combined drainage networks exceed routing work capacity. Choose a smaller area.",
            413,
        )
    grid = spec.routingGrid
    lon, lat = grid_centers(grid)
    write_progress(directory, "preparing_starting_mask", 0, 0)
    with rasterio.open(sources.rasters["dem"]) as dataset:
        dem = read_native_raster_window(dataset, Window(*grid.window))
        if sources.starting:
            starting = starting_geometry(sources, limits)
            projected = project_wgs84_polygons(
                dataset, (mapping(starting),), limits.max_coordinates
            )
            seeds = geometry_mask(
                projected,
                out_shape=dem.shape,
                transform=Affine(*grid.transform),
                invert=True,
            )
        else:
            seeds = sample_native_mask(
                sources.rasters["starting_mask"], lon, lat, limits
            )
        reached = np.zeros(dem.shape, dtype=bool)
        domain = np.zeros(dem.shape, dtype=bool)
        for index, polygons in enumerate(groups.values()):
            projected = project_wgs84_polygons(
                dataset,
                tuple(mapping(polygon) for polygon in polygons),
                MAX_COORDINATES,
            )
            inside = geometry_mask(
                projected,
                out_shape=dem.shape,
                transform=Affine(*grid.transform),
                invert=True,
            )
            domain |= inside
            if np.any(inside & np.ma.getmaskarray(dem)):
                raise ProcessingError(
                    "incomplete_dem",
                    "The prepared DEM has missing elevation inside the downstream area. Repair terrain coverage.",
                    422,
                )
            weights = seeds & inside
            if not weights.any():
                continue
            write_progress(directory, "routing_downstream", 0, 0)
            # EcoShard routing requires a finite NoData sentinel to recognize
            # outlets at dataset edges. Float64 preserves stored DEM precision.
            nodata = np.finfo(np.float64).min
            if np.any(inside & (dem.data == nodata)):
                raise ProcessingError(
                    "unsupported_dem",
                    "The DEM uses an unsupported elevation range.",
                    422,
                )
            elevation = np.where(inside, dem.data, nodata).astype(np.float64)
            write_grid(directory / "routing-dem.tif", elevation, grid, nodata)
            write_grid(
                directory / "routing-seeds.tif", weights.astype(np.uint8), grid, 255
            )
            routing.flow_dir_mfd(
                (str(directory / "routing-dem.tif"), 1),
                str(directory / "flow.tif"),
                working_dir=str(directory),
            )
            routing.flow_accumulation_mfd(
                (str(directory / "flow.tif"), 1),
                str(directory / "accumulation.tif"),
                weight_raster_path_band=(str(directory / "routing-seeds.tif"), 1),
            )
            with rasterio.open(directory / "accumulation.tif") as accumulation:
                values = accumulation.read(1, masked=True)
                reached |= weights | (
                    inside
                    & ~np.ma.getmaskarray(values)
                    & (values.data > FLOW_THRESHOLD)
                )
    seeds &= domain
    if not seeds.any():
        raise ProcessingError(
            "empty_starting_mask",
            "The starting mask contains no valid DEM cell centers. Choose a larger starting area or compatible terrain resolution.",
            422,
        )
    write_progress(directory, "buffering_downstream_coverage", 0, 0)
    # True cells form the area used to summarize the values raster: downstream
    # cells plus their buffer, restricted to the watershed domain and cutoff.
    summary_coverage = buffer_cell_mask(lon, lat, reached, request.buffer_m) & domain
    if request.cutoff_m is not None:
        summary_coverage &= buffer_cell_mask(lon, lat, seeds, request.cutoff_m)
    write_progress(directory, "summarizing_values", 0, 0)
    root = compile_expression(request.summary, "a")
    calculation = Calculation(root)
    with rasterio.open(sources.rasters["values"]) as dataset:
        area_calculator = (
            PixelAreaCalculator(
                dataset,
                AggregateArea(kind="wholeRaster"),
                RasterAggregateLimits.with_lifecycle(limits),
            )
            if any(node.op == "areaha" for node in walk(root))
            else None
        )
        grid_values = spec.grid
        to_dem = Transformer.from_crs(
            dataset.crs, grid.crs, always_xy=True, allow_ballpark=False
        )
        selected_window = Window(*grid_values.window)
        blocks = source_block_indexes_for_window(
            selected_window, dataset.block_shapes[0]
        )
        for completed, (block_row, block_col) in enumerate(blocks, start=1):
            tile = dataset.block_window(1, block_row, block_col).intersection(
                selected_window
            )
            values = read_native_raster_window(dataset, tile)
            rr, cc = np.indices(values.shape, dtype=np.float64)
            x, y = dataset.window_transform(tile) * (cc + 0.5, rr + 0.5)
            x, y = to_dem.transform(x, y, errcheck=True)
            dc, dr = (~Affine(*grid.transform)) * (x, y)
            dc, dr = np.floor(dc).astype(np.int64), np.floor(dr).astype(np.int64)
            valid = (dc >= 0) & (dr >= 0) & (dc < grid.width) & (dr < grid.height)
            covered = np.zeros(values.shape, dtype=bool)
            covered[valid] = summary_coverage[dr[valid], dc[valid]]
            valid = covered & ~np.ma.getmaskarray(values)
            hectares = (
                area_calculator.calculate_hectares(tile) if area_calculator else None
            )
            calculation.process_tile(
                values.data,
                valid,
                hectares,
                valid if hectares is not None else None,
            )
            write_progress(
                directory,
                "summarizing_values",
                completed,
                len(blocks),
                unit="blocks",
            )
    rows = [
        {"label": request.label, "expression": request.summary, **calculation.result()}
    ]
    result = directory / "result.csv"
    result.write_bytes(statistics_csv(rows))
    outputs = []
    write_progress(directory, "writing_results", 0, 0)
    for name, data in (("coverage", summary_coverage), ("starting_mask", seeds)):
        stage, final = directory / (name + "-stage.tif"), directory / (name + ".tif")
        write_grid(stage, np.where(domain, data, 255).astype(np.uint8), grid, 255)
        copy_raster(
            stage,
            final,
            driver="COG",
            compress="DEFLATE",
            blocksize=256,
            overview_resampling="NEAREST",
            NUM_THREADS="1",
        )
        with rasterio.open(final) as check:
            if (
                check.width != grid.width
                or check.height != grid.height
                or check.transform != Affine(*grid.transform)
            ):
                raise ProcessingError(
                    "invalid_output", "A downstream raster failed grid validation.", 500
                )
        with final.open("rb") as stream:
            checksum = hashlib.file_digest(stream, "sha256").hexdigest()
        outputs.append(
            ProducedFile(
                name=name,
                storage_name=final.name,
                filename=final.name,
                media_type="image/tiff",
                size=final.stat().st_size,
                sha256=checksum,
            )
        )
    policy = DownstreamNumericalPolicy(
        bufferMetres=request.buffer_m, cutoffMetres=request.cutoff_m
    )
    (directory / "provenance.json").write_text(
        json.dumps(
            {
                "operation": spec.operation,
                "inputs": request.model_dump(mode="json", by_alias=True),
                "routingGrid": grid.model_dump(),
                "valuesGrid": spec.grid.model_dump(),
                "watershedIds": spec.watersheds,
                "numericalPolicy": policy.model_dump(),
                "startingCells": int(seeds.sum()),
                "reachedCells": int(reached.sum()),
                "coverageCells": int(summary_coverage.sum()),
                "statistics": rows,
            },
            allow_nan=False,
        ),
        encoding="utf-8",
    )
    if (
        sum(path.stat().st_size for path in directory.rglob("*") if path.is_file())
        > spec.reservedBytes
    ):
        raise ProcessingError(
            "output_too_large",
            "Downstream scratch files exceeded the admitted disk reservation.",
            413,
        )
    return AggregateArtifact(
        filename="downstream-statistics.csv",
        size=result.stat().st_size,
        sha256=hashlib.sha256(result.read_bytes()).hexdigest(),
        rows=rows,
        additional_outputs=tuple(outputs),
    )


def downstream_process_target(
    writer: ProcessResultWriter, action: str, arguments: tuple[Any, ...]
) -> None:
    """Run an allowlisted downstream kernel and return sanitized results to its supervisor.

    Args:
        writer: Existing single-result native IPC writer.
        action: Preparation or calculation selected by the trusted adapter.
        arguments: Authorized paths and validated operation inputs.
    """
    try:
        with rasterio.Env(GDAL_CACHEMAX=32 * 1024**2, GDAL_NUM_THREADS="1"):
            if action == "plan":
                result = plan_downstream(*arguments)
            elif action == "calculate":
                result = calculate_downstream(*arguments)
            else:
                raise ValueError("Unknown downstream operation")
        writer.put(("ok", result))
    except ProcessingError as error:
        writer.put(("error", (error.code, error.detail, error.status)))
    except SelectionUnavailableError:
        writer.put(
            (
                "error",
                (
                    "source_changed",
                    "A selected vector changed. Select it again before running the model.",
                    409,
                ),
            )
        )
    except Exception:
        writer.put(
            (
                "error",
                (
                    "processing_failed",
                    "The downstream calculation could not process these inputs safely.",
                    500,
                ),
            )
        )
