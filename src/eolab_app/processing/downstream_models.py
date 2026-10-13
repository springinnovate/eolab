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
    PreparedHydrologySnapshot,
    NetworkId,
)
from eolab_app.processing.raster_expression import compile_expression, walk
from eolab_app.raster.models import CatalogRasterRequest
from eolab_app.raster.source_models import RasterSourceReference

OPERATION = "hydrology.downstream_beneficiaries.v1"
ECOSHARD_REVISION = "8d6b778edbaaff6e5dc3cc04d9da7f9416522054"
BENEFICIARIES_REVISION = "3f577e27deb347cd4520977eb99474fb81e990fc"
PIT_FILL_SEARCH_LIMIT = 100
PIT_FILL_TREAT_NODATA_AS_CLOSED = True
FLOW_THRESHOLD = 100 * float_info.epsilon


@dataclass(frozen=True)
class DownstreamLimits(RasterClipLimits):
    """Configure downstream job scheduling and result retention.

    The original WWF model runs without EOlab cell, geometry, memory, disk or
    total-runtime admission ceilings. Its numerical inputs are captured separately
    in DownstreamRequest.
    """

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
    """Capture the starting area, prepared terrain, values and formula for one run.

    Hydrology is a server-resolved snapshot. The browser supplies only its opaque
    reference through ModelRunRequest. Geometry and filesystem paths are absent.
    """

    requestId: str
    label: Annotated[str, Field(min_length=1, max_length=80)]
    starting_mask: StartingMask
    hydrology: PreparedHydrologySnapshot
    values: RasterSourceReference
    buffer_m: Annotated[float, Field(ge=0)]
    cutoff_m: Annotated[float, Field(gt=0)] | None
    wgs84_pixel_size: Annotated[float, Field(gt=0)] = 0.008333333333333
    travel_time_pixel_size_m: Annotated[float, Field(gt=0)] = 900
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
    These grids measure native input work for admission. The original model
    constructs its own calculation grid using the captured pixel-size setting.
    """

    operation: Literal["hydrology.downstream_beneficiaries.v1"] = OPERATION
    inputs: DownstreamRequest
    grid: ClipGrid
    routingGrid: ClipGrid
    watersheds: tuple[NetworkId, ...] = Field(min_length=1)
    reservedBytes: Annotated[int, Field(ge=0)]
    sourceChecksum: str | None = None


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
    """

    version: Literal["hydrology.downstream_beneficiaries.v3"] = (
        "hydrology.downstream_beneficiaries.v3"
    )
    beneficiariesRevision: Literal["3f577e27deb347cd4520977eb99474fb81e990fc"] = (
        BENEFICIARIES_REVISION
    )
    ecoshardRevision: Literal["8d6b778edbaaff6e5dc3cc04d9da7f9416522054"] = (
        ECOSHARD_REVISION
    )
    pitFillSearchLimit: Literal[100] = PIT_FILL_SEARCH_LIMIT
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
