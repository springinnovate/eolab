"""Check prepared watershed connections and elevation coverage using bounded source reads."""

from dataclasses import dataclass
from datetime import datetime, timezone
import math
from typing import Any

import numpy as np
import rasterio
from rasterio.features import geometry_mask, geometry_window
from shapely import get_num_coordinates
from shapely.geometry import box, mapping, shape
from shapely.geometry.base import BaseGeometry

from eolab_app.bounded_geometry import GeometryValidationError
from eolab_app.bounded_vector import polygon_records
from eolab_app.catalog_selection import (
    ResolvedCatalogSelection,
    SelectionUnavailableError,
)
from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing.model_yaml import compute_document_checksum
from eolab_app.processing.prepared_hydrology import (
    HydrologyValidation,
    PreparedHydrologyDefinition,
    PreparedHydrologySnapshot,
)
from eolab_app.raster.bounded_window import project_wgs84_polygons
from eolab_app.raster.models import AuthorizedRaster
from eolab_app.raster.source_identity import RasterSourceIdentity
from eolab_app.raster.source_contract import (
    require_bounded_source_structure,
    require_raster_analysis_georeferencing,
    require_signed_raster_dependencies,
    read_native_raster_block,
    source_work_for_blocks,
)


@dataclass(frozen=True)
class HydrologyValidationLimits:
    """Bound one administrator validation's native work and retained network metadata.

    Attributes:
        features: Maximum watershed records retained for link validation.
        coordinates: Maximum projected coordinates retained for connected-boundary checks.
        decoded_bytes: Cumulative native data/mask work, counting repeated block reads.
    """

    features: int = 100_000
    coordinates: int = 2_000_000
    decoded_bytes: int = 512 * 1024**2

    def __post_init__(self) -> None:
        """Require positive validation budgets.

        Raises:
            ValueError: If a work budget is not a positive integer.
        """
        if any(
            type(value) is not int or value <= 0
            for value in (self.features, self.coordinates, self.decoded_bytes)
        ):
            raise ValueError("Hydrology validation budgets must be positive integers")


def require_network_id(value: Any, id_type: str, field: str) -> int | str:
    """Read a watershed identifier without rounding numbers or coercing strings.

    Args:
        value: Original source attribute value.
        id_type: Configured integer or string identity convention.
        field: Mapped field name for diagnostics.

    Returns:
        The unchanged, bounded identifier.

    Raises:
        ValueError: If the field is missing, null, wrongly typed or too long.
    """
    valid = (
        type(value) is int
        if id_type == "integer"
        else (type(value) is str and 0 < len(value) <= 128)
    )
    if not valid:
        raise ValueError(f"Field '{field}' requires non-null {id_type} watershed IDs")
    return value


def validate_network_links(
    nodes: dict[int | str, tuple[int | str | None, int | str | None, BaseGeometry]],
    tolerance: float,
) -> int:
    """Follow every watershed to a terminal and check connected partition boundaries.

    Args:
        nodes: Bounded native-validation records containing next ID, optional terminal
            ID and projected polygon. These records never leave the validation process.
        tolerance: One DEM-pixel diagonal in the DEM's coordinate units.

    Returns:
        Number of distinct terminal watersheds.

    Raises:
        ValueError: If a link is missing, cyclic, spatially disconnected or has
            an inconsistent declared terminal drainage ID.
    """
    terminals: dict[int | str, int | str] = {}
    for identifier, (downstream, _, geometry) in nodes.items():
        if downstream is not None:
            if downstream not in nodes:
                raise ValueError(
                    f"Watershed {identifier!r} links outside the configured network; include all downstream partitions"
                )
            if geometry.distance(nodes[downstream][2]) > tolerance:
                raise ValueError(
                    f"Watershed {identifier!r} has a gap before its downstream partition; repair coverage"
                )
    for start in nodes:
        path: set[int | str] = set()
        current = start
        while current not in terminals:
            if current in path:
                raise ValueError(
                    f"Downstream links contain a cycle at watershed {current!r}"
                )
            path.add(current)
            downstream = nodes[current][0]
            if downstream is None:
                terminals[current] = current
                break
            current = downstream
        terminal = terminals[current]
        for identifier in path:
            terminals[identifier] = terminal
    for identifier, (_, declared_terminal, _) in nodes.items():
        if declared_terminal is not None and declared_terminal != terminals[identifier]:
            raise ValueError(
                f"Watershed {identifier!r} has an inconsistent terminal drainage ID"
            )
    return len(set(terminals.values()))


