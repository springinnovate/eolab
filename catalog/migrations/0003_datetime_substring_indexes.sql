BEGIN;

SET LOCAL search_path TO pgstac, public;

DO $migration$
BEGIN
    IF pgstac.get_version() <> '0.9.12' THEN
        RAISE EXCEPTION 'EOLab catalog migrations require pgSTAC 0.9.12, found %',
            pgstac.get_version();
    END IF;
END;
$migration$;

-- pgSTAC's standard datetime queryables are timestamps, so they cannot be
-- operands of a literal CQL2 LIKE. These aliases expose the original standard
-- STAC fields as text without adding custom properties to Items.
MERGE INTO pgstac.queryables AS existing
USING (
    VALUES
        (
            'eolab_datetime_text',
            '{"type":"string","title":"Item datetime or start datetime text"}'::jsonb,
            $path$(COALESCE(
                NULLIF(content->'properties'->'datetime', 'null'::jsonb),
                content->'properties'->'start_datetime'
            ))$path$
        ),
        (
            'eolab_end_datetime_text',
            '{"type":"string","title":"Item end datetime text"}'::jsonb,
            $path$(content->'properties'->'end_datetime')$path$
        )
) AS desired(name, definition, property_path)
ON existing.name = desired.name AND existing.collection_ids IS NULL
-- Existing definitions belong to this immutable migration. Updating one fires
-- pgSTAC's partition-index maintenance and conflicts with the attached trigram
-- indexes below; a definition change therefore requires a later migration.
WHEN NOT MATCHED THEN
    INSERT (name, definition, property_path, property_wrapper)
    VALUES (desired.name, desired.definition, desired.property_path, 'to_text');

CREATE INDEX IF NOT EXISTS eolab_items_datetime_text_trgm_idx
ON pgstac.items
USING GIN ((upper(pgstac.to_text(
    COALESCE(
        NULLIF(content->'properties'->'datetime', 'null'::jsonb),
        content->'properties'->'start_datetime'
    )
))) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS eolab_items_end_datetime_text_trgm_idx
ON pgstac.items
USING GIN ((upper(pgstac.to_text(
    content->'properties'->'end_datetime'
))) gin_trgm_ops);

COMMIT;
