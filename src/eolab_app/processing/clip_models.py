"""Raster-clip inputs and result details layered on shared Processing contracts."""

from dataclasses import dataclass, field
from typing import Annotated, Literal
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, model_validator

from eolab_app.processing.models import (
    Artifact,
    JobListResponse,
    JobPlanLimits,
    JobProgressResponse,
    JobResponse,
    JobResultResponse,
    OpaqueId,
    ProcessingLimits,
)
from eolab_app.raster.models import CatalogRasterRequest, Wgs84Bounds

OPERATION_VERSION = "raster.clip.v1"


class ClipPlanRequest(CatalogRasterRequest):
    """A catalog raster and exactly one explicit, lifecycle-valid clip area."""

    selectedBounds: Wgs84Bounds | None = None
    temporaryAoiId: Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{32}$")] | None = None

    @model_validator(mode="after")
    def require_explicit_area(self) -> "ClipPlanRequest":
        """Require one area; omission must never become a whole-raster export.

        Returns:
            Validated request.

        Raises:
            ValueError: If neither or both selection variants were supplied.
        """
        if (self.selectedBounds is None) == (self.temporaryAoiId is None):
            raise ValueError("Choose exactly one histogram box or temporary AOI")
        return self


class ClipArea(BaseModel):
    """Job-owned polygon snapshot, never an uploaded file or mutable AOI store."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["bounds", "aoi"]
    bounds: tuple[float, float, float, float]
    geometries: tuple[dict[str, object], ...] = ()


class ClipGrid(BaseModel):
    """Planned native window and conservative work/storage estimates."""

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
    estimatedRawBytes: int
    reservedBytes: int


class ClipSpec(BaseModel):
    """Durable, path-free job specification fenced to a catalog signature."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["raster.clip.v1"] = OPERATION_VERSION
    source: CatalogRasterRequest
    sourceSignature: tuple[int, int, int, int]
    area: ClipArea
    grid: ClipGrid


class ClipAreaSummary(BaseModel):
    """Browser-safe area description without copying the AOI into every poll."""

    kind: Literal["bounds", "aoi"]
    bounds: tuple[float, float, float, float]


class ClipPlanResponse(BaseModel):
    """Versioned, reviewable native-grid plan returned before job admission."""

    planId: OpaqueId
    operation: Literal["raster.clip.v1"]
    source: CatalogRasterRequest
    area: ClipAreaSummary
    grid: ClipGrid
    expiresAt: datetime
    format: Literal["COG"]
    resolution: Literal["native"]
    allTouched: Literal[True]
    limits: JobPlanLimits


class ClipResultResponse(JobResultResponse):
    """Add raster validity counts to shared owned download metadata."""

    validPixels: int


class ClipProgressResponse(JobProgressResponse):
    """Add bounded native block progress and supported clip execution phases."""

    phase: (
        Literal["clipping", "creating_cog", "validating", "checksumming", "ready"]
        | None
    ) = None
    completedBlocks: int | None = None
    totalBlocks: int | None = None


class ClipJobResponse(JobResponse):
    """Add raster context to the shared job lifecycle without redefining it."""

    operation: Literal["raster.clip.v1"]
    source: CatalogRasterRequest | None
    grid: ClipGrid | None
    area: ClipAreaSummary | None
    progress: ClipProgressResponse
    result: ClipResultResponse | None


# The listing reuses the common envelope; adding a supported operation can extend
# its response union without copying job ownership, status, failure, or timestamps.
ClipJobsResponse = JobListResponse[ClipJobResponse]


@dataclass(frozen=True)
class RasterClipLimits(ProcessingLimits):
    """Native raster/geometry budgets in addition to shared scheduling policy."""

    max_raw_bytes: int = 1024**3
    max_decoded_bytes: int = 4 * 1024**3
    max_native_blocks: int = 65_536
    max_geometry_bytes: int = 8 * 1024**2
    max_coordinates: int = 500_000


@dataclass(frozen=True)
class ClipArtifact(Artifact):
    """Extend shared artifact metadata with the clip's valid-pixel count."""

    valid_pixels: int
    media_type: str = field(default="image/tiff", kw_only=True)
