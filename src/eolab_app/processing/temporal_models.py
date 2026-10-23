"""Describe a temporal period map, its native grid and completed raster files."""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Annotated, Any, Literal, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ModelWrapValidatorHandler,
    model_validator,
)

from eolab_app.catalog_selection import VectorSelection
from eolab_app.processing.aggregate_models import AggregateArea
from eolab_app.processing.models import Artifact
from eolab_app.processing.polygon_areas import PolygonAreaReference
from eolab_app.raster.models import Wgs84Bounds
from eolab_app.raster.source_models import TemporalIntervalSelection


class TemporalReduction(BaseModel):
    """One equal-weight statistic over valid observations at each cell.

    Standard deviation is the population statistic. Percentiles use exact linear
    interpolation between ordered values; percentile is required only for that
    reducer. Sums retain the variable's units and do not integrate over time.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    reducer: Literal["sum", "mean", "min", "max", "median", "percentile", "stdev"]
    percentile: Annotated[float, Field(ge=0, le=100, allow_inf_nan=False)] | None = None

    @model_validator(mode="wrap")
    @classmethod
    def require_percentile_choice(
        cls, value: Any, handler: ModelWrapValidatorHandler[Self]
    ) -> Self:
        """Require a percentile value exactly when the percentile reducer is chosen.

        Args:
            value: External or persisted input, or an already validated choice.
            handler: Pydantic's field validation and construction handler.

        Returns:
            The validated statistic choice.

        Raises:
            ValueError: If the chosen statistic and percentile value disagree.
        """
        choice = handler(value)
        if choice is not value and (choice.reducer == "percentile") != (
            choice.percentile is not None
        ):
            raise ValueError("Supply percentile only for the percentile reducer")
        return choice


class TemporalMapRequest(BaseModel):
    """Request a period statistic for one temporal variable and one explicit area."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    source: TemporalIntervalSelection
    reduction: TemporalReduction
    selectedBounds: Wgs84Bounds | None = None
    catalogSelection: VectorSelection | None = None
    polygonArea: PolygonAreaReference | None = None
    wholeRaster: Literal[True] | None = None

    @model_validator(mode="wrap")
    @classmethod
    def require_one_area(
        cls, value: Any, handler: ModelWrapValidatorHandler[Self]
    ) -> Self:
        """Require one area at the request and persisted-job boundary.

        Args:
            value: Input dictionary or an already validated request.
            handler: Pydantic's field validation and construction handler.

        Returns:
            The validated request.

        Raises:
            ValueError: If the request does not choose exactly one area.
        """
        request = handler(value)
        if (
            request is not value
            and sum(
                area is not None
                for area in (
                    request.selectedBounds,
                    request.catalogSelection,
                    request.polygonArea,
                    request.wholeRaster,
                )
            )
            != 1
        ):
            raise ValueError(
                "Choose one box, vector selection, polygon area, or whole raster"
            )
        return request


class QueuedTemporalMap(BaseModel):
    """Submitted interval and area retained until a worker can open the sources."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["temporal.reduce.v1"] = "temporal.reduce.v1"
    request: TemporalMapRequest
    polygonArea: AggregateArea | None = None


class TemporalMapGrid(BaseModel):
    """Describe an output crop and the native windows used to calculate it.

    columnRotation is the integral source-column shift applied before selecting
    the crop; every observation uses the same shift. window is the crop in that
    shifted source grid. transform is the output crop's affine transform.
    tileHeight and tileWidth are native read-block dimensions, and tileCount is
    the number of spatial tiles intersecting the crop, independently of time.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    crs: str
    transform: tuple[float, float, float, float, float, float]
    window: tuple[int, int, int, int]
    width: int
    height: int
    dtype: Literal["float64"] = "float64"
    columnRotation: int
    tileHeight: int
    tileWidth: int
    tileCount: int


class TemporalMapSpec(BaseModel):
    """A path-free period-map plan with a compact observation summary.

    The authorized observations and their file locations stay in worker memory.
    Detailed observation labels and support intervals belong in provenance.json.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["temporal.reduce.v1"] = "temporal.reduce.v1"
    source: TemporalIntervalSelection
    reduction: TemporalReduction
    area: AggregateArea
    grid: TemporalMapGrid
    unit: str
    observationCount: int
    firstObservation: datetime
    lastObservation: datetime


@dataclass(frozen=True)
class TemporalMapArtifact(Artifact):
    """Completed statistic raster, count raster and statistic's valid-cell count."""

    valid_pixels: int
    media_type: str = field(default="image/tiff", kw_only=True)