def check_dem_coverage(
    dataset: rasterio.io.DatasetReader,
    polygons: tuple[dict[str, object], ...],
    remaining_bytes: int,
) -> tuple[int, int]:
    """Check exact DEM validity inside watershed polygons using native raster blocks.

    Args:
        dataset: Authorized one-band DEM with validated block and validity contracts.
        polygons: Bounded geometry projected into this DEM's CRS and fully inside its extent.
        remaining_bytes: Remaining cumulative native data/mask work budget.

    Returns:
        Count of polygon-covered pixel centers and decoded bytes charged to this read.

    Raises:
        ValueError: If work exceeds its budget, coverage has NoData/nonfinite/masked
            cells, or the watershed contains no DEM pixel centers.
    """
    window = geometry_window(dataset, polygons)
    block_height, block_width = dataset.block_shapes[0]
    checked = work = 0
    for row in range(
        int(window.row_off) // block_height,
        math.ceil((window.row_off + window.height) / block_height),
    ):
        for col in range(
            int(window.col_off) // block_width,
            math.ceil((window.col_off + window.width) / block_width),
        ):
            _, decoded = source_work_for_blocks(dataset, ((row, col),))
            work += decoded
            if work > remaining_bytes:
                raise ValueError(
                    "DEM coverage validation exceeds its decoded-byte budget; increase the administrator validation budget or prepare a smaller complete network"
                )
            block = dataset.block_window(1, row, col)
            inside = geometry_mask(
                polygons,
                out_shape=(int(block.height), int(block.width)),
                transform=dataset.window_transform(block),
                invert=True,
            )
            if not inside.any():
                continue
            values = read_native_raster_block(dataset, block)
            if np.any(inside & np.ma.getmaskarray(values)):
                raise ValueError(
                    "The DEM has missing or invalid elevation cells inside a watershed; repair terrain coverage"
                )
            checked += int(np.count_nonzero(inside))
    if checked == 0:
        raise ValueError(
            "A watershed contains no DEM pixel centers; use a compatible terrain resolution"
        )
    return checked, work


