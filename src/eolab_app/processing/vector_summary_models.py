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
    """Choose original polygons, the grouping attribute and the numeric value field.

    Attributes:
        selection: Catalog or owned-upload identity with its captured predicate.
        groupField: Scalar attribute whose distinct values define output features.
        valueField: Numeric attribute summarized independently of boundary detail.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    selection: VectorSelection
    groupField: FIELD_NAME
    valueField: FIELD_NAME


class VectorSummaryRequest(BaseModel):
    """Capture a grouped polygon summary and its approximate boundary tolerance.

    Attributes:
        vector: Original source selection and attribute names.
        statistic: Reduction over each group's finite original values. Standard
            deviation uses the population formula and is zero for one value.
        boundary_tolerance_m: Approximate simplification distance using a local
            equirectangular scale per group, or zero to retain the dissolved boundary.
            Simplification affects geometry only, never attribute statistics.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    vector: VectorSummaryInput
    statistic: VectorSummaryStatistic
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
    """Retain grouping diagnostics separately from ordinary vector file metadata.

    Attributes:
        summaryField: Generated statistic column, including any collision-avoidance suffix.
        inputFeatureCount: Original features included after applying the captured filter.
        missingValueCount: Included features without a finite numeric value to summarize.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    summaryField: FIELD_NAME
    inputFeatureCount: Annotated[int, Field(strict=True, ge=1)]
    missingValueCount: Annotated[int, Field(strict=True, ge=0)]


@dataclass(frozen=True)
class VectorSummaryArtifact(Artifact):
    """Publish a grouped GeoPackage through the existing artifact lifecycle.

    Attributes:
        feature_count: Number of distinct grouping values written.
        summary_field: Statistic column, including a suffix if the group name collides.
        input_feature_count: Number of original features included in the calculation.
        missing_value_count: Included features whose numeric value was missing.
        result_name: Worker-owned file basename used for atomic publication.
        media_type: Ordinary GeoPackage download format.
    """

    feature_count: int
    summary_field: str
    input_feature_count: int
    missing_value_count: int
    result_name: Literal["result.gpkg"] = field(default="result.gpkg", init=False)
    media_type: Literal["application/geopackage+sqlite3"] = field(
        default="application/geopackage+sqlite3", kw_only=True
    )
