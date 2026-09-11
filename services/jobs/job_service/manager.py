"""Single-event-loop ownership of bounded ephemeral jobs and one execution lane."""

import asyncio
import hashlib
import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from uuid import UUID, uuid4

from pydantic import ValidationError

from job_service.configuration import Settings
from job_service.execution import run_operation
from job_service.models import (
    ErrorDetail,
    JobPage,
    JobResult,
    JobSnapshot,
    JobStatus,
    SubmitJob,
)
from job_service.operations import OPERATIONS

TERMINAL = frozenset({"succeeded", "failed", "cancelled", "timed_out", "expired"})


class JobError(Exception):
    """Safe domain error, mapped to an HTTP status by the service boundary."""

    def __init__(self, code: str, message: str) -> None:
        """Record a stable code and safe explanation.

        Args:
            code: Domain failure identity.
            message: Public explanation without inputs or private details.
        """
        super().__init__(message)
        self.code = code


@dataclass
class Record:
    """Private job ownership, immutable invocation, deadlines and retained result."""

    owner: str
    key: str
    fingerprint: str
    snapshot: JobSnapshot
    payload: bytes
    sequence: int
    queue_deadline: float
    execution_seconds: float
    cancellation: asyncio.Event = field(default_factory=asyncio.Event)
    result: JobResult | None = None
    finished_clock: float | None = None


