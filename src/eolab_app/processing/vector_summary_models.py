"""Describe grouped polygon statistics and their ordinary Processing result files."""

from dataclasses import dataclass, field
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from eolab_app.catalog_selection import VectorSelection
from eolab_app.processing.models import Artifact

OPERATION = "vector.summary.v1"
FIELD_NAME = Annotated[str, Field(strict=True, min_length=1, max_length=256)]
VectorSummaryStatistic = Literal["sum", "mean", "max", "min", "stdev"]
"""Supported group reductions; stdev uses the population standard deviation."""


class VectorSummaryInput(BaseModel):
    """Choose original polygons and the attribute that groups their features.

    Attributes:
        selection: Catalog or owned-upload identity with its captured predicate.
        groupField: Scalar attribute whose distinct values define output features.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    selection: VectorSelection
    groupField: FIELD_NAME


class VectorSummaryCalculation(BaseModel):
    """Select one numeric field and the statistic written for each group.

    Attributes:
        field: Original numeric attribute, independent of boundary detail.
        statistic: Reduction over finite values; stdev uses population deviation.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    field: FIELD_NAME
    statistic: VectorSummaryStatistic


class VectorSummaryRequest(BaseModel):
    """Capture a grouped polygon summary and its approximate boundary tolerance.

    Attributes:
        vector: Original source selection and attribute names.
        summaries: Ordered field/statistic pairs, each producing its own column.
            Repeated fields share their original values and all pairs share geometry.
        boundary_tolerance_m: Approximate simplification distance using a local
            equirectangular scale per group, or zero to retain the dissolved boundary.
            Simplification affects geometry only, never attribute statistics.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    vector: VectorSummaryInput
    summaries: Annotated[tuple[VectorSummaryCalculation, ...], Field(min_length=1)]
    boundary_tolerance_m: Annotated[float, Field(ge=0, allow_inf_nan=False)]


class QueuedVectorSummary(BaseModel):
    """Keep a path-free vector summary until an ordinary worker claims it."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["vector.summary.v1"] = OPERATION
    request: VectorSummaryRequest


class VectorSummarySpec(BaseModel):
    """Supply the captured source and field choices to native summary execution."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["vector.summary.v1"] = OPERATION
    inputs: VectorSummaryRequest


class VectorSummaryPolicy(BaseModel):
    """Record boundary detail and the missing-value rules used by a summary.

    Missing grouping values form one group. Missing and non-finite numeric
    values do not contribute; a group with no finite values receives a null result.
    The captured invocation records the statistic chosen for this run.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    boundaryToleranceMeters: Annotated[float, Field(ge=0, allow_inf_nan=False)]
    missingGroups: Literal["one-null-group"] = "one-null-group"
    missingValues: Literal["ignore-null-total-if-all-missing"] = (
        "ignore-null-total-if-all-missing"
    )


class VectorSummaryDetails(BaseModel):
    """Describe the primary statistic used for the layer's initial presentation.

    Attributes:
        summaryField: First requested statistic's generated output column.
        inputFeatureCount: Original features included after applying the captured filter.
        missingValueCount: Included features missing the first pair's numeric value.
            Full per-column diagnostics are recorded in the calculation provenance.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    summaryField: FIELD_NAME
    inputFeatureCount: Annotated[int, Field(strict=True, ge=1)]
    missingValueCount: Annotated[int, Field(strict=True, ge=0)]


@dataclass(frozen=True)
class VectorSummaryColumn:
    """Carry one calculated column's provenance into ordinary result publication.

    Attributes:
        source_field: Original numeric attribute used by this calculation.
        statistic: Reduction over finite original values.
        output_field: Unique output column name.
        missing_value_count: Selected features without a finite value for this field.
    """

    source_field: str
    statistic: VectorSummaryStatistic
    output_field: str
    missing_value_count: int


@dataclass(frozen=True)
class VectorSummaryArtifact(Artifact):
    """Publish a grouped GeoPackage through the existing artifact lifecycle.

    Attributes:
        feature_count: Number of distinct grouping values written.
        columns: Ordered statistic columns and their source-value diagnostics.
        summary_field: First requested output column, used for initial layer styling.
        input_feature_count: Number of original features included in the calculation.
        missing_value_count: Missing-value count for the primary presentation column.
        result_name: Worker-owned file basename used for atomic publication.
        media_type: Ordinary GeoPackage download format.
    """

    feature_count: int
    columns: tuple[VectorSummaryColumn, ...]
    summary_field: str
    input_feature_count: int
    missing_value_count: int
    result_name: Literal["result.gpkg"] = field(default="result.gpkg", init=False)
    media_type: Literal["application/geopackage+sqlite3"] = field(
        default="application/geopackage+sqlite3", kw_only=True
    )
