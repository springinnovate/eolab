"""Operation-neutral job lifecycle, storage values, and Processing policy."""

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Annotated, Generic, Literal, TypeVar

from pydantic import BaseModel, Field
from eolab_app.processing.artifact_manifest import ArtifactManifest, ProducedFile

OpaqueId = Annotated[str, Field(pattern=r"^[a-f0-9]{32}$")]


@dataclass(frozen=True)
class JobInputFile:
    """A published file whose identity must match when dependent work is admitted.

    Attributes:
        run_id: Owner's public handle for the completed parent run.
        artifact_id: Published file ID, never a scratch or selection-mask path.
        sha256: Published checksum captured before admission.
        size: Published byte count captured before admission.
        media_type: Published format checked by the accepting operation.
        role: Published scientific role, distinct from provenance and scratch.
    """

    run_id: str
    artifact_id: str
    sha256: str
    size: int
    media_type: str
    role: str


@dataclass(frozen=True)
class PreparedJobPlan:
    """Validated operation data supplied to storage by its application owner.

    Attributes:
        specification: JSON-compatible, path-free operation specification.
        summary: Bounded public operation metadata, excluding large input payloads.
        reserved_bytes: Historical byte estimate; new plans use zero and do not reserve storage.
        operation: Opaque versioned operation discriminator supplied by its owner.
        work_key: Complete computation identity; None means never join active work.
        presentation: Small caller-specific labels, separate from shared execution.
        retained_metadata: Optional operation details kept after scratch files are
            removed, for the configured metadata lifetime after the job finishes.
        input_files: Published files to authorize and retain atomically with admission.
            The parent retains each input until dependent work stops.
        input_uploads: Original upload IDs mapped to private retained-file tokens.
            These files remain available until the accepted computation stops.
        minimum_retention_seconds: Optional minimum lifetime for both published
            results and saved details after completion. Storage captures the larger
            of this duration and the deployment's result and metadata lifetimes.
    """

    specification: dict[str, object]
    summary: dict[str, object]
    reserved_bytes: int
    operation: str = ""
    work_key: str | None = None
    presentation: dict[str, object] | None = None
    retained_metadata: dict[str, object] | None = None
    input_files: tuple[JobInputFile, ...] = ()
    input_uploads: dict[str, str] = field(default_factory=dict)
    minimum_retention_seconds: int | None = None


@dataclass(frozen=True)
class JobSubmission:
    """One retryable admission, including an optional input-resolution failure.

    Attributes:
        request_key: Owner-scoped retry identifier.
        request_hash: Complete validated request identity.
        operation: Expected operation, including when input resolution failed.
        prepared: Operation data or its sanitized resolution error. Storage first
            recovers an existing retry, which may outlive its original input.
    """

    request_key: str
    request_hash: str
    operation: str
    prepared: "PreparedJobPlan | ProcessingError"


class JobResultResponse(BaseModel):
    """Owned download metadata shared by operation-specific result contracts."""

    url: str
    provenanceUrl: str
    filename: str
    bytes: int
    sha256: str


class JobFailureResponse(BaseModel):
    """Sanitized terminal failure retained with its processing job."""

    code: str
    detail: str


class JobProgressResponse(BaseModel):
    """Named operation progress, extended with operation-specific work counts."""

    phase: str | None = None


class JobResponse(BaseModel):
    """Shared owned job lifecycle, independent of operation inputs and algorithms."""

    jobId: OpaqueId
    operation: str
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
    progress: JobProgressResponse
    error: JobFailureResponse | None
    result: JobResultResponse | None


JobResponseType = TypeVar("JobResponseType", bound=JobResponse)


class JobListResponse(BaseModel, Generic[JobResponseType]):
    """Bounded owned job listing, parameterized by supported operation contracts."""

    jobs: list[JobResponseType]


class JobStatusRequest(BaseModel):
    """Read up to 100 public job IDs belonging to the current session.

    Duplicate IDs are accepted and returned once. This reads statuses without
    submitting work or changing the requested jobs.
    """

    jobIds: list[OpaqueId] = Field(min_length=1, max_length=100)


class JobStatusResponse(JobListResponse[JobResponseType], Generic[JobResponseType]):
    """Requested job snapshots and IDs unavailable to the current session.

    Foreign and nonexistent IDs are both unavailable; no other owner's job
    information is disclosed. Each distinct requested ID appears in one list.
    """

    unavailableJobIds: list[OpaqueId]


@dataclass(frozen=True)
class ProcessingLimits:
    """Configure Processing concurrency, ownership leases, retention and result caching.

    Calculations have no size, memory, disk or total-runtime ceiling. Worker slots
    remain occupied until native work exits. Leases detect lost ownership; they
    are renewed throughout execution rather than limiting its total duration.
    Result and metadata lifetimes start when work finishes. Cache capacity bounds
    reusable scalar results and evicts old entries without rejecting calculations.
    """

    worker_count: int = 1
    result_ttl_seconds: int = 86_400
    metadata_ttl_seconds: int = 7 * 86_400
    lease_seconds: int = 20
    transfer_seconds: int = 120
    # Shared numerical results; independent of owned job/download lifetimes.
    calculation_cache_capacity: int = 1_000
    calculation_cache_ttl_seconds: int = 86_400


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
    """A primary result plus declared outputs and its published file inventory.

    Attributes:
        size: Primary file byte count.
        sha256: Primary file checksum.
        filename: Suggested primary download name.
        media_type: Primary format.
        additional_outputs: Completed operation outputs available for recipe retention.
        manifest: Verified inventory, supplied only after atomic publication.
    """

    size: int
    sha256: str
    filename: str
    media_type: str = field(default="application/octet-stream", kw_only=True)
    additional_outputs: tuple[ProducedFile, ...] = field(default=(), kw_only=True)
    manifest: ArtifactManifest | None = field(default=None, kw_only=True)


@dataclass(frozen=True)
class ArtifactDownload:
    """Owned artifact plus its bounded, renewable transfer lease.

    Attributes:
        path: Confined shared result file retained by the lease.
        filename: Suggested download name.
        size: Delivered byte count.
        sha256: Delivered content checksum.
        lease_id: Transfer capability keeping shared files alive.
        media_type: Download content type.
        content: Optional small CSV/JSON personalized with the caller's labels.
    """

    path: Path
    filename: str
    size: int
    sha256: str
    lease_id: str
    media_type: str
    content: bytes | None = None
