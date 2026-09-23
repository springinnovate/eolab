CREATE SCHEMA IF NOT EXISTS saved_maps;
CREATE TABLE IF NOT EXISTS saved_maps.maps (
    slug text PRIMARY KEY,
    title text NOT NULL,
    view jsonb NOT NULL CHECK (jsonb_typeof(view) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
