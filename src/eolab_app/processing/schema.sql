-- Processing owns this schema; pgSTAC migrations and tables are untouched.
CREATE SCHEMA IF NOT EXISTS processing;
CREATE TABLE IF NOT EXISTS processing.schema_version (
    version integer PRIMARY KEY
);
-- Early clip-only installations constrained this registry to version 1.
ALTER TABLE processing.schema_version DROP CONSTRAINT IF EXISTS schema_version_version_check;
INSERT INTO processing.schema_version VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS processing.plans (
    id text PRIMARY KEY,
    owner text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    planning_until timestamptz,
    request jsonb NOT NULL,
    spec jsonb
);
CREATE INDEX IF NOT EXISTS plans_owner ON processing.plans(owner, expires_at);
CREATE TABLE IF NOT EXISTS processing.jobs (
    id text PRIMARY KEY,
    owner text NOT NULL,
    request_key text NOT NULL,
    plan_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('queued', 'running', 'cancelling', 'ready', 'failed', 'cancelled', 'interrupted', 'expired', 'deleted')),
    spec jsonb,
    reserved_bytes bigint NOT NULL CHECK (reserved_bytes >= 0),
    summary jsonb NOT NULL DEFAULT '{}'::jsonb,
    attempt_id text,
    lease_until timestamptz,
    deadline_at timestamptz,
    progress jsonb NOT NULL DEFAULT '{}'::jsonb,
    artifact jsonb,
    error jsonb,
    UNIQUE (owner, request_key)
);
ALTER TABLE processing.jobs ADD COLUMN IF NOT EXISTS summary jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE processing.jobs ADD COLUMN IF NOT EXISTS operation text NOT NULL DEFAULT '';
ALTER TABLE processing.jobs ADD COLUMN IF NOT EXISTS minimum_claim_version integer NOT NULL DEFAULT 1;
-- Legacy workers do not declare a claim protocol. They must not start a job
-- requiring the newer explicit operation dispatcher during a rolling deploy.
CREATE OR REPLACE FUNCTION processing.require_claim_protocol() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'running' AND OLD.status = 'queued'
       AND COALESCE(NULLIF(current_setting('eolab.processing_claim_version', true), ''), '1')::integer < NEW.minimum_claim_version THEN
        RAISE EXCEPTION 'Worker claim protocol does not support this job' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS processing_claim_protocol ON processing.jobs;
CREATE TRIGGER processing_claim_protocol BEFORE UPDATE OF status ON processing.jobs
FOR EACH ROW EXECUTE FUNCTION processing.require_claim_protocol();
INSERT INTO processing.schema_version VALUES (2) ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS jobs_owner ON processing.jobs(owner, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_status ON processing.jobs(status, created_at);
CREATE TABLE IF NOT EXISTS processing.transfers (
    id text PRIMARY KEY,
    job_id text NOT NULL REFERENCES processing.jobs(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS transfers_job ON processing.transfers(job_id, expires_at);
