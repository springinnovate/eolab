"""Describe one downstream calculation's inputs, native grids and numerical rules."""

from typing import Annotated, Literal

from pydantic import Field, model_validator

from eolab_app.catalog_selection import CatalogSelection
from eolab_app.processing.clip_models import ClipGrid
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
# Admission ceilings are checked again in the native calculation.
MAX_ROUTING_CELLS = 4_000_000
MAX_VALUE_CELLS = 4_000_000
MAX_WATERSHEDS = 100_000
MAX_COORDINATES = 2_000_000
MAX_TERMINALS = 64
MAX_DISTANCE_PAIRS = 4_000_000


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
    watersheds: tuple[NetworkId, ...] = Field(min_length=1, max_length=MAX_WATERSHEDS)
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
    flowThreshold: float = 1e-8
    bufferMetres: float
    cutoffMetres: float | None = None
