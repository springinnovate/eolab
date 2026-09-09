"""Strict single-raster calculation plans and operation-specific result values."""

from dataclasses import dataclass, field, fields
from datetime import datetime
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SerializerFunctionWrapHandler,
    model_serializer,
    model_validator,
)

from eolab_app.processing.models import (
    Artifact,
    JobProgressResponse,
    JobResponse,
    JobResultResponse,
    OpaqueId,
    ProcessingLimits,
    ProcessingError,
)
from eolab_app.processing.raster_expression import FUNCTIONS, compile_expression, walk
from eolab_app.raster.models import CatalogRasterRequest, Wgs84Bounds

OPERATION_VERSION = "raster.aggregate.v1"
Alias = Annotated[str, Field(pattern=r"^[A-Za-z][A-Za-z0-9_]{0,31}$")]


class NamedCalculation(BaseModel):
    """One user-labeled scalar expression, with no executable payload."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    label: Annotated[str, Field(min_length=1, max_length=80)]
    expression: Annotated[str, Field(min_length=1, max_length=4096)]


class AggregateValidationRequest(BaseModel):
    """Bounded language validation independent of source lookup and raster I/O."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    alias: Alias = "a"
    calculations: Annotated[
        tuple[NamedCalculation, ...], Field(min_length=1, max_length=5)
    ]

    @model_validator(mode="after")
    def validate_language(self) -> "AggregateValidationRequest":
        """Check the same bounded language used by planning and execution.

        Returns:
            The checked request.

        Raises:
            ValueError: For invalid aliases, labels, types, or expression budget.
        """
        alias = self.alias
        if alias in FUNCTIONS | {"where"}:
            raise ValueError("The raster alias cannot be a function or keyword")
        if len({item.label for item in self.calculations}) != len(self.calculations):
            raise ValueError("Calculation labels must be unique")
        if (
            sum(len(item.expression.encode("utf-8")) for item in self.calculations)
            > 4096
        ):
            raise ValueError("All expressions together must fit within 4 KiB")
        try:
            trees = [
                compile_expression(item.expression, alias) for item in self.calculations
            ]
        except ProcessingError as error:
            raise ValueError(error.detail) from error
        if sum(sum(1 for _ in walk(tree)) for tree in trees) > 256:
            raise ValueError(
                "All expressions together must use at most 256 syntax nodes"
            )
        return self


class AggregatePlanRequest(BaseModel):
    """Exactly one catalog binding, bounded expressions, and an explicit area."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    sources: Annotated[
        dict[Alias, CatalogRasterRequest], Field(min_length=1, max_length=1)
    ]
    calculations: Annotated[
        tuple[NamedCalculation, ...], Field(min_length=1, max_length=5)
    ]
    selectedBounds: Wgs84Bounds | None = None
    temporaryAoiId: Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{32}$")] | None = None
    wholeRaster: Literal[True] | None = None

    @model_validator(mode="after")
    def validate_intent(self) -> "AggregatePlanRequest":
        """Validate area and reuse the I/O-free expression contract.

        Returns:
            The checked request.

        Raises:
            ValueError: For ambiguous area or invalid calculation language.
        """
        if (
            sum(
                value is not None
                for value in (
                    self.selectedBounds,
                    self.temporaryAoiId,
                    self.wholeRaster,
                )
            )
            != 1
        ):
            raise ValueError("Choose one box, uploaded AOI, or explicit whole raster")
        AggregateValidationRequest(
            alias=next(iter(self.sources)), calculations=self.calculations
        )
        return self


class AggregateArea(BaseModel):
    """Independent job-owned area snapshot; whole scope is explicit."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["bounds", "aoi", "wholeRaster"]
    bounds: tuple[float, float, float, float] | None = None
    geometries: tuple[dict[str, object], ...] = ()


