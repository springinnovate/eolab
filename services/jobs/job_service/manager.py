"""Queue, run and expire in-memory jobs, executing one operation at a time."""

import asyncio
import hashlib
import json
from itertools import islice
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from uuid import UUID, uuid4

import httpx2
from pydantic import ValidationError

from job_service.configuration import Settings
from job_service.executor import ExecutionResult, run_job
from job_service.models import (
    ErrorDetail,
    JobPage,
    JobResult,
    JobSnapshot,
    JobStatus,
    SubmitJob,
)
from job_service.operations_registry import OPERATIONS
from job_service.scheduler import SchedulerClient, WorkerGrant

TERMINAL = frozenset({"succeeded", "failed", "cancelled", "timed_out", "expired"})
SHARED_OPERATION = "diagnostic.v1"


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
class JobRecord:
    """An in-memory job's owner, request, execution state and retained result.

    Attributes:
        owner: Authenticated caller allowed to read or change this job.
        key: Caller-scoped idempotency key used to recognize submission retries.
        fingerprint: SHA-256 of the request, used to reject changed retries.
        snapshot: Status and timestamps returned by the HTTP API.
        payload: Serialized operation request passed to the child process.
        sequence: Submission order used to break priority ties and paginate jobs.
        queue_deadline: Monotonic time after which a waiting job expires.
        execution_seconds: Maximum duration of the child process.
        cancellation: Signal requesting termination of a running operation.
        result: Validated output, present only after successful execution.
        finished_clock: Monotonic completion time used to expire retained results.
    """

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

    @property
    def dispatch_order(self) -> tuple[int, int]:
        """Return the sort key for descending Jobs priority and FIFO ties."""
        return -self.snapshot.priority, self.sequence


