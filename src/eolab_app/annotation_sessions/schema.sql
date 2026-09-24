CREATE SCHEMA IF NOT EXISTS shared_annotation_layers;
CREATE TABLE IF NOT EXISTS shared_annotation_layers.sessions (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    join_code text UNIQUE NOT NULL,
    joins_open boolean NOT NULL DEFAULT true
);
ALTER TABLE shared_annotation_layers.sessions
    ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE TABLE IF NOT EXISTS shared_annotation_layers.contributors (
    id uuid PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES shared_annotation_layers.sessions ON DELETE CASCADE,
    browser_hash text NOT NULL,
    name text NOT NULL,
    UNIQUE(session_id, browser_hash)
);
CREATE TABLE IF NOT EXISTS shared_annotation_layers.layers (
    contributor_id uuid NOT NULL REFERENCES shared_annotation_layers.contributors ON DELETE CASCADE,
    local_id uuid NOT NULL,
    revision integer NOT NULL,
    collection jsonb NOT NULL,
    bytes integer NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(contributor_id, local_id)
);
ALTER TABLE shared_annotation_layers.contributors
    ADD COLUMN IF NOT EXISTS color text CHECK (color ~ '^#[0-9A-Fa-f]{6}$');
CREATE TABLE IF NOT EXISTS shared_annotation_layers.join_attempts (
    browser_hash text PRIMARY KEY,
    started_at timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL DEFAULT 1
);