class JobManager:
    """Serialize transitions on one event loop, with no unbounded task backlog.

    All public methods run on the hosting ASGI loop. Non-awaiting methods make
    admission and state transitions atomic on that loop. The dispatcher creates
    at most one execution task and owns it through process cleanup.
    """

    def __init__(self, settings: Settings) -> None:
        """Initialize empty, non-durable state.

        Args:
            settings: Validated deployment capacity and timeout policy.
        """
        self.settings = settings
        self.records: dict[UUID, Record] = {}
        self.keys: dict[tuple[str, str], UUID] = {}
        self.sequence = 0
        self.wake = asyncio.Event()
        self.dispatcher: asyncio.Task[None] | None = None
        self.active: asyncio.Task[None] | None = None
        self.accepting = False

    async def start(self) -> None:
        """Start the single dispatcher once for this application lifespan."""
        self.accepting = True
        self.dispatcher = asyncio.create_task(self._dispatch())

    async def close(self) -> None:
        """Stop admission, cancel all pending work and reap the executing child."""
        self.accepting = False
        for record in self.records.values():
            self._cancel(record)
        self.wake.set()
        if self.dispatcher is not None:
            await self.dispatcher

    def _owned(self, owner: str, job_id: UUID) -> Record:
        """Resolve owned retained state without disclosing another caller's IDs.

        Args:
            owner: Authenticated principal.
            job_id: Opaque job identity.

        Returns:
            Private retained record.

        Raises:
            JobError: If absent, expired or owned by another principal.
        """
        self._maintain()
        record = self.records.get(job_id)
        if record is None or record.owner != owner:
            raise JobError("not_found", "Job not found")
        return record

    def submit(self, owner: str, key: str, request: SubmitJob) -> JobSnapshot:
        """Admit one registered invocation or return its idempotent predecessor.

        Args:
            owner: Authenticated principal, never a submitted owner field.
            key: Validated idempotency key, scoped to this principal.
            request: Validated HTTP request.

        Returns:
            Independent authoritative snapshot.

        Raises:
            JobError: For invalid operations, conflicting retries or full capacity.
        """
        self._maintain()
        fingerprint = hashlib.sha256(
            json.dumps(
                request.model_dump(mode="json"), sort_keys=True, separators=(",", ":")
            ).encode()
        ).hexdigest()
        previous = self.keys.get((owner, key))
        if previous is not None:
            record = self.records[previous]
            if record.fingerprint != fingerprint:
                raise JobError(
                    "conflict", "Idempotency key already used for different inputs"
                )
            return record.snapshot.model_copy(deep=True)
        operation = OPERATIONS.get(request.operation)
        if operation is None:
            raise JobError("invalid_request", "Unknown installed operation")
        try:
            inputs = operation.input_model.model_validate(request.inputs)
        except ValidationError:
            raise JobError(
                "invalid_request", "Invalid operation inputs; see the operation schema"
            ) from None
        execution = request.executionTimeoutSeconds or self.settings.execution_seconds
        queue = request.queueTimeoutSeconds or self.settings.queue_seconds
        if max(execution, queue) > self.settings.max_timeout_seconds:
            raise JobError(
                "invalid_request",
                f"Requested timeout exceeds the {self.settings.max_timeout_seconds:g}-second service limit",
            )
        queued = sum(
            record.snapshot.status == "queued" for record in self.records.values()
        )
        if (
            not self.accepting
            or queued >= self.settings.queue_capacity
            or len(self.records) >= self.settings.record_capacity
        ):
            raise JobError("capacity", "Job capacity is busy; retry later")
        self.sequence += 1
        job_id = uuid4()
        snapshot = JobSnapshot(
            jobId=job_id,
            operation=request.operation,
            status="queued",
            priority=request.priority,
            submittedAt=datetime.now(timezone.utc),
        )
        self.records[job_id] = Record(
            owner,
            key,
            fingerprint,
            snapshot,
            json.dumps(
                {
                    "operation": request.operation,
                    "inputs": inputs.model_dump(mode="json"),
                },
                allow_nan=False,
            ).encode(),
            self.sequence,
            time.monotonic() + queue,
            execution,
        )
        self.keys[(owner, key)] = job_id
        self.wake.set()
        return snapshot.model_copy(deep=True)

    def get(self, owner: str, job_id: UUID) -> JobSnapshot:
        """Read current owned state.

        Args:
            owner: Authenticated principal.
            job_id: Job identity.

        Returns:
            Snapshot copy.

        Raises:
            JobError: If the owned job is unavailable.
        """
        return self._owned(owner, job_id).snapshot.model_copy(deep=True)

    def list(
        self, owner: str, status: JobStatus | None, limit: int, cursor: str | None
    ) -> JobPage:
        """List owned records in admission order; cursor is a retained job UUID.

        Args:
            owner: Authenticated principal.
            status: Optional current-state filter, not a frozen page snapshot.
            limit: Validated page size.
            cursor: Last seen owned job; deletion/expiry invalidates its cursor.

        Returns:
            Bounded page and optional continuation cursor.

        Raises:
            JobError: For an invalid or unavailable cursor.
        """
        self._maintain()
        after = 0
        if cursor:
            try:
                after = self._owned(owner, UUID(cursor)).sequence
            except (ValueError, JobError):
                raise JobError(
                    "invalid_request", "Listing cursor is invalid or expired"
                ) from None
        matching = [
            record
            for record in self.records.values()
            if record.owner == owner
            and record.sequence > after
            and (status is None or record.snapshot.status == status)
        ]
        page = matching[:limit]
        return JobPage(
            jobs=[record.snapshot.model_copy(deep=True) for record in page],
            nextCursor=str(page[-1].snapshot.jobId) if len(matching) > limit else None,
        )

    def update(self, owner: str, job_id: UUID, priority: int) -> JobSnapshot:
        """Change queued priority without changing FIFO admission order.

        Args:
            owner: Authenticated principal.
            job_id: Job identity.
            priority: Boundary-validated priority.

        Returns:
            Updated snapshot.

        Raises:
            JobError: If unavailable or no longer queued.
        """
        record = self._owned(owner, job_id)
        if record.snapshot.status != "queued":
            raise JobError("conflict", "Only queued job priority can change")
        record.snapshot.priority = priority
        self.wake.set()
        return record.snapshot.model_copy(deep=True)

    def cancel(self, owner: str, job_id: UUID) -> JobSnapshot:
        """Request cancellation; terminal work stays terminal.

        Args:
            owner: Authenticated principal.
            job_id: Job identity.

        Returns:
            Cancelled queued state, cancelling running state, or terminal state.

        Raises:
            JobError: If the owned job is unavailable.
        """
        record = self._owned(owner, job_id)
        self._cancel(record)
        self.wake.set()
        return record.snapshot.model_copy(deep=True)

    def result(self, owner: str, job_id: UUID) -> JobResult:
        """Return a successful retained result.

        Args:
            owner: Authenticated principal.
            job_id: Job identity.

        Returns:
            Result copy.

        Raises:
            JobError: If unavailable or not succeeded.
        """
        record = self._owned(owner, job_id)
        if record.result is None:
            raise JobError(
                "conflict", "Job has no successful result; inspect its status"
            )
        return record.result.model_copy(deep=True)

    def delete(self, owner: str, job_id: UUID) -> None:
        """Remove owned terminal state and its idempotency reservation.

        Args:
            owner: Authenticated principal.
            job_id: Job identity.

        Raises:
            JobError: If unavailable or still active.
        """
        record = self._owned(owner, job_id)
        if record.snapshot.status not in TERMINAL:
            raise JobError("conflict", "Cancel active work before deleting it")
        self.records.pop(job_id)
        self.keys.pop((owner, record.key))

    def _finish(self, record: Record, status: JobStatus) -> None:
        """Publish terminal state only after execution has released its resources.

        Args:
            record: Owned record.
            status: Terminal outcome.
        """
        record.snapshot.status = status
        record.snapshot.finishedAt = datetime.now(timezone.utc)
        record.finished_clock = time.monotonic()
        if status != "succeeded":
            record.snapshot.error = ErrorDetail(
                code=status,
                message={
                    "failed": "Operation failed",
                    "timed_out": "Execution deadline exceeded",
                    "expired": "Queue deadline exceeded",
                    "cancelled": "Job cancelled",
                }[status],
            )

    def _cancel(self, record: Record) -> None:
        """Apply an idempotent cancellation transition.

        Args:
            record: Target record.
        """
        if record.snapshot.status == "queued":
            self._finish(record, "cancelled")
        elif record.snapshot.status == "running":
            record.snapshot.status = "cancelling"
            record.cancellation.set()

    def _maintain(self) -> None:
        """Expire waiting work and release terminal records after their TTL."""
        now = time.monotonic()
        for job_id, record in list(self.records.items()):
            if record.snapshot.status == "queued" and now >= record.queue_deadline:
                self._finish(record, "expired")
            if (
                record.finished_clock is not None
                and now - record.finished_clock >= self.settings.retention_seconds
            ):
                self.records.pop(job_id)
                self.keys.pop((record.owner, record.key))

    async def _execute(self, record: Record) -> None:
        """Own the execution slot until subprocess cleanup completes.

        Args:
            record: One admitted running job.
        """
        try:
            outcome = await run_operation(
                record.payload, record.cancellation, record.execution_seconds
            )
            status = "cancelled" if record.cancellation.is_set() else outcome.status
            if status == "succeeded":
                # Validate the subprocess result at the external-system boundary.
                value = OPERATIONS[
                    record.snapshot.operation
                ].result_model.model_validate(outcome.value)
                record.result = JobResult(
                    jobId=record.snapshot.jobId, value=value.model_dump(mode="json")
                )
            self._finish(record, status)
        except Exception:
            self._finish(record, "failed")
        finally:
            self.wake.set()

    async def _dispatch(self) -> None:
        """Run the highest-priority waiting job, reconciling expiry every 100 ms."""
        while self.accepting or self.active is not None:
            self.wake.clear()
            self._maintain()
            if self.active is not None and self.active.done():
                await self.active
                self.active = None
            if self.accepting and self.active is None:
                queued = [
                    record
                    for record in self.records.values()
                    if record.snapshot.status == "queued"
                ]
                if queued:
                    record = min(
                        queued,
                        key=lambda item: (-item.snapshot.priority, item.sequence),
                    )
                    record.snapshot.status = "running"
                    record.snapshot.startedAt = datetime.now(timezone.utc)
                    self.active = asyncio.create_task(self._execute(record))
            if not self.accepting and self.active is None:
                break
            try:
                await asyncio.wait_for(self.wake.wait(), timeout=0.1)
            except TimeoutError:
                pass
