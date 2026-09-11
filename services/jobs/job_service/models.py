"""HTTP contracts for the standalone diagnostic Job service."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue

Priority = Annotated[int, Field(strict=True, ge=-1000, le=1000)]
JobStatus = Literal[
    "queued",
    "running",
    "cancelling",
    "cancelled",
    "succeeded",
    "failed",
    "timed_out",
    "expired",
]


class Contract(BaseModel):
    """Reject unknown fields rather than silently accepting unsupported options."""

    model_config = ConfigDict(extra="forbid")


class SubmitJob(Contract):
    """Immutable invocation of one installed operation."""

    operation: str = Field(
        pattern=r"^[a-z][a-z0-9_.-]{0,127}$", examples=["diagnostic.v1"]
    )
    inputs: dict[str, JsonValue] = Field(
        examples=[{"mode": "delay", "seconds": 5, "value": "hello"}]
    )
    priority: Priority = Field(
        default=0, description="Higher starts first; ties use arrival order."
    )
    executionTimeoutSeconds: int | None = Field(
        default=None, strict=True, gt=0, le=86400
    )
    queueTimeoutSeconds: int | None = Field(default=None, strict=True, gt=0, le=86400)


class UpdateJob(Contract):
    """Only queued priority may change; operation and inputs remain immutable."""

    priority: Priority


class ErrorDetail(Contract):
    """Machine-readable error code and safe human-readable explanation."""

    code: str
    message: str


class ErrorResponse(Contract):
    """Error envelope shared by lifecycle, routing and validation failures."""

    error: ErrorDetail


class Health(Contract):
    """HTTP readiness and whether caller configuration enables admission."""

    service: Literal["jobs"] = "jobs"
    mode: Literal["ephemeral"] = "ephemeral"
    ready: Literal[True] = True
    acceptsJobs: bool = False
    apiVersion: Literal["0.2.0"] = "0.2.0"


class Operation(Contract):
    """Description and JSON schemas of an installed operation."""

    name: str
    description: str
    inputSchema: dict[str, JsonValue]
    resultSchema: dict[str, JsonValue]


class Operations(Contract):
    """Discoverable installed operations."""

    operations: list[Operation] = Field(default_factory=list)


class Progress(Contract):
    """Optional operation-reported progress; fraction is between zero and one."""

    fraction: float | None = Field(default=None, ge=0, le=1, allow_inf_nan=False)
    message: str | None = None


class JobSnapshot(Contract):
    """Authoritative retained state for one caller-owned job."""

    jobId: UUID
    operation: str
    status: JobStatus
    priority: Priority
    submittedAt: datetime
    startedAt: datetime | None = None
    finishedAt: datetime | None = None
    progress: Progress | None = None
    error: ErrorDetail | None = None


class JobPage(Contract):
    """Owned-job page with an opaque continuation cursor."""

    jobs: list[JobSnapshot]
    nextCursor: str | None = None


class Artifact(Contract):
    """Proposed downloadable result; retrieval uses its ID, never a path."""

    artifactId: UUID
    filename: str
    mediaType: str
    sizeBytes: int = Field(ge=0)


class JobResult(Contract):
    """Completed inline JSON result; artifacts remain reserved for future work."""

    jobId: UUID
    value: JsonValue = None
    artifacts: list[Artifact] = Field(default_factory=list)
