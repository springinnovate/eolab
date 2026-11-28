"""Manage a supervisor's transient tickets in the shared PostgreSQL worker queue."""

from dataclasses import dataclass
from datetime import datetime
from typing import Any, NamedTuple
from uuid import UUID

import psycopg

from eolab_jobs.job_notifications import JOB_QUEUE_CHANNEL
from eolab_jobs.worker_claim import claim_next_job, renew_job_lease


class ExecutorReplaced(Exception):
    """Another supervisor generation owns this executor's queue."""


class ClaimedTicket(NamedTuple):
    """Identify the claimed ticket and whether its lease permits starting a child."""

    job_id: UUID
    may_start: bool


@dataclass(frozen=True)
class ExecutorTickets:
    """Operate on one supervisor's tickets inside a queue-locked transaction.

    The caller holds the shared queue lock and commits before sending a grant
    or acknowledging a stopped attempt. Database errors propagate to the caller.

    Attributes:
        cursor: Dictionary-row cursor in the locked PostgreSQL transaction.
        scope: Stable deployment identity of this replaceable supervisor.
        operation: Installed operation that this supervisor may execute.
        worker_count: Maximum running or cancelling jobs across all workers.
        lease_seconds: Duration of a new or renewed worker lease.
    """

    cursor: psycopg.Cursor[dict[str, Any]]
    scope: str
    operation: str
    worker_count: int
    lease_seconds: int

    def current_instance(self) -> UUID | None:
        """Return the active generation, or None before the first activation."""
        self.cursor.execute(
            "SELECT instance FROM processing.executor_sessions WHERE scope=%s",
            (self.scope,),
        )
        row = self.cursor.fetchone()
        return row["instance"] if row else None

    def replace_stopped_instance(self, instance: UUID, previous: UUID | None) -> None:
        """Discard a stopped supervisor's tickets and install its replacement.

        Repeating the same activation preserves the replacement's tickets.

        Args:
            instance: Generation of the new supervisor.
            previous: Generation observed after the previous children had exited.

        Raises:
            ExecutorReplaced: If a different replacement acquired this scope.
        """
        active = self.current_instance()
        if active == instance:
            return
        if active != previous:
            raise ExecutorReplaced("Executor generation changed during replacement")
        self.cursor.execute(
            "DELETE FROM processing.jobs WHERE executor_scope=%s", (self.scope,)
        )
        if self.cursor.rowcount:
            self._notify_capacity()
        self.cursor.execute(
            "INSERT INTO processing.executor_sessions(scope,instance) VALUES (%s,%s) "
            "ON CONFLICT(scope) DO UPDATE SET instance=excluded.instance, "
            "claim_sequence=0, stopped_attempt=NULL, stopped_with_lease=false",
            (self.scope, instance),
        )

    def admit(self, job_id: UUID, submitted_at: datetime, expires_at: datetime) -> None:
        """Queue one opaque ticket with the original admission time and deadline.

        Args:
            job_id: Ticket identifier, stable across retries.
            submitted_at: Original timezone-aware arrival time.
            expires_at: Time after which this ticket cannot start.
        """
        identifier = str(job_id)
        self.cursor.execute(
            "INSERT INTO processing.jobs(id,operation,executor_scope,status,created_at,expires_at,reserved_bytes) "
            "VALUES (%s,%s,%s,'queued',%s,%s,0) ON CONFLICT(id) DO NOTHING",
            (identifier, self.operation, self.scope, submitted_at, expires_at),
        )
        if self.cursor.rowcount:
            self.cursor.execute(
                "INSERT INTO processing.job_subscribers(id,job_id,owner,request_key,created_at) "
                "VALUES (%s,%s,%s,%s,%s)",
                (
                    identifier,
                    identifier,
                    f"executor:{self.scope}",
                    identifier,
                    submitted_at,
                ),
            )

    def claim(
        self, sequence: int, attempt: UUID, priorities: dict[UUID, int]
    ) -> ClaimedTicket | None:
        """Claim an eligible waiting ticket or recover this attempt after a lost reply.

        Args:
            sequence: Increasing claim number, reused when retrying the request.
            attempt: Supervisor-chosen token identifying this claim.
            priorities: Eligible waiting tickets with their current priorities.

        Returns:
            The ticket and permission to start, or None when no ticket is available.
            An expired replay identifies the ticket so its supervisor can confirm
            native exit and release its slot.
        """
        self.cursor.execute(
            "UPDATE processing.executor_sessions SET claim_sequence=%s WHERE scope=%s AND claim_sequence<%s",
            (sequence, self.scope, sequence),
        )
        fresh = bool(self.cursor.rowcount)
        self.cursor.execute(
            "SELECT id,attempt_id FROM processing.jobs WHERE executor_scope=%s "
            "AND status IN ('running','cancelling')",
            (self.scope,),
        )
        active = self.cursor.fetchone()
        if active:
            if active["attempt_id"] != attempt.hex:
                return None
            may_start = renew_job_lease(
                self.cursor,
                job_id=active["id"],
                attempt_id=attempt.hex,
                lease_seconds=self.lease_seconds,
                progress={},
            )
            return ClaimedTicket(UUID(active["id"]), may_start)
        if not fresh or not priorities:
            return None
        job = claim_next_job(
            self.cursor,
            worker_count=self.worker_count,
            lease_seconds=self.lease_seconds,
            supported_operations=[self.operation],
            attempt_id=attempt.hex,
            executor_scope=self.scope,
            priorities={str(job_id): value for job_id, value in priorities.items()},
        )
        return ClaimedTicket(UUID(job["id"]), True) if job else None

    def withdraw(self, identifiers: list[UUID]) -> None:
        """Remove cancelled or expired waiting tickets from this supervisor's queue.

        Args:
            identifiers: Tickets whose callers stopped waiting.
        """
        self.cursor.execute(
            "DELETE FROM processing.jobs WHERE executor_scope=%s AND status='queued' "
            "AND id=ANY(%s)",
            (self.scope, [str(identifier) for identifier in identifiers]),
        )

    def renew(self, job_id: UUID, attempt: UUID) -> bool:
        """Extend a running child's lease while its ticket and attempt are current.

        Args:
            job_id: Claimed transient ticket.
            attempt: Fencing token for this attempt.

        Returns:
            Whether the attempt still holds a live lease.
        """
        self.cursor.execute(
            "SELECT FROM processing.jobs WHERE id=%s AND executor_scope=%s",
            (str(job_id), self.scope),
        )
        return self.cursor.fetchone() is not None and renew_job_lease(
            self.cursor,
            job_id=str(job_id),
            attempt_id=attempt.hex,
            lease_seconds=self.lease_seconds,
            progress={},
        )

    def release_stopped_attempt(self, job_id: UUID, attempt: UUID) -> bool:
        """Release a slot after the supervisor confirms that its native child has exited.

        Args:
            job_id: Ticket whose child has exited or never started.
            attempt: The exact attempt the supervisor has reaped.

        Returns:
            Whether the attempt held a live lease at release. A retry after an
            unanswered acknowledgement returns the same outcome.
        """
        self.cursor.execute(
            "DELETE FROM processing.jobs WHERE id=%s AND executor_scope=%s AND attempt_id=%s "
            "RETURNING lease_until > clock_timestamp() AS live",
            (str(job_id), self.scope, attempt.hex),
        )
        stopped = self.cursor.fetchone()
        if stopped is not None:
            self.cursor.execute(
                "UPDATE processing.executor_sessions SET stopped_attempt=%s, stopped_with_lease=%s WHERE scope=%s",
                (attempt, stopped["live"], self.scope),
            )
            self._notify_capacity()
            return stopped["live"]
        self.cursor.execute(
            "SELECT stopped_with_lease FROM processing.executor_sessions WHERE scope=%s AND stopped_attempt=%s",
            (self.scope, attempt),
        )
        acknowledged = self.cursor.fetchone()
        return bool(acknowledged and acknowledged["stopped_with_lease"])

    def _notify_capacity(self) -> None:
        """Wake waiting workers when this transaction commits released capacity."""
        self.cursor.execute("SELECT pg_notify(%s, '')", (JOB_QUEUE_CHANNEL,))
