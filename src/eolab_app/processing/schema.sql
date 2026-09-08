-- Processing owns this schema; pgSTAC migrations and tables are untouched.
CREATE SCHEMA IF NOT EXISTS processing;
CREATE TABLE IF NOT EXISTS processing.schema_version (
    version integer PRIMARY KEY
);
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
CREATE INDEX IF NOT EXISTS jobs_owner ON processing.jobs(owner, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_status ON processing.jobs(status, created_at);
CREATE TABLE IF NOT EXISTS processing.transfers (
    id text PRIMARY KEY,
    job_id text NOT NULL REFERENCES processing.jobs(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS transfers_job ON processing.transfers(job_id, expires_at);
