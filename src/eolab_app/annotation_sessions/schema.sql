CREATE SCHEMA IF NOT EXISTS annotation_sessions;
CREATE TABLE IF NOT EXISTS annotation_sessions.sessions (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    join_code text UNIQUE NOT NULL,
    expires_at timestamptz NOT NULL,
    joins_open boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS annotation_sessions.contributors (
    id uuid PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES annotation_sessions.sessions ON DELETE CASCADE,
    browser_hash text NOT NULL,
    name text NOT NULL,
    is_owner boolean NOT NULL DEFAULT false,
    UNIQUE(session_id, browser_hash)
);
CREATE TABLE IF NOT EXISTS annotation_sessions.layers (
    contributor_id uuid NOT NULL REFERENCES annotation_sessions.contributors ON DELETE CASCADE,
    local_id uuid NOT NULL,
    revision integer NOT NULL,
    collection jsonb NOT NULL,
    bytes integer NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(contributor_id, local_id)
);
CREATE TABLE IF NOT EXISTS annotation_sessions.join_attempts (
    browser_hash text PRIMARY KEY,
    started_at timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL DEFAULT 1
);
