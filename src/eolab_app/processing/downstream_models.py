"""Describe one downstream calculation's inputs, native grids and numerical rules."""

from dataclasses import asdict, dataclass, fields
from typing import Annotated, Literal
from sys import float_info

from pydantic import Field, model_validator

from eolab_app.catalog_selection import CatalogSelection
from eolab_app.processing.clip_models import ClipGrid, RasterClipLimits
from eolab_app.processing.models import ProcessingLimits
from eolab_app.processing.prepared_hydrology import (
    HydrologySchema,
    PreparedHydrologySnapshot,
    NetworkId,
)
from eolab_app.processing.raster_expression import compile_expression, walk
from eolab_app.raster.models import CatalogRasterRequest
from eolab_app.raster.source_models import RasterSourceReference

OPERATION = "hydrology.downstream_beneficiaries.v1"
ECOSHARD_REVISION = "f7e2adba2a4d41128aea941bb747470418d2dce9"
FLOW_THRESHOLD = 100 * float_info.epsilon


@dataclass(frozen=True)
class DownstreamLimits(RasterClipLimits):
    """Administrator budgets for native downstream work, in addition to job limits.

    Defaults describe the measured small-region profile, not dataset dimensions
    or algorithmic maxima. Deployment settings can raise or lower them; memory,
    disk, native-reader and execution-time limits still apply independently.

    Attributes:
        max_routing_cells: Sum of routing-window cells over separate sink groups.
        max_value_cells: Native cells in the values-raster window.
        max_mask_cells: Native cells read from a raster starting mask.
        max_watersheds: Watershed records retained for one run.
        max_watershed_coordinates: Coordinates retained across those polygons.
        max_terminals: Independent sink groups routed sequentially.
        max_distance_pairs: Ambiguous candidate pairs checked with exact geodesics.
    """

    max_routing_cells: int = 4_000_000
    max_value_cells: int = 4_000_000
    max_mask_cells: int = 4_000_000
    max_watersheds: int = 100_000
    max_watershed_coordinates: int = 2_000_000
    max_terminals: int = 64
    max_distance_pairs: int = 4_000_000

    @classmethod
    def with_lifecycle(cls, limits: ProcessingLimits) -> "DownstreamLimits":
        """Copy shared job and source budgets, leaving unrelated operation settings out.

        Args:
            limits: Worker lifecycle settings, possibly with another operation's
                additional budgets; matching downstream fields are preserved.

        Returns:
            Downstream settings with the shared budgets and remaining defaults.
        """
        accepted = {field.name for field in fields(cls)}
        return cls(
            **{
                name: value
                for name, value in asdict(limits).items()
                if name in accepted
            }
        )


class RasterStartingMask(HydrologySchema):
    """Use positive, valid cells of a catalog raster as downstream starting cells."""

    kind: Literal["catalogRaster"]
    source: CatalogRasterRequest


class VectorStartingMask(HydrologySchema):
    """Combine the filtered features of a catalog vector into one starting mask."""

    kind: Literal["catalogSelection"]
    selection: CatalogSelection


StartingMask = Annotated[
    RasterStartingMask | VectorStartingMask, Field(discriminator="kind")
]


class DownstreamRequest(HydrologySchema):
    """Capture the starting area, prepared terrain, values and formula for one run.

    Hydrology is a server-resolved snapshot. The browser supplies only its opaque
    reference through ModelRunRequest. Geometry and filesystem paths are absent.
    """

    requestId: str
    label: Annotated[str, Field(min_length=1, max_length=80)]
    starting_mask: StartingMask
    hydrology: PreparedHydrologySnapshot
    values: RasterSourceReference
    buffer_m: Annotated[float, Field(ge=0, le=100_000)]
    cutoff_m: Annotated[float, Field(gt=0, le=1_000_000)] | None
    summary: Annotated[str, Field(min_length=1, max_length=4096)]

    @model_validator(mode="after")
    def check_formula(self) -> "DownstreamRequest":
        """Reject point formulas that have no meaning for a downstream region.

        Returns:
            This request with a compiled, bounded scalar formula.

        Raises:
            ValueError: If a point-only function is requested.
            ProcessingError: If formula syntax or types are invalid.
        """
        if any(
            node.op == "pixelValue"
            for node in walk(compile_expression(self.summary, "a"))
        ):
            raise ValueError("Downstream summaries require an area formula")
        return self


class QueuedDownstream(HydrologySchema):
    """Hold accepted downstream inputs until the worker measures their native work."""

    operation: Literal["hydrology.downstream_beneficiaries.v1"] = OPERATION
    request: DownstreamRequest


class DownstreamPlan(HydrologySchema):
    """Record admitted native windows and watershed identities without retaining geometry.

    Resolved selections are ephemeral worker arguments and never enter storage.
    The routing grid remains the original DEM grid; the values grid is independent.
    """

    operation: Literal["hydrology.downstream_beneficiaries.v1"] = OPERATION
    inputs: DownstreamRequest
    grid: ClipGrid
    routingGrid: ClipGrid
    watersheds: tuple[NetworkId, ...] = Field(min_length=1)
    reservedBytes: Annotated[int, Field(gt=0)]
    sourceChecksum: str | None = None


class DownstreamNumericalPolicy(HydrologySchema):
    """Record routing, distance, coverage and value rules actually used by the adapter."""

    version: Literal["hydrology.downstream_beneficiaries.v1"] = OPERATION
    ecoshardRevision: Literal["f7e2adba2a4d41128aea941bb747470418d2dce9"] = (
        ECOSHARD_REVISION
    )
    routing: Literal["mfd_prepared_dem_native_grid"] = "mfd_prepared_dem_native_grid"
    seeds: Literal["cell_center_positive_valid_raster_or_filtered_vector"] = (
        "cell_center_positive_valid_raster_or_filtered_vector"
    )
    distance: Literal["wgs84_geodesic_between_cell_centers"] = (
        "wgs84_geodesic_between_cell_centers"
    )
    coverage: Literal["union_buffered_downstream_cells_then_seed_distance_cutoff"] = (
        "union_buffered_downstream_cells_then_seed_distance_cutoff"
    )
    valueGrid: Literal["native_no_resampling"] = "native_no_resampling"
    valueInclusion: Literal["native_cell_center_in_binary_dem_coverage"] = (
        "native_cell_center_in_binary_dem_coverage"
    )
    sourceValidity: Literal["finite-unmasked-non-nodata-v1"] = (
        "finite-unmasked-non-nodata-v1"
    )
    signedAndZeroValues: Literal["included"] = "included"
    flowThreshold: float = FLOW_THRESHOLD
    bufferMetres: float
    cutoffMetres: float | None = None
