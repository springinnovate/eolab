"""Scientific result types shared by models, independent of their algorithms."""

from typing import Annotated, Literal
from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    FiniteFloat,
    model_validator,
)
from eolab_app.processing.aggregate_models import AggregateValue, NamedCalculation
from eolab_app.processing.models import JobResultResponse


class RasterResultGrid(BaseModel):
    """The dimensions, coordinate system and datatype of a downloadable raster.

    Operation preparation may contain additional scheduling/window metadata.
    Only these file properties are exposed in the shared raster result contract.
    """

    model_config = ConfigDict(extra="ignore", frozen=True)
    width: Annotated[int, Field(gt=0)]
    height: Annotated[int, Field(gt=0)]
    crs: Annotated[str, Field(min_length=1)]
    dtype: Annotated[str, Field(min_length=1)]
    transform: tuple[
        FiniteFloat, FiniteFloat, FiniteFloat, FiniteFloat, FiniteFloat, FiniteFloat
    ]


class ModelResultFile(JobResultResponse):
    """Owned download metadata and the output name chosen by a YAML recipe."""

    name: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")]
    label: Annotated[str, Field(min_length=1, max_length=80)]
    displayName: str
    role: Literal["result"]


class TemporalResultCoverage(BaseModel):
    """Describe the observations used to calculate a completed temporal result.

    Attributes:
        unit: Shared output unit recorded during preparation, or an empty string
            when named formulas have no inferred common unit.
        observationCount: Number of available observations in the requested period.
            Missing cell values are reported separately by each output type.
        firstObservation: UTC label of the first available observation used.
        lastObservation: UTC label of the last available observation used.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    unit: str
    observationCount: Annotated[int, Field(gt=0)]
    firstObservation: AwareDatetime
    lastObservation: AwareDatetime


class PreparedInputCoverage(BaseModel):
    """Count prepared geographic input tiles used by a completed calculation.

    These counts describe whole cached files intersecting the requested area,
    not valid-pixel coverage or the fraction of the area's surface assessed.

    Attributes:
        requiredTiles: Geographic tiles intersecting the requested analysis area.
        cachedTiles: Complete prepared tiles available when calculation started.
        missingTiles: Required tiles unavailable to the calculation; their areas
            remain NoData rather than receiving fabricated model inputs.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    requiredTiles: Annotated[int, Field(gt=0)]
    cachedTiles: Annotated[int, Field(gt=0)]
    missingTiles: Annotated[int, Field(ge=0)]


class ModelRasterResult(ModelResultFile):
    """A raster output produced by any registered operation supporting GeoTIFF.

    preparedInputCoverage is present when a run records which prepared geographic
    tiles it used. Other input modes and results saved before availability was
    recorded omit it; validPixels always describes the written result itself.
    """

    kind: Literal["raster"]
    mediaType: Literal["image/tiff"]
    presentation: Literal["map"]
    grid: RasterResultGrid
    validPixels: Annotated[int, Field(ge=0)]
    temporalCoverage: TemporalResultCoverage | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    preparedInputCoverage: PreparedInputCoverage | None = Field(
        default=None, exclude_if=lambda value: value is None
    )

    @model_validator(mode="after")
    def check_valid_pixels(self) -> "ModelRasterResult":
        """Check the reported valid-pixel count against the raster dimensions.

        Returns:
            This result after checking the count.

        Raises:
            ValueError: If more pixels are reported than the raster contains.
        """
        if self.validPixels > self.grid.width * self.grid.height:
            raise ValueError("Valid pixels exceed the raster dimensions")
        return self


class ModelStatisticsResult(ModelResultFile):
    """Scalar statistics and a CSV produced by a registered summary operation."""

    kind: Literal["statistics"]
    mediaType: Literal["text/csv"]
    presentation: Literal["table"]
    rows: list[AggregateValue] = Field(min_length=1, max_length=5)
    cacheHit: bool = False


class ModelTimeSeriesResult(ModelResultFile):
    """Downloadable named calculations for each available temporal observation.

    Rows remain in the CSV, avoiding an unbounded observation list in job status.
    Units and observed dates describe the actual calculation, including gaps.
    """

    kind: Literal["timeSeries"]
    mediaType: Literal["text/csv"]
    presentation: Literal["download"]
    calculations: Annotated[
        tuple[NamedCalculation, ...], Field(min_length=1, max_length=5)
    ]
    temporalCoverage: TemporalResultCoverage


ModelResult = Annotated[
    ModelRasterResult | ModelStatisticsResult | ModelTimeSeriesResult,
    Field(discriminator="kind"),
]
