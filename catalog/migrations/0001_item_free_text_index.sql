BEGIN;

DO $migration$
BEGIN
    IF pgstac.get_version() <> '0.9.12' THEN
        RAISE EXCEPTION 'EOLab catalog migrations require pgSTAC 0.9.12, found %',
            pgstac.get_version();
    END IF;
END;
$migration$;

CREATE INDEX IF NOT EXISTS eolab_items_free_text_idx
ON pgstac.items
USING GIN ((
    to_tsvector('english', content->'properties'->>'description') ||
    to_tsvector('english', coalesce(content->'properties'->>'title', '')) ||
    to_tsvector('english', coalesce(content->'properties'->>'keywords', ''))
));

COMMIT;
