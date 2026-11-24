"""Serialize durable queue writes and assign leased attempts to available workers."""

from typing import Any, Final
from uuid import uuid4

import psycopg

# Deployed PostgreSQL single-bigint advisory key, shared by claims and queue writes.
JOB_QUEUE_LOCK_ID: Final = 7_610_329

_WORKER_SLOT_AVAILABLE_SQL: Final = """
SELECT count(*) < %(worker_count)s AS available
FROM processing.jobs
WHERE status IN ('running', 'cancelling')
"""

_CLAIM_NEXT_JOB_SQL: Final = """
WITH waiting AS (
    SELECT DISTINCT ON (s.owner) j.id, s.owner, s.created_at AS submitted_at, s.id AS subscriber_id
    FROM processing.jobs AS j
    JOIN processing.job_subscribers AS s ON s.job_id = j.id
    WHERE j.status = 'queued' AND s.status IS NULL
      AND (%(supported_operations)s::text[] IS NULL OR j.operation = ANY(%(supported_operations)s))
    ORDER BY s.owner, s.created_at, s.id
), next_job AS (
    SELECT waiting.id, waiting.owner, clock_timestamp() AS started_at
    FROM waiting
    LEFT JOIN LATERAL (
        SELECT turn.started_at
        FROM processing.job_turns AS turn
        WHERE turn.owner = waiting.owner
        ORDER BY turn.started_at DESC
        LIMIT 1
    ) AS last_served ON true
    ORDER BY last_served.started_at NULLS FIRST, waiting.submitted_at, waiting.subscriber_id
    LIMIT 1
)
UPDATE processing.jobs AS job
SET status = 'running', attempt_id = %(attempt_id)s,
    lease_until = next_job.started_at + %(lease_seconds)s * interval '1 second',
    started_at = next_job.started_at, updated_at = next_job.started_at
FROM next_job
WHERE job.id = next_job.id
RETURNING job.*, next_job.owner
"""


def lock_job_queue(cursor: psycopg.Cursor[dict[str, Any]]) -> None:
    """Serialize queue decisions until the caller's transaction ends.

    Args:
        cursor: Open cursor in an explicit or implicitly started transaction.

    Raises:
        psycopg.Error: If PostgreSQL cannot acquire the advisory lock.
    """
    cursor.execute("SELECT pg_advisory_xact_lock(%s)", (JOB_QUEUE_LOCK_ID,))


def claim_next_job(
    cursor: psycopg.Cursor[dict[str, Any]],
    *,
    worker_count: int,
    lease_seconds: int,
    supported_operations: list[str] | None,
) -> dict[str, Any] | None:
    """Claim a compatible job for the next session under the shared worker limit.

    An idle connection commits the claim on return. Inside an existing transaction
    the caller controls the final commit or rollback, including the recorded turn.
    Start native work only after commit.

    Args:
        cursor: Dictionary-row cursor on the queue database at read committed isolation.
        worker_count: Shared limit on running and cancelling jobs.
        lease_seconds: Initial lease duration measured from the recorded start.
        supported_operations: Operation IDs this worker can execute. An empty list
            claims nothing. None selects across all operations.

    Returns:
        The running job row with its selected owner and new attempt ID, or None
        when the pool is full or no compatible subscribed job is waiting.

    Raises:
        psycopg.Error: If PostgreSQL cannot lock, select or update the queue.
    """
    with cursor.connection.transaction():
        lock_job_queue(cursor)
        cursor.execute(_WORKER_SLOT_AVAILABLE_SQL, {"worker_count": worker_count})
        if not cursor.fetchone()["available"]:
            return None
        cursor.execute(
            _CLAIM_NEXT_JOB_SQL,
            {
                "attempt_id": uuid4().hex,
                "lease_seconds": lease_seconds,
                "supported_operations": supported_operations,
            },
        )
        return cursor.fetchone()
