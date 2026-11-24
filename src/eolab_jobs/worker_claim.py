"""PostgreSQL claim used by workers sharing the durable job queue.

Under the queue's transaction advisory lock, check capacity before issuing the
claim. This keeps the full-pool path independent of the queue and its history.
The claim takes a fresh attempt ID and the lease duration in seconds and returns
the job and selected subscriber, or no row when the queue is empty.
"""

from typing import Final


WORKER_SLOT_AVAILABLE_SQL: Final = """
SELECT count(*) < %(worker_count)s AS available
FROM processing.jobs
WHERE status IN ('running', 'cancelling')
"""

CLAIM_NEXT_JOB_SQL: Final = """
WITH waiting AS (
    SELECT DISTINCT ON (s.owner) j.id, s.owner, j.created_at
    FROM processing.jobs AS j
    JOIN processing.job_subscribers AS s ON s.job_id = j.id
    WHERE j.status = 'queued' AND s.status IS NULL
    ORDER BY s.owner, j.created_at, j.id
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
    ORDER BY last_served.started_at NULLS FIRST, waiting.created_at, waiting.id, waiting.owner
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
