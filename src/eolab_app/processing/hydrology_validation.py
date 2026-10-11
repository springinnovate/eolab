"""Check prepared watershed connections and DEM metadata using bounded source reads."""

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import rasterio
from shapely import get_num_coordinates
from shapely.geometry import shape

from eolab_app.bounded_geometry import GeometryValidationError
from eolab_app.bounded_vector import READ_SECONDS, polygon_records
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
from eolab_app.raster.models import AuthorizedRaster
from eolab_app.raster.source_identity import RasterSourceIdentity
from eolab_app.raster.source_contract import (
    require_bounded_source_structure,
    require_raster_analysis_georeferencing,
    require_signed_raster_dependencies,
)


@dataclass(frozen=True)
class HydrologyValidationLimits:
    """Bound one administrator validation's native work and retained network metadata.

    Attributes:
        features: Maximum watershed records retained for link validation.
        coordinates: Maximum geographic coordinates inspected across network features.
        read_timeout_seconds: Elapsed-time allowance passed to the source reader.
            The CLI supplies its native-process timeout; other callers inherit the
            reader's default. The reader requires a positive finite value.
    """

    features: int = 100_000
    coordinates: int = 2_000_000
    read_timeout_seconds: float = READ_SECONDS

    def __post_init__(self) -> None:
        """Require positive feature and coordinate budgets.

        Raises:
            ValueError: If a work budget is not a positive integer.
        """
        if any(
            type(value) is not int or value <= 0
            for value in (self.features, self.coordinates)
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
    nodes: dict[int | str, tuple[int | str | None, int | str | None]],
) -> int:
    """Follow every watershed to a terminal and verify declared sink identifiers.

    Args:
        nodes: Bounded native-validation records containing next ID, optional terminal
            ID. These records never leave the validation process.

    Returns:
        Number of distinct terminal watersheds.

    Raises:
        ValueError: If a link is missing, cyclic or has
            an inconsistent declared terminal drainage ID.
    """
    terminals: dict[int | str, int | str] = {}
    for identifier, (downstream, _) in nodes.items():
        if downstream is not None:
            if downstream not in nodes:
                raise ValueError(
                    f"Watershed {identifier!r} links outside the configured network; include all downstream partitions"
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
    for identifier, (_, declared_terminal) in nodes.items():
        if declared_terminal is not None and declared_terminal != terminals[identifier]:
            raise ValueError(
                f"Watershed {identifier!r} has an inconsistent terminal drainage ID"
            )
    return len(set(terminals.values()))


def validate_hydrology_sources(
    definition: PreparedHydrologyDefinition,
    dem: AuthorizedRaster,
    watersheds: ResolvedCatalogSelection,
    limits: HydrologyValidationLimits,
) -> PreparedHydrologySnapshot:
    """Validate network connections and DEM metadata before installing a configuration.

    This reads all watershed records and DEM metadata, but no elevation cells.
    DEM extent, validity and connected boundaries are checked for each run.
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
    nodes: dict[int | str, tuple[int | str | None, int | str | None]] = {}
    terminal_links: dict[int | str, int | str] = {}
    coordinates = 0
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
        with polygon_records(
            watersheds, fields, timeout_seconds=limits.read_timeout_seconds
        ) as records:
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
                coordinates += int(get_num_coordinates(geographic))
                if coordinates > limits.coordinates:
                    raise ValueError(
                        "Watershed validation exceeds its retained-coordinate budget"
                    )
                nodes[identifier] = (
                    None if terminal else next_id,
                    terminal_id,
                )
        if not nodes:
            raise ValueError("The configured watershed network has no polygon features")
        for identifier, downstream in terminal_links.items():
            if downstream in nodes and downstream != identifier:
                raise ValueError(
                    f"Terminal watershed {identifier!r} still links to another watershed; correct the terminal rule"
                )
        terminal_count = validate_network_links(nodes)
        validation = HydrologyValidation(
            validator="eolab.hydrology-validation/v2",
            validatedAt=datetime.now(timezone.utc),
            watershedCount=len(nodes),
            terminalCount=terminal_count,
            demCellsChecked=0,
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
