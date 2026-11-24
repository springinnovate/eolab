-- Run once under the queue lock after validating the version 22 schema.
-- A large retained history can take longer to copy than a normal worker query.
-- The transaction lock timeout and the next transaction's query timeout still apply.
SET LOCAL statement_timeout = 0;

CREATE TABLE processing.job_turns (
    job_id text NOT NULL REFERENCES processing.jobs(id) ON DELETE CASCADE,
    owner text NOT NULL,
    started_at timestamptz NOT NULL,
    PRIMARY KEY (job_id, owner)
);

-- Version 22 did not record when a subscription first stopped participating.
-- Carry forward starts supported by the surviving records. A later edit or
-- deletion timestamp cannot establish that a cancelled owner was present.
INSERT INTO processing.job_turns (job_id, owner, started_at)
SELECT DISTINCT j.id, s.owner, j.started_at
FROM processing.jobs AS j
JOIN processing.job_subscribers AS s ON s.job_id = j.id
WHERE s.created_at <= j.started_at
  AND (s.status IS NULL OR s.status = 'cancelling'
       OR (s.status = 'deleted' AND s.status_before_deletion IS NULL));

CREATE INDEX job_turns_by_owner ON processing.job_turns (owner, started_at DESC);

CREATE FUNCTION processing.record_job_turns() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO processing.job_turns (job_id, owner, started_at)
    SELECT DISTINCT NEW.id, s.owner, NEW.started_at
    FROM processing.job_subscribers AS s
    WHERE s.job_id = NEW.id AND s.status IS NULL;
    RETURN NEW;
END $$;

CREATE TRIGGER record_job_turns AFTER UPDATE OF started_at ON processing.jobs
FOR EACH ROW WHEN (OLD.started_at IS NULL AND NEW.started_at IS NOT NULL)
EXECUTE FUNCTION processing.record_job_turns();

INSERT INTO processing.schema_version VALUES (23);
