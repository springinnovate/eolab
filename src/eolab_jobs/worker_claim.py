"""PostgreSQL claim used by workers sharing the durable job queue.

Run this statement after acquiring the queue's transaction advisory lock, with
the worker count, a fresh attempt ID and the lease duration in seconds. It
returns the claimed job and the subscriber whose turn it was, or no row when
there is no capacity or eligible work.
"""

from typing import Final


CLAIM_NEXT_JOB_SQL: Final = """
WITH waiting AS (
    SELECT DISTINCT ON (s.owner) j.id, s.owner, j.created_at
    FROM processing.jobs AS j
    JOIN processing.job_subscribers AS s ON s.job_id = j.id
    WHERE j.status = 'queued' AND s.status IS NULL
    ORDER BY s.owner, j.created_at, j.id
), next_job AS (
    SELECT waiting.id, waiting.owner
    FROM waiting
    LEFT JOIN LATERAL (
        SELECT j.started_at
        FROM processing.jobs AS j
        JOIN processing.job_subscribers AS s ON s.job_id = j.id
        WHERE s.owner = waiting.owner AND j.started_at IS NOT NULL
        ORDER BY j.started_at DESC
        LIMIT 1
    ) AS last_served ON true
    WHERE (SELECT count(*) FROM processing.jobs
           WHERE status IN ('running', 'cancelling')) < %(worker_count)s
    ORDER BY last_served.started_at NULLS FIRST, waiting.created_at, waiting.id
    LIMIT 1
)
UPDATE processing.jobs AS job
SET status = 'running', attempt_id = %(attempt_id)s,
    lease_until = now() + %(lease_seconds)s * interval '1 second',
    started_at = clock_timestamp(), updated_at = now()
FROM next_job
WHERE job.id = next_job.id
RETURNING job.*, next_job.owner
"""