class JobManager:
    """Manage a capacity-limited in-memory queue and execute one job at a time.

    Jobs retains caller-owned HTTP records and has one isolated native lane.
    Diagnostics obtain their start from PostgreSQL. Other installed operations
    use the local priority queue until their individual migrations.
    """

    def __init__(
        self, settings: Settings, scheduler: SchedulerClient | None = None
    ) -> None:
        """Initialize empty, non-durable state.

        Args:
            settings: Validated deployment capacity and timeout policy.
            scheduler: Authenticated shared scheduler. Diagnostics require it.
        """
        self.settings = settings
        self.scheduler = scheduler
        self.queue_changes = asyncio.Lock()
        self.withdrawals: set[UUID] = set()
        self.activation: asyncio.Task[None] | None = None
        self.records: dict[UUID, JobRecord] = {}
        self.keys: dict[tuple[str, str], UUID] = {}
        self.sequence = 0
        self.wake = asyncio.Event()
        self.dispatcher: asyncio.Task[None] | None = None
        self.active: asyncio.Task[None] | asyncio.Task[bool] | None = None
        self.accepting = False

    async def start(self) -> None:
        """Start the single dispatcher once for this application lifespan."""
        self.accepting = True
        if self.scheduler is not None:
            self.activation = asyncio.create_task(self._activate_scheduler())
        self.dispatcher = asyncio.create_task(self._dispatch())

    async def _activate_scheduler(self) -> None:
        """Recover this stopped container's tickets even when no new requests arrive."""
        while self.accepting:
            try:
                await self.scheduler.activate()
                return
            except httpx2.HTTPError:
                await asyncio.sleep(1)

    async def close(self) -> None:
        """Stop admission, cancel all pending work and reap the executing child."""
        self.accepting = False
        async with self.queue_changes:
            for record in self.records.values():
                self._cancel(record)
        self.wake.set()
        if self.dispatcher is not None:
            await self.dispatcher
        if self.activation is not None:
            self.activation.cancel()
            await asyncio.gather(self.activation, return_exceptions=True)

    def _get_owned_job(self, owner: str, job_id: UUID) -> JobRecord:
        """Find a job belonging to this caller after removing expired records.

        Args:
            owner: Authenticated principal.
            job_id: Opaque job identity.

        Returns:
            Private retained record.

        Raises:
            JobError: If absent, expired or owned by another principal.
        """
        self._expire_queued_jobs_and_remove_old_records()
        record = self.records.get(job_id)
        if record is None or record.owner != owner:
            raise JobError("not_found", "Job not found")
        return record

    async def submit(self, owner: str, key: str, request: SubmitJob) -> JobSnapshot:
        """Serialize admission with claims and retries before acknowledging a caller's job.

        Args:
            owner: Authenticated service principal.
            key: Caller-scoped idempotency key.
            request: Validated submission.

        Returns:
            The admitted job's public snapshot.

        Raises:
            JobError: If validation, idempotency, local capacity or shared admission fails.
        """
        async with self.queue_changes:
            return await self._submit(owner, key, request)

    async def _submit(self, owner: str, key: str, request: SubmitJob) -> JobSnapshot:
        """Queue an operation or return the job from an identical submission retry.

        Preserve declared input aliases when serializing the worker's request.

        Args:
            owner: Authenticated principal, never a submitted owner field.
            key: Validated idempotency key, scoped to this principal.
            request: Validated HTTP request.

        Returns:
            A copy of the new or previously accepted job's current status.

        Raises:
            JobError: For invalid operations, conflicting retries or full capacity.
        """
        self._expire_queued_jobs_and_remove_old_records()
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
        queue_deadline = time.monotonic() + queue
        if request.operation == SHARED_OPERATION:
            if self.scheduler is None:
                raise JobError(
                    "capacity", "The shared job scheduler is unavailable; retry later"
                )
            try:
                await self.scheduler.admit(job_id, snapshot.submittedAt, queue)
            except httpx2.HTTPError:
                raise JobError(
                    "capacity", "The shared job scheduler is unavailable; retry later"
                ) from None
        self.records[job_id] = JobRecord(
            owner,
            key,
            fingerprint,
            snapshot,
            json.dumps(
                {
                    "operation": request.operation,
                    "inputs": inputs.model_dump(mode="json", by_alias=True),
                },
                allow_nan=False,
            ).encode(),
            self.sequence,
            queue_deadline,
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
        return self._get_owned_job(owner, job_id).snapshot.model_copy(deep=True)

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
        self._expire_queued_jobs_and_remove_old_records()
        cursor_sequence = 0
        if cursor:
            try:
                cursor_sequence = self._get_owned_job(owner, UUID(cursor)).sequence
            except (ValueError, JobError):
                raise JobError(
                    "invalid_request", "Listing cursor is invalid or expired"
                ) from None
        matching = [
            record
            for record in self.records.values()
            if record.owner == owner
            and record.sequence > cursor_sequence
            and (status is None or record.snapshot.status == status)
        ]
        page = matching[:limit]
        return JobPage(
            jobs=[record.snapshot.model_copy(deep=True) for record in page],
            nextCursor=str(page[-1].snapshot.jobId) if len(matching) > limit else None,
        )

    def update(self, owner: str, job_id: UUID, priority: int) -> JobSnapshot:
        """Change a queued job's priority; equal-priority jobs run in submission order.

        Args:
            owner: Authenticated principal.
            job_id: Job identity.
            priority: Boundary-validated priority.

        Returns:
            Updated snapshot.

        Raises:
            JobError: If unavailable or no longer queued.
        """
        record = self._get_owned_job(owner, job_id)
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
        record = self._get_owned_job(owner, job_id)
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
        record = self._get_owned_job(owner, job_id)
        if record.snapshot.status != "succeeded" or record.result is None:
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
        record = self._get_owned_job(owner, job_id)
        if record.snapshot.status not in TERMINAL:
            raise JobError("conflict", "Cancel active work before deleting it")
        self.records.pop(job_id)
        self.keys.pop((owner, record.key))

    def _finish(self, record: JobRecord, status: JobStatus) -> None:
        """Publish terminal state only after execution has released its resources.

        Args:
            record: Owned record.
            status: Terminal outcome.
        """
        if (
            record.snapshot.operation == SHARED_OPERATION
            and record.snapshot.status == "queued"
        ):
            self.withdrawals.add(record.snapshot.jobId)
            self.wake.set()
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

    def _cancel(self, record: JobRecord) -> None:
        """Apply an idempotent cancellation transition.

        Args:
            record: Target record.
        """
        if record.snapshot.status == "queued":
            self._finish(record, "cancelled")
        elif record.snapshot.status == "running":
            record.snapshot.status = "cancelling"
            record.cancellation.set()

    def _expire_queued_jobs_and_remove_old_records(self) -> None:
        """Expire overdue queued jobs and remove finished jobs past retention time."""
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

    async def _run_claimed(
        self, record: JobRecord, grant: WorkerGrant, attempt: UUID
    ) -> ExecutionResult:
        """Supervise one granted child and reap it if the shared lease cannot be renewed.

        Args:
            record: Locally authorized inputs and cancellation signal.
            grant: Shared ticket and heartbeat interval.
            attempt: Fencing token for this native execution.

        Returns:
            Native outcome after exit, or failure if its lease was lost.
        """
        child = asyncio.create_task(
            run_job(record.payload, record.cancellation, record.execution_seconds)
        )
        try:
            while True:
                done, _ = await asyncio.wait({child}, timeout=grant.heartbeat_seconds)
                if done:
                    return child.result()
                if not await self.scheduler.renew(grant.job_id, attempt):
                    return ExecutionResult("failed")
        finally:
            if not child.done():
                record.cancellation.set()
                await child

    async def _release(self, job_id: UUID, attempt: UUID) -> bool:
        """Retry a confirmed native stop without starting another child in this lane.

        Args:
            job_id: Stopped ticket.
            attempt: Its original claim token, reused after a lost reply.

        Returns:
            Whether the result was acknowledged with a live lease.
        """
        while True:
            try:
                return await self.scheduler.release(job_id, attempt)
            except httpx2.HTTPError as error:
                if not self.accepting or (
                    isinstance(error, httpx2.HTTPStatusError)
                    and error.response.status_code == 409
                ):
                    # The replacement recovers this executor after the old container exits.
                    return False
                await asyncio.sleep(0.25)

    async def _execute(
        self, record: JobRecord, claim: tuple[WorkerGrant, UUID] | None = None
    ) -> None:
        """Own the execution slot until subprocess cleanup completes.

        Args:
            record: One admitted running job.
            claim: Shared authorization for diagnostics. Legacy operations own their local start.
        """
        status: JobStatus = "failed"
        try:
            if claim is None:
                outcome = await run_job(
                    record.payload, record.cancellation, record.execution_seconds
                )
            else:
                outcome = await self._run_claimed(record, *claim)
            status = outcome.status
            if status == "succeeded":
                # Validate the subprocess result at the external-system boundary.
                value = OPERATIONS[
                    record.snapshot.operation
                ].result_model.model_validate(outcome.value)
                record.result = JobResult(
                    jobId=record.snapshot.jobId, value=value.model_dump(mode="json")
                )
        except Exception:
            status = "failed"
        finally:
            if claim is not None and not await self._release(
                record.snapshot.jobId, claim[1]
            ):
                record.result = None
                status = "failed"
            if record.snapshot.status == "cancelling":
                status = "cancelled"
                record.result = None
            self._finish(record, status)
            self.wake.set()

    async def _start_next(self) -> None:
        """Let PostgreSQL choose among diagnostics eligible for the single Jobs native lane."""
        self._expire_queued_jobs_and_remove_old_records()
        queued = [
            record
            for record in self.records.values()
            if record.snapshot.status == "queued"
        ]
        local_job = min(
            (
                record
                for record in queued
                if record.snapshot.operation != SHARED_OPERATION
            ),
            key=lambda record: record.dispatch_order,
            default=None,
        )
        eligible = {
            str(record.snapshot.jobId): record.snapshot.priority
            for record in queued
            if record.snapshot.operation == SHARED_OPERATION
            and (local_job is None or record.dispatch_order < local_job.dispatch_order)
        }
        claim = None
        record = local_job
        if self.scheduler is not None and (
            eligible or self.scheduler.unanswered is not None
        ):
            try:
                claim = await self.scheduler.claim(eligible)
            except httpx2.HTTPError:
                # Recover the same token before any diagnostic starts. Legacy work is independent.
                claim = None
            if claim is not None:
                grant, attempt = claim
                record = self.records.get(grant.job_id)
                self._expire_queued_jobs_and_remove_old_records()
                if (
                    record is not None
                    and record.snapshot.status == "queued"
                    and not grant.may_start
                ):
                    self._finish(record, "failed")
                if (
                    not self.accepting
                    or record is None
                    or record.snapshot.status != "queued"
                ):
                    self.active = asyncio.create_task(
                        self._release(grant.job_id, attempt)
                    )
                    return
        if (
            record is not None
            and record.snapshot.status == "queued"
            and time.monotonic() >= record.queue_deadline
        ):
            self._finish(record, "expired")
            if claim is not None:
                self.active = asyncio.create_task(
                    self._release(record.snapshot.jobId, claim[1])
                )
            return
        if record is not None and self.accepting and record.snapshot.status == "queued":
            record.snapshot.status = "running"
            record.snapshot.startedAt = datetime.now(timezone.utc)
            self.active = asyncio.create_task(self._execute(record, claim))

    async def _dispatch(self) -> None:
        """Run the highest-priority waiting job, reconciling expiry every 100 ms."""
        while self.accepting or self.active is not None:
            self.wake.clear()
            self._expire_queued_jobs_and_remove_old_records()
            if self.withdrawals:
                removed = set(islice(self.withdrawals, self.settings.record_capacity))
                try:
                    await self.scheduler.withdraw(removed)
                    self.withdrawals.difference_update(removed)
                except httpx2.HTTPError:
                    # The queue deadline also bounds retention during an outage.
                    pass
            if self.active is not None and self.active.done():
                await self.active
                self.active = None
            if self.accepting and self.active is None:
                async with self.queue_changes:
                    await self._start_next()
            if not self.accepting and self.active is None:
                break
            try:
                await asyncio.wait_for(self.wake.wait(), timeout=0.1)
            except TimeoutError:
                pass
