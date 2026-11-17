CREATE SCHEMA IF NOT EXISTS drawings;
CREATE TABLE IF NOT EXISTS drawings.layers (
    id uuid PRIMARY KEY,
    owner_hash text NOT NULL,
    local_layer_id text NOT NULL,
    collection jsonb NOT NULL CHECK (jsonb_typeof(collection) = 'object'),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (owner_hash, local_layer_id)
);
CREATE INDEX IF NOT EXISTS drawings_layers_owner
    ON drawings.layers (owner_hash, updated_at DESC, id);
