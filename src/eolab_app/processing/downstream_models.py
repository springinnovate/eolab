"""Describe one downstream calculation's inputs, native grids and numerical rules."""

from dataclasses import asdict, dataclass, fields
from typing import Annotated, Literal
from sys import float_info

from pydantic import Field, RootModel, model_validator

from eolab_app.catalog_selection import CatalogSelection
from eolab_app.processing.clip_models import ClipGrid, RasterClipLimits
from eolab_app.processing.models import ProcessingLimits
from eolab_app.processing.prepared_hydrology import (
    HydrologySchema,
    HydrologySources,
    PreparedHydrologySnapshot,
    NetworkId,
)
from eolab_app.processing.raster_expression import compile_expression, walk
from eolab_app.raster.models import CatalogRasterRequest
from eolab_app.raster.source_models import RasterSourceReference

OPERATION = "hydrology.downstream_beneficiaries.v1"
ECOSHARD_REVISION = "6bd106862a2cb2517f91f9bd7ca8bb071ccb6013"
BENEFICIARIES_REVISION = "3f577e27deb347cd4520977eb99474fb81e990fc"
DEFAULT_PIT_FILL_SEARCH_LIMIT = 1000
PIT_FILL_TREAT_NODATA_AS_CLOSED = True
FLOW_THRESHOLD = 100 * float_info.epsilon

PitFillSearchLimit = Annotated[int, Field(strict=True, ge=-1, le=2**63 - 1)]
"""EcoShard's signed-64-bit pit-search cutoff; -1 and 0 allow unlimited searches."""


