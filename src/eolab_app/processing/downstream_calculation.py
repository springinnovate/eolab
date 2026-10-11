"""Admit downstream inputs and call the original WWF beneficiaries calculation.

All work runs sequentially in the existing supervised native process. Source
paths and geometries exist only in that process and its private attempt directory.
"""

from contextlib import chdir
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import numpy as np
import rasterio
from rasterio.features import shapes
from rasterio.windows import Window
from shapely import get_num_coordinates
from shapely.geometry import shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from eolab_app.bounded_vector import polygon_records, native_bbox_for_wgs84_bounds
from eolab_app.attribute_filter import VectorFilter, ogr_predicate
from eolab_app.catalog_selection import (
    ResolvedCatalogSelection,
    SelectionUnavailableError,
)
from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing.aggregate_models import AggregateArtifact
from eolab_app.processing.clip_models import ClipGrid
from eolab_app.processing.downstream_models import (
    DownstreamLimits,
    DownstreamRequest,
    DownstreamPlan,
)
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.raster_input import (
    native_work,
    select_area,
    validate_supported_raster,
)
from eolab_app.raster.source_contract import read_native_raster_window

# Existing conservative admission allowances, retained when replacing the
# calculation with upstream code. These are not upstream performance estimates.
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
    limits: DownstreamLimits,
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
        limits: Deployment watershed/coordinate budgets for this run.
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
                if (
                    len(result) >= limits.max_watersheds
                    or coordinates > limits.max_watershed_coordinates
                ):
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
    sources: DownstreamSources, limits: DownstreamLimits
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
            if dataset.width * dataset.height > limits.max_mask_cells:
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
    dataset: Any, geometry: BaseGeometry, limit: int, limits: DownstreamLimits
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
    sources: DownstreamSources, request: DownstreamRequest, limits: DownstreamLimits
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
    network = read_network(sources, request, limits, starting)
    identifiers = select_downstream_watersheds(network, starting)
    groups = group_watersheds_by_sink(network, identifiers, limits)
    region = unary_union([network[item].geometry for item in identifiers])
    if not region.covers(starting):
        raise ProcessingError(
            "incomplete_starting_coverage",
            "Part of the starting mask is outside the prepared watershed network. Choose a covered area.",
            422,
        )
    with rasterio.open(sources.rasters["dem"]) as dataset:
        validate_supported_raster(dataset, sources.rasters["dem"])
        routing = plan_native_grid(dataset, region, limits.max_routing_cells, limits)
        if len(groups) * routing.width * routing.height > limits.max_routing_cells:
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
    with rasterio.open(sources.rasters["values"]) as dataset:
        validate_supported_raster(dataset, sources.rasters["values"])
        values = plan_native_grid(dataset, region, limits.max_value_cells, limits)
    if sources.starting is None:
        with rasterio.open(sources.rasters["starting_mask"]) as dataset:
            plan_native_grid(dataset, starting, limits.max_mask_cells, limits)
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


def group_watersheds_by_sink(
    network: dict[int | str, Watershed],
    selected: tuple[int | str, ...],
    limits: DownstreamLimits,
) -> dict[int | str, list[BaseGeometry]]:
    """Group selected watershed polygons for the existing sink-count admission budget.

    This budget does not control the upstream calculation's traversal. The
    original model selects and groups its own partitions during execution.

    Args:
        network: Current prepared network records.
        selected: Admitted downstream partition identities.
        limits: Maximum independent sink groups admitted for this deployment.

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
    if len(groups) > limits.max_terminals:
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
    limits: DownstreamLimits,
) -> AggregateArtifact:
    """Check the admitted inputs and invoke the unchanged WWF calculation.

    Execution is sequential in the native worker. Its current directory is
    temporarily the private attempt so upstream helpers using relative scratch
    paths work with a read-only application mount and remain run-owned.

    Args:
        sources: Reauthorized original files and selections.
        spec: Existing admitted windows, watershed IDs and captured inputs.
        directory: Private workspace covered by this attempt's reservation.
        limits: Existing source, memory, work and storage safeguards.

    Returns:
        The upstream model's rasters and total, plus requested formula metadata.

    Raises:
        ProcessingError: If admission changed or the original calculation fails.
    """
    checked = plan_downstream(sources, spec.inputs, limits)
    if (
        checked.grid != spec.grid
        or checked.routingGrid != spec.routingGrid
        or checked.watersheds != spec.watersheds
        or checked.reservedBytes != spec.reservedBytes
    ):
        raise ProcessingError(
            "source_changed", "The model inputs changed after preparation.", 409
        )
    from eolab_app.processing.downstream_runner import run_original_downstream

    workspace = directory.resolve()
    with chdir(workspace):
        return run_original_downstream(
            sources, spec, workspace, limits, starting_geometry(sources, limits)
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
