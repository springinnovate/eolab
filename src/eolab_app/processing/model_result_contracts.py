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
from eolab_app.processing.aggregate_models import AggregateValue
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
    """Describe the observations used to calculate a completed period map.

    Attributes:
        unit: Unit of the resulting values recorded when the run was prepared.
        observationCount: Number of available observations in the requested period;
            individual pixels may have fewer valid values, shown by the count raster.
        firstObservation: UTC label of the first available observation used.
        lastObservation: UTC label of the last available observation used.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    unit: str
    observationCount: Annotated[int, Field(gt=0)]
    firstObservation: AwareDatetime
    lastObservation: AwareDatetime


class ModelRasterResult(ModelResultFile):
    """A raster output produced by any registered operation supporting GeoTIFF."""

    kind: Literal["raster"]
    mediaType: Literal["image/tiff"]
    presentation: Literal["map"]
    grid: RasterResultGrid
    validPixels: Annotated[int, Field(ge=0)]
    temporalCoverage: TemporalResultCoverage | None = Field(
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


ModelResult = Annotated[
    ModelRasterResult | ModelStatisticsResult, Field(discriminator="kind")
]