class GroundAreaPlan(BaseModel):
    """Reviewed ellipsoidal measurement method and bounded geometry work."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    method: Literal["ellipsoidal_cylindrical_equal_area"] = (
        "ellipsoidal_cylindrical_equal_area"
    )
    ellipsoid: Literal["WGS84"] = "WGS84"
    units: Literal["ha"] = "ha"
    inclusion: Literal["fractional_cell_intersection"] = "fractional_cell_intersection"
    edgeToleranceMetres: float
    maximumSegmentMetres: float
    estimatedGeometryCells: int
    strategy: Literal["rectilinear", "cell_polygons"]


class AggregateGrid(BaseModel):
    """Native grid, value domain, and conservative work/memory admission."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    crs: str
    transform: tuple[float, float, float, float, float, float]
    window: tuple[int, int, int, int]
    width: int
    height: int
    dtype: str
    nodata: str | None
    nativeBlocks: int
    decodedBytes: int
    estimatedMemoryBytes: int
    scale: str
    offset: str
    storedUnit: str | None
    groundArea: GroundAreaPlan | None = None

    @model_serializer(mode="wrap")
    def serialize_grid(self, handler: SerializerFunctionWrapHandler) -> dict:
        """Preserve the existing wire shape for numeric-only accepted jobs.

        Args:
            handler: Pydantic's normal field serializer.

        Returns:
            Grid fields, with area metadata only when that method is required.
        """
        result = handler(self)
        if self.groundArea is None:
            result.pop("groundArea", None)
        return result


class AggregateSpec(BaseModel):
    """Versioned, source-fenced executable intent derived from an accepted plan."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["raster.aggregate.v1"] = OPERATION_VERSION
    sources: Annotated[
        dict[Alias, CatalogRasterRequest], Field(min_length=1, max_length=1)
    ]
    sourceSignature: tuple[int, int, int, int]
    calculations: tuple[NamedCalculation, ...]
    area: AggregateArea
    grid: AggregateGrid


class AggregateValue(BaseModel):
    """Lossless decimal value and explicit per-calculation data state."""

    label: str
    expression: str
    value: str | None
    valueType: Literal["integer", "float"] | None
    state: Literal[
        "ok", "no_matches", "no_valid_data", "invalid_arithmetic", "overflow"
    ]
    aggregates: list[dict[str, str | int]]
    unit: Literal["ha"] | None = None


class AggregateResultResponse(JobResultResponse):
    """Small inline results plus owned CSV and provenance downloads."""

    rows: list[AggregateValue]


class AggregateProgress(JobProgressResponse):
    """Measured native-block progress and result publication phases."""

    completedBlocks: int | None = None
    totalBlocks: int | None = None


class AggregateJobResponse(JobResponse):
    """Calculation-specific details layered on the existing job lifecycle."""

    operation: Literal["raster.aggregate.v1"]
    sources: dict[str, CatalogRasterRequest] | None
    calculations: tuple[NamedCalculation, ...] | None
    area: dict[str, object] | None
    grid: AggregateGrid | None
    progress: AggregateProgress
    result: AggregateResultResponse | None


class AggregatePlanResponse(BaseModel):
    """Metadata-only review of the immutable source/area/expression intent."""

    planId: OpaqueId
    operation: Literal["raster.aggregate.v1"]
    sources: dict[str, CatalogRasterRequest]
    calculations: tuple[NamedCalculation, ...]
    area: dict[str, object]
    grid: AggregateGrid
    expiresAt: datetime
    resolution: Literal["native"] = "native"
    valueDomain: Literal["stored"] = "stored"
    inclusion: Literal["cell_center", "per_function"] = "cell_center"
    limits: dict[str, int | float]


@dataclass(frozen=True)
class RasterAggregateLimits(ProcessingLimits):
    """Native work and expression memory budgets, independent of TIFF outputs."""

    max_decoded_bytes: int = 4 * 1024**3
    max_native_blocks: int = 65_536
    max_geometry_bytes: int = 8 * 1024**2
    max_coordinates: int = 500_000
    max_memory_bytes: int = 512 * 1024**2
    result_reservation_bytes: int = 12 * 1024**2
    # Rectilinear cells under whole-raster/rectangular selections need only row
    # widths/heights. Other cases admit at most this many potential polygon cells.
    max_area_geometry_cells: int = 2_000_000
    max_area_transform_coordinates: int = 4_000_000
    area_edge_tolerance_metres: float = 0.1
    area_max_segment_metres: float = 10_000.0

    @classmethod
    def with_lifecycle(cls, limits: ProcessingLimits) -> "RasterAggregateLimits":
        """Keep operation admission aligned with the shared deployment lifecycle.

        Args:
            limits: Configured job scheduling, storage, and execution policy.

        Returns:
            Calculation-specific limits using the same shared job policy.
        """
        return cls(
            **{
                item.name: getattr(limits, item.name)
                for item in fields(ProcessingLimits)
            }
        )


@dataclass(frozen=True)
class AggregateArtifact(Artifact):
    """Server-generated CSV and bounded typed summary for an aggregate job."""

    rows: list[dict[str, object]]
    media_type: str = field(default="text/csv", kw_only=True)
    result_name: str = field(default="result.csv", kw_only=True)
