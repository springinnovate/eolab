CREATE SCHEMA IF NOT EXISTS planning;
CREATE TABLE IF NOT EXISTS planning.tools (
    id uuid PRIMARY KEY,
    owner_hash text NOT NULL,
    definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS planning_tools_owner ON planning.tools (owner_hash, updated_at DESC, id);
