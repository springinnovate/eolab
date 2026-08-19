BEGIN;

DO $migration$
BEGIN
    IF pgstac.get_version() <> '0.9.12' THEN
        RAISE EXCEPTION 'EOLab catalog migrations require pgSTAC 0.9.12, found %',
            pgstac.get_version();
    END IF;
END;
$migration$;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS eolab_items_title_trgm_idx
ON pgstac.items
USING GIN ((
    upper(pgstac.to_text(content->'properties'->'title'))
) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS eolab_items_description_trgm_idx
ON pgstac.items
USING GIN ((
    upper(pgstac.to_text(content->'properties'->'description'))
) gin_trgm_ops);

COMMIT;