def validate_hydrology_sources(
    definition: PreparedHydrologyDefinition,
    dem: AuthorizedRaster,
    watersheds: ResolvedCatalogSelection,
    limits: HydrologyValidationLimits,
) -> PreparedHydrologySnapshot:
    """Validate a complete prepared network and its original DEM before model admission.

    This reads all watershed records and the native DEM blocks covering them.
    Source signatures are checked before and after reading. No flow directions,
    filtered copies, raster masks or persistent geometry are created.

    Args:
        definition: Validated administrator configuration.
        dem: Catalog-authorized original elevation source.
        watersheds: Catalog-authorized complete watershed source.
        limits: Native work and retained-network budgets.

    Returns:
        Path-free configuration and validation evidence for setup and Run YAML.

    Raises:
        ValueError: If the network, terrain, configuration or work budget is incompatible.
        SelectionUnavailableError: If either source changed or became unavailable.
        RasterioError: If the native raster cannot be read.
    """
    if watersheds.selection.filter.active or (
        watersheds.selection.collection_id,
        watersheds.selection.item_id,
    ) != (definition.watersheds.collection_id, definition.watersheds.item_id):
        raise ValueError(
            "Validate the entire configured watershed network without a filter"
        )
    if RasterSourceIdentity.read(dem.source_path) != dem.source_signature:
        raise SelectionUnavailableError(
            "The DEM changed; rescan it before hydrology validation"
        )
    topology = definition.topology
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
    nodes: dict[int | str, tuple[int | str | None, int | str | None, BaseGeometry]] = {}
    terminal_links: dict[int | str, int | str] = {}
    checked = coordinates = decoded = 0
    bounds = [180.0, 90.0, -180.0, -90.0]
    with (
        rasterio.Env(GDAL_CACHEMAX=32 * 1024**2),
        rasterio.open(dem.source_path, driver="GTiff") as dataset,
    ):
        require_signed_raster_dependencies(dataset, dem.source_path)
        require_raster_analysis_georeferencing(dataset)
        require_bounded_source_structure(dataset)
        affine = dataset.transform
        if affine.b != 0 or affine.d != 0 or affine.a <= 0 or affine.e >= 0:
            raise ValueError(
                "Prepared terrain requires a north-up DEM with positive pixel width and negative pixel height"
            )
        footprint = box(*dataset.bounds)
        tolerance = math.hypot(affine.a, affine.e)
        with polygon_records(watersheds, fields) as records:
            for geometry, properties in records:
                if len(nodes) >= limits.features:
                    raise ValueError("Watershed validation exceeds its feature budget")
                identifier = require_network_id(
                    properties[topology.idField], topology.idType, topology.idField
                )
                if identifier in nodes:
                    raise ValueError(f"Duplicate watershed ID {identifier!r}")
                next_id = require_network_id(
                    properties[topology.downstreamField],
                    topology.idType,
                    topology.downstreamField,
                )
                terminal = topology.terminal.matches(properties)
                if terminal and topology.terminal.equalsField is None:
                    terminal_links[identifier] = next_id
                terminal_id = (
                    None
                    if topology.terminalIdField is None
                    else require_network_id(
                        properties[topology.terminalIdField],
                        topology.idType,
                        topology.terminalIdField,
                    )
                )
                geographic = shape(geometry)
                west, south, east, north = geographic.bounds
                bounds = [
                    min(bounds[0], west),
                    min(bounds[1], south),
                    max(bounds[2], east),
                    max(bounds[3], north),
                ]
                projected = project_wgs84_polygons(
                    dataset, (geometry,), limits.coordinates - coordinates
                )
                polygon = shape(projected[0])
                coordinates += int(get_num_coordinates(polygon))
                if coordinates > limits.coordinates:
                    raise ValueError(
                        "Watershed validation exceeds its retained-coordinate budget"
                    )
                if not polygon.is_valid or not footprint.covers(polygon):
                    raise ValueError(
                        "Watershed coverage falls outside the DEM or cannot be projected safely; include complete downstream terrain"
                    )
                nodes[identifier] = (
                    None if terminal else next_id,
                    terminal_id,
                    polygon,
                )
        if not nodes:
            raise ValueError("The configured watershed network has no polygon features")
        for identifier, downstream in terminal_links.items():
            if downstream in nodes and downstream != identifier:
                raise ValueError(
                    f"Terminal watershed {identifier!r} still links to another watershed; correct the terminal rule"
                )
        terminal_count = validate_network_links(nodes, tolerance)
        # Finish the vector stream before DEM work so raster reads do not consume
        # the vector reader's elapsed-time budget. The native deadline bounds both.
        for _, _, polygon in nodes.values():
            cells, work = check_dem_coverage(
                dataset, (mapping(polygon),), limits.decoded_bytes - decoded
            )
            checked += cells
            decoded += work
        validation = HydrologyValidation(
            validator="eolab.hydrology-validation/v1",
            validatedAt=datetime.now(timezone.utc),
            watershedCount=len(nodes),
            terminalCount=terminal_count,
            demCellsChecked=checked,
            bounds=dict(zip(("west", "south", "east", "north"), bounds)),
            grid={
                "crs": dataset.crs.to_string(),
                "transform": tuple(affine)[:6],
                "width": dataset.width,
                "height": dataset.height,
                "dtype": dataset.dtypes[0],
            },
        )
    watersheds.require_current()
    if RasterSourceIdentity.read(dem.source_path) != dem.source_signature:
        raise SelectionUnavailableError(
            "The DEM changed during hydrology validation; rescan and validate again"
        )
    snapshot = PreparedHydrologySnapshot.model_construct(
        definition=definition,
        demSignature=compute_document_checksum(dem.source_signature.to_catalog()),
        watershedSelection=watersheds.selection,
        validation=validation,
    )
    return PreparedHydrologySnapshot.model_validate(
        {
            **snapshot.model_dump(mode="json", by_alias=True),
            "effectiveSha256": snapshot.compute_effective_checksum(),
        }
    )


def validate_hydrology_process(
    writer: ProcessResultWriter,
    definition: PreparedHydrologyDefinition,
    dem: AuthorizedRaster,
    watersheds: ResolvedCatalogSelection,
    limits: HydrologyValidationLimits,
) -> None:
    """Return one validation report or a sanitized failure from the supervised native process.

    Args:
        writer: Existing native supervisor's result channel.
        definition: Administrator configuration.
        dem: Authorized original DEM.
        watersheds: Authorized original full watershed network.
        limits: Work and retained-geometry limits enforced inside the child.
    """
    try:
        snapshot = validate_hydrology_sources(definition, dem, watersheds, limits)
        writer.put((True, snapshot.model_dump(mode="json", by_alias=True)))
    except (ValueError, GeometryValidationError, SelectionUnavailableError) as error:
        writer.put((False, str(error)))
    except Exception:
        writer.put(
            (
                False,
                "Hydrology sources could not be read; check catalog availability and prepared data",
            )
        )
