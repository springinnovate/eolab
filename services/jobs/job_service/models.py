"""Version 0.1 HTTP contracts for the standalone Job service skeleton."""

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
    """Immutable proposed job input; the skeleton never admits this request."""

    operation: str = Field(
        pattern=r"^[a-z][a-z0-9_.-]{0,127}$", examples=["demo.sum.v1"]
    )
    inputs: dict[str, JsonValue] = Field(examples=[{"values": [10, 20, 30]}])
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
    """Error envelope shared by stub, routing and validation failures."""

    error: ErrorDetail


class Health(Contract):
    """HTTP readiness does not imply that job execution is implemented."""

    service: Literal["jobs"] = "jobs"
    mode: Literal["stub"] = "stub"
    ready: Literal[True] = True
    acceptsJobs: Literal[False] = False
    apiVersion: Literal["0.1.0"] = "0.1.0"


class Operation(Contract):
    """Description and JSON schemas of a future installed operation."""

    name: str
    description: str
    inputSchema: dict[str, JsonValue]
    resultSchema: dict[str, JsonValue]


class Operations(Contract):
    """Actual registered operations; this skeleton has none."""

    operations: list[Operation] = Field(default_factory=list)


class Progress(Contract):
    """Optional operation-reported progress; fraction is between zero and one."""

    fraction: float | None = Field(default=None, ge=0, le=1, allow_inf_nan=False)
    message: str | None = None


class JobSnapshot(Contract):
    """Proposed future status response, not produced by the stub endpoints."""

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
    """Proposed owned-job page with an opaque continuation cursor."""

    jobs: list[JobSnapshot]
    nextCursor: str | None = None


class Artifact(Contract):
    """Proposed downloadable result; retrieval uses its ID, never a path."""

    artifactId: UUID
    filename: str
    mediaType: str
    sizeBytes: int = Field(ge=0)


class JobResult(Contract):
    """Proposed completed result with inline JSON and optional artifacts."""

    jobId: UUID
    value: JsonValue = None
    artifacts: list[Artifact] = Field(default_factory=list)
