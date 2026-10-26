"""Describe one downstream calculation's inputs, native grids and numerical rules."""

from typing import Annotated, Literal

from pydantic import Field, model_validator

from eolab_app.catalog_selection import CatalogSelection, VectorSelection
from eolab_app.processing.clip_models import ClipGrid
from eolab_app.processing.prepared_hydrology import (
    HydrologySchema,
    HydrologySources,
)
from eolab_app.processing.raster_expression import compile_expression, walk
from eolab_app.raster.models import CatalogRasterRequest
from eolab_app.raster.source_models import RasterSourceReference

OPERATION = "hydrology.downstream_beneficiaries.v1"
ECOSHARD_REVISION = "6bd106862a2cb2517f91f9bd7ca8bb071ccb6013"
BENEFICIARIES_REVISION = "3f577e27deb347cd4520977eb99474fb81e990fc"
PIT_FILL_TREAT_NODATA_AS_CLOSED = True

PitFillSearchLimit = Annotated[int, Field(strict=True, ge=-1, le=2**63 - 1)]
"""EcoShard's signed-64-bit pit-search cutoff; -1 and 0 allow unlimited searches."""


class DownstreamSettings(HydrologySchema):
    """Configure pit filling from the downstream model YAML.

    Attributes:
        pit_fill_search_limit: EcoShard's maximum search steps for one pit.
            Values -1 and 0 leave the search unlimited.
    """

    pit_fill_search_limit: PitFillSearchLimit


class RasterStartingMask(HydrologySchema):
    """Use positive, valid cells of a catalog raster as downstream starting cells."""

    kind: Literal["catalogRaster"]
    source: CatalogRasterRequest


class VectorStartingMask(HydrologySchema):
    """Combine selected catalog or uploaded vector features into one starting mask."""

    kind: Literal["catalogSelection"]
    selection: VectorSelection


StartingMask = Annotated[
    RasterStartingMask | VectorStartingMask, Field(discriminator="kind")
]


class DownstreamRequest(HydrologySchema):
    """Capture the starting area, configured sources, values and formula for one run.

    Model YAML supplies hydrology sources and pit-filling settings. Geometry and
    filesystem paths are absent.
    """

    requestId: str
    label: Annotated[str, Field(min_length=1, max_length=80)]
    starting_mask: StartingMask
    hydrology: HydrologySources
    settings: DownstreamSettings
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
    """Hold accepted downstream inputs until the worker resolves their source files."""

    operation: Literal["hydrology.downstream_beneficiaries.v1"] = OPERATION
    request: DownstreamRequest


class DownstreamPlan(HydrologySchema):
    """Record the values grid, current watershed source and pit-filling settings.

    Resolved selections are ephemeral worker arguments and never enter storage.
    The original model constructs its own calculation grid using the captured
    pixel-size setting. Captured inputs include the model's pit-search cutoff;
    execution uses that saved value.
    """

    operation: Literal["hydrology.downstream_beneficiaries.v1"] = OPERATION
    inputs: DownstreamRequest
    grid: ClipGrid
    watershedSelection: CatalogSelection
    reservedBytes: Annotated[int, Field(ge=0)]

    @model_validator(mode="after")
    def check_watershed_selection(self) -> "DownstreamPlan":
        """Require a plan's saved watershed identity to match its configured source.

        Returns:
            This plan with a complete, unfiltered source identity for execution.

        Raises:
            ValueError: If the source identity is missing, filtered or belongs to
                a different configured layer.
        """
        selection = self.watershedSelection
        configured = self.inputs.hydrology.watersheds
        if (
            selection.collection_id != configured.collection_id
            or selection.item_id != configured.item_id
            or selection.filter.active
        ):
            raise ValueError(
                "The plan requires the complete configured watershed layer"
            )
        return self


class ClosedEdgeDownstreamNumericalPolicy(HydrologySchema):
    """Record closed-edge pit filling before the original WWF MFD calculation.

    The search limit uses EcoShard's exploration cutoff, not an exact count of
    changed elevations. NoData remains unchanged and MFD retains its edge fallback.
    """

    version: Literal["hydrology.downstream_beneficiaries.v3"]
    beneficiariesRevision: Literal["3f577e27deb347cd4520977eb99474fb81e990fc"] = (
        BENEFICIARIES_REVISION
    )
    ecoshardRevision: Literal["6bd106862a2cb2517f91f9bd7ca8bb071ccb6013"] = (
        ECOSHARD_REVISION
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
    pitFillSearchLimit: PitFillSearchLimit
    pitFillTreatNodataAsClosed: Literal[True] = PIT_FILL_TREAT_NODATA_AS_CLOSED