@dataclass(frozen=True)
class DownstreamLimits(RasterClipLimits):
    """Configure downstream job scheduling, result retention and pit filling.

    The original WWF model runs without EOlab cell, geometry, memory, disk or
    total-runtime admission ceilings. The worker captures the pit-search cutoff
    in each prepared plan; it controls terrain conditioning, not job admission.

    Attributes:
        pit_fill_search_limit: EcoShard's maximum search steps for one pit.
            Values -1 and 0 leave the search unlimited.
    """

    pit_fill_search_limit: int = DEFAULT_PIT_FILL_SEARCH_LIMIT

    @classmethod
    def with_lifecycle(cls, limits: ProcessingLimits) -> "DownstreamLimits":
        """Copy shared job lifecycle settings for downstream calculations.

        Args:
            limits: Worker lifecycle settings, possibly with another operation's
                additional budgets; matching downstream fields are preserved.

        Returns:
            Downstream settings with the same job lifecycle policy.
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
    """Capture the starting area, configured sources, values and formula for one run.

    Model YAML supplies hydrology sources; historical registration snapshots
    remain readable in saved runs. Geometry and filesystem paths are absent.
    """

    requestId: str
    label: Annotated[str, Field(min_length=1, max_length=80)]
    starting_mask: StartingMask
    hydrology: HydrologySources | PreparedHydrologySnapshot
    values: RasterSourceReference
    buffer_m: Annotated[float, Field(ge=0)]
    cutoff_m: Annotated[float, Field(gt=0)] | None
    wgs84_pixel_size: Annotated[float, Field(gt=0)] = 0.008333333333333
    travel_time_pixel_size_m: Annotated[float, Field(gt=0)] = 900
    summary: Annotated[str, Field(min_length=1, max_length=4096)]

    @property
    def hydrology_sources(self) -> HydrologySources:
        """Return the configured catalog sources from a current or historical run.

        Returns:
            DEM, watershed source and topology without historical eligibility data.
        """
        if isinstance(self.hydrology, HydrologySources):
            return self.hydrology
        definition = self.hydrology.definition
        return HydrologySources(
            dem=definition.dem,
            watersheds=definition.watersheds,
            topology=definition.topology,
        )

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
    """Hold accepted downstream inputs until the worker resolves their source files."""

    operation: Literal["hydrology.downstream_beneficiaries.v1"] = OPERATION
    request: DownstreamRequest


class DownstreamPlan(HydrologySchema):
    """Record the values grid, current watershed source and pit-filling settings.

    Resolved selections are ephemeral worker arguments and never enter storage.
    The original model constructs its own calculation grid using the captured
    pixel-size setting. The worker saves its pit-search cutoff during preparation;
    execution uses this value even if supplied different worker settings later.
    Historical plans without the cutoff retain the original default of 100.
    """

    operation: Literal["hydrology.downstream_beneficiaries.v1"] = OPERATION
    inputs: DownstreamRequest
    grid: ClipGrid
    watershedSelection: CatalogSelection | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    # Historical plans retain their original admission metadata for export.
    routingGrid: ClipGrid | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    watersheds: tuple[NetworkId, ...] | None = Field(
        default=None, min_length=1, exclude_if=lambda value: value is None
    )
    reservedBytes: Annotated[int, Field(ge=0)]
    sourceChecksum: str | None = None
    # Missing fields describe older runs, not the current deployment default.
    pit_fill_search_limit: PitFillSearchLimit = 100

    @model_validator(mode="after")
    def check_watershed_selection(self) -> "DownstreamPlan":
        """Require a plan's saved watershed identity to match its configured source.

        Returns:
            This plan with a complete, unfiltered source identity for execution.

        Raises:
            ValueError: If the source identity is missing, filtered or belongs to
                a different configured layer.
        """
        selection = self.watershed_selection
        configured = self.inputs.hydrology_sources.watersheds
        if (
            selection.collection_id != configured.collection_id
            or selection.item_id != configured.item_id
            or selection.filter.active
        ):
            raise ValueError(
                "The plan requires the complete configured watershed layer"
            )
        return self

    @property
    def watershed_selection(self) -> CatalogSelection:
        """Read the source identity captured for this run's watershed reads.

        Returns:
            Preparation-time selection, or a historical run's saved selection.

        Raises:
            ValueError: If a persisted plan omitted its watershed source identity.
        """
        if self.watershedSelection is not None:
            return self.watershedSelection
        if isinstance(self.inputs.hydrology, PreparedHydrologySnapshot):
            return self.inputs.hydrology.watershedSelection
        raise ValueError("The downstream plan has no captured watershed source")


class DownstreamNumericalPolicy(HydrologySchema):
    """Read the numerical rules retained with historical reimplementation runs."""

    version: Literal["hydrology.downstream_beneficiaries.v1"] = OPERATION
    ecoshardRevision: Literal["f7e2adba2a4d41128aea941bb747470418d2dce9"] = (
        "f7e2adba2a4d41128aea941bb747470418d2dce9"
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


class WrappedDownstreamNumericalPolicy(HydrologySchema):
    """Read historical WWF runs that allowed drainage to NoData during filling."""

    version: Literal["hydrology.downstream_beneficiaries.v2"] = (
        "hydrology.downstream_beneficiaries.v2"
    )
    beneficiariesRevision: Literal["7e32ae28540ab53178248758a6f40affea8d6ff6"] = (
        "7e32ae28540ab53178248758a6f40affea8d6ff6"
    )
    ecoshardRevision: Literal["f7e2adba2a4d41128aea941bb747470418d2dce9"] = (
        "f7e2adba2a4d41128aea941bb747470418d2dce9"
    )
    calculation: Literal["unchanged_upstream_functions"] = (
        "unchanged_upstream_functions"
    )
    defaultSummary: Literal["upstream_mask_population_with_coverage_total"] = (
        "upstream_mask_population_with_coverage_total"
    )
    otherSummaries: Literal["eolab_formula_on_upstream_masked_values"] = (
        "eolab_formula_on_upstream_masked_values"
    )
    wgs84PixelSize: float
    distancePixelSizeMetres: float
    bufferMetres: float
    cutoffMetres: float | None = None


class ClosedEdgeDownstreamNumericalPolicy(WrappedDownstreamNumericalPolicy):
    """Record closed-edge pit filling before the original WWF MFD calculation.

    The search limit uses EcoShard's exploration cutoff, not an exact count of
    changed elevations. NoData remains unchanged and MFD retains its edge fallback.
    Historical policies without the cutoff retain the original default of 100.
    """

    version: Literal["hydrology.downstream_beneficiaries.v3"] = (
        "hydrology.downstream_beneficiaries.v3"
    )
    beneficiariesRevision: Literal["3f577e27deb347cd4520977eb99474fb81e990fc"] = (
        BENEFICIARIES_REVISION
    )
    ecoshardRevision: Literal["6bd106862a2cb2517f91f9bd7ca8bb071ccb6013"] = (
        ECOSHARD_REVISION
    )
    pitFillSearchLimit: PitFillSearchLimit = 100
    pitFillTreatNodataAsClosed: Literal[True] = PIT_FILL_TREAT_NODATA_AS_CLOSED


class DownstreamPolicy(
    RootModel[
        Annotated[
            DownstreamNumericalPolicy
            | WrappedDownstreamNumericalPolicy
            | ClosedEdgeDownstreamNumericalPolicy,
            Field(discriminator="version"),
        ]
    ]
):
    """Read both historical calculations and the current upstream model provenance."""
