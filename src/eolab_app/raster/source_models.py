"""Path-free raster references and requests shared by catalog and private sources."""

from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Literal

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from eolab_app.raster.models import (
    CatalogRasterPairRequest,
    CatalogRasterRequest,
    RasterStatisticsArea,
)


class RunArtifactReference(BaseModel):
    """Identify an immutable run file whose access belongs to the requesting session."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["runArtifact"]
    job_id: str = Field(alias="jobId", strict=True, pattern=r"^[a-f0-9]{32}$")
    artifact_id: str = Field(alias="artifactId", strict=True, pattern=r"^[a-f0-9]{32}$")


class TemporalVariableSelection(BaseModel):
    """Identify one admitted temporal dataset and a variable within it."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    collection_id: Literal["eolab-temporal-datasets"] = Field(alias="collectionId")
    item_id: str = Field(alias="itemId", strict=True, pattern=r"\S")
    variable: str = Field(strict=True, min_length=1)


@dataclass(frozen=True)
class TemporalVariableMetadata:
    """Describe stored values using metadata admitted by the Catalog.

    Attributes:
        unit: Unit of the stored values, without conversion.
        time_support: Whether a value represents an instant, a mean rate over
            an interval, or an accumulation over an interval.
    """

    unit: str
    time_support: Literal["instantaneous", "mean_rate", "accumulation"]


class TemporalTimeQuery(TemporalVariableSelection):
    """Request a variable's available timestamps in one UTC calendar month.

    Omit month to request the latest published month containing this variable.
    An explicit month remains selected even when it contains no observations.
    """

    month: str | None = Field(default=None, strict=True)

    @field_validator("month")
    @classmethod
    def require_calendar_month(cls, value: str | None) -> str | None:
        """Require a real UTC month written as YYYY-MM when supplied.

        Args:
            value: Optional user-supplied month.

        Returns:
            The unchanged month or None for the latest available month.

        Raises:
            ValueError: If the month is not a valid YYYY-MM calendar month.
        """
        if value is not None:
            date.fromisoformat(f"{value}-01")
        return value


@dataclass(frozen=True)
class TemporalTimeChoices:
    """Describe available months and exact observation labels for one variable.

    Attributes:
        months: Published UTC months containing this variable, in increasing order.
        month: Requested month, or the latest available month when none was supplied.
        times: Actual UTC labels within month, preserving gaps, in ISO format
            with milliseconds and a trailing Z.
    """

    months: tuple[str, ...]
    month: str
    times: tuple[str, ...]


class TemporalRasterSelection(TemporalVariableSelection):
    """Select one observation by its UTC label, independently of map display."""

    time: AwareDatetime

    @field_validator("time")
    @classmethod
    def normalize_time(cls, value: datetime) -> datetime:
        """Return the selected instant in UTC for consistent source identity.

        Args:
            value: Validated timestamp with an explicit timezone.

        Returns:
            The same instant expressed in UTC.
        """
        return value.astimezone(timezone.utc)


class TemporalIntervalSelection(TemporalVariableSelection):
    """Select observations overlapping a start-inclusive, end-exclusive period."""

    start_time: AwareDatetime = Field(alias="startTime")
    end_time: AwareDatetime = Field(alias="endTime")

    @model_validator(mode="after")
    def require_ordered_period(self) -> "TemporalIntervalSelection":
        """Require a positive requested period.

        Returns:
            This validated interval selection.

        Raises:
            ValueError: If the period ends at or before its start.
        """
        if self.end_time <= self.start_time:
            raise ValueError("endTime must be later than startTime")
        return self


RasterSourceReference = CatalogRasterRequest | RunArtifactReference
RasterAnalysisSourceReference = RasterSourceReference | TemporalRasterSelection


class RasterSourceRequest(BaseModel):
    """Request WMS publication of a catalog raster, run file or observation."""

    model_config = ConfigDict(extra="forbid")
    source: RasterSourceReference | TemporalRasterSelection


class RasterAnalysisSourceRequest(BaseModel):
    """Request original-cell analysis of a raster file or temporal observation."""

    model_config = ConfigDict(extra="forbid")
    source: RasterAnalysisSourceReference


class RasterPixelSourceRequest(RasterAnalysisSourceRequest):
    """Read an original raster cell at a longitude and latitude."""

    longitude: float = Field(strict=True, ge=-180, le=180, allow_inf_nan=False)
    latitude: float = Field(strict=True, ge=-90, le=90, allow_inf_nan=False)


class RasterStatisticsSourceRequest(RasterAnalysisSourceRequest, RasterStatisticsArea):
    """Summarize an authorized raster over the chosen sampling area."""


class RasterPairSourceRequest(CatalogRasterPairRequest):
    """Compare two raster sources on the original X reference grid."""

    x_raster: RasterAnalysisSourceReference = Field(alias="xRaster")
    y_raster: RasterAnalysisSourceReference = Field(alias="yRaster")


class RasterReadCapability(BaseModel):
    """Whether a reader supports this source's format, with an explanation when unavailable."""

    supported: bool
    reason: str | None


class RasterSourceCapabilities(BaseModel):
    """Format support for original-cell reading and bounded raster distributions."""

    pixels: RasterReadCapability
    statistics: RasterReadCapability


class RasterSourceDescription(RasterAnalysisSourceRequest):
    """Original raster metadata and current format support without private storage details."""

    version: str
    bounds: tuple[float, float, float, float] | None = None
    width: int
    height: int
    bands: int
    dtype: str
    crs: str
    transform: tuple[float, float, float, float, float, float]
    nodata: float | None
    capabilities: RasterSourceCapabilities


def raster_source_reference(
    request: CatalogRasterRequest | RasterAnalysisSourceRequest,
) -> RasterAnalysisSourceReference:
    """Extract the raster reference from a catalog-only or explicit-source request.

    Args:
        request: Validated flat catalog request or explicit source request.

    Returns:
        Only the source identity, excluding sampling fields.
    """

    if isinstance(request, RasterAnalysisSourceRequest):
        return request.source
    return CatalogRasterRequest(
        collectionId=request.collection_id, itemId=request.item_id
    )
