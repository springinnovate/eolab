"""Strict public requests and versioned internal raster-clip values."""

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from eolab_app.raster.models import CatalogRasterRequest, Wgs84Bounds

OpaqueId = Annotated[str, Field(pattern=r"^[a-f0-9]{32}$")]
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


class ClipSubmitRequest(BaseModel):
    """Accept a reviewed plan with a client-generated idempotency key."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    planId: OpaqueId
    requestId: Annotated[
        str, Field(min_length=16, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    ]


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


class ClipPlanLimits(BaseModel):
    """Published native size, runtime, and download lifetime limits."""

    maxRawBytes: int
    runtimeSeconds: float
    downloadLifetimeSeconds: int


class ClipPlanResponse(BaseModel):
    """Versioned, reviewable plan returned before job admission."""

    planId: OpaqueId
    operation: Literal["raster.clip.v1"]
    source: CatalogRasterRequest
    area: ClipAreaSummary
    grid: ClipGrid
    expiresAt: datetime
    format: Literal["COG"]
    resolution: Literal["native"]
    allTouched: Literal[True]
    limits: ClipPlanLimits


class ClipResultResponse(BaseModel):
    """Owned immutable download metadata; URLs require the browser session."""

    url: str
    provenanceUrl: str
    filename: str
    bytes: int
    sha256: str
    validPixels: int


class ClipFailureResponse(BaseModel):
    """Sanitized terminal failure retained with its job."""

    code: str
    detail: str


class ClipProgressResponse(BaseModel):
    """Phase-based progress; COG finalization has no misleading percentage."""

    phase: (
        Literal["clipping", "creating_cog", "validating", "checksumming", "ready"]
        | None
    ) = None
    completedBlocks: int | None = None
    totalBlocks: int | None = None


class ClipJobResponse(BaseModel):
    """Owned job lifecycle and optional ready result, independent of the map."""

    jobId: OpaqueId
    operation: Literal["raster.clip.v1"]
    status: Literal[
        "queued",
        "running",
        "cancelling",
        "ready",
        "failed",
        "cancelled",
        "interrupted",
        "expired",
        "deleted",
    ]
    createdAt: datetime
    updatedAt: datetime
    expiresAt: datetime
    source: CatalogRasterRequest | None
    grid: ClipGrid | None
    area: ClipAreaSummary | None
    progress: ClipProgressResponse
    error: ClipFailureResponse | None
    result: ClipResultResponse | None


class ClipJobsResponse(BaseModel):
    """Bounded, session-owned recovery listing."""

    jobs: list[ClipJobResponse]


@dataclass(frozen=True)
class ProcessingLimits:
    """Deployment-wide clip policy; resource checks are not caller options."""

    max_raw_bytes: int = 1024**3
    max_decoded_bytes: int = 4 * 1024**3
    max_native_blocks: int = 65_536
    max_geometry_bytes: int = 8 * 1024**2
    max_coordinates: int = 500_000
    plan_timeout_seconds: float = 15
    runtime_seconds: float = 600
    plan_ttl_seconds: int = 300
    result_ttl_seconds: int = 86_400
    max_waiting: int = 10
    max_owner_unfinished: int = 2
    max_stored_bytes: int = 20 * 1024**3
    free_space_floor: int = 2 * 1024**3
    lease_seconds: int = 20
    transfer_seconds: int = 120


class ProcessingError(Exception):
    """Sanitized, stable error at the processing API boundary."""

    def __init__(self, code: str, detail: str, status: int = 422) -> None:
        """Create a safe processing failure.

        Args:
            code: Machine-readable reason, also retained on failed jobs.
            detail: User-facing explanation without private paths or raw errors.
            status: Appropriate HTTP response status.
        """
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.status = status


@dataclass(frozen=True)
class Artifact:
    """Validated, immutable result metadata returned by the native child."""

    size: int
    sha256: str
    valid_pixels: int
    filename: str


@dataclass(frozen=True)
class ArtifactDownload:
    """Owned artifact plus its bounded, renewable transfer lease."""

    path: Path
    filename: str
    size: int
    sha256: str
    lease_id: str
