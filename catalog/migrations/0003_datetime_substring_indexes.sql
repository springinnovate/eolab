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
DO $queryables$
DECLARE
    has_datetime_queryable boolean;
    has_end_datetime_queryable boolean;
BEGIN
    SELECT
        EXISTS (
            SELECT 1 FROM pgstac.queryables
            WHERE name = 'eolab_datetime_text' AND collection_ids IS NULL
        ),
        EXISTS (
            SELECT 1 FROM pgstac.queryables
            WHERE name = 'eolab_end_datetime_text' AND collection_ids IS NULL
        )
    INTO has_datetime_queryable, has_end_datetime_queryable;

    IF has_datetime_queryable <> has_end_datetime_queryable THEN
        RAISE EXCEPTION 'EOLab datetime queryables are partially initialized';
    END IF;

    -- Avoid executing any queryables write when both records exist: pgSTAC's
    -- statement-level trigger maintains partition indexes even for zero rows.
    IF NOT has_datetime_queryable THEN
        INSERT INTO pgstac.queryables (
            name,
            definition,
            property_path,
            property_wrapper
        ) VALUES
            (
                'eolab_datetime_text',
                '{"type":"string","title":"Item datetime or start datetime text"}'::jsonb,
                $path$(COALESCE(
                    NULLIF(content->'properties'->'datetime', 'null'::jsonb),
                    content->'properties'->'start_datetime'
                ))$path$,
                'to_text'
            ),
            (
                'eolab_end_datetime_text',
                '{"type":"string","title":"Item end datetime text"}'::jsonb,
                $path$(content->'properties'->'end_datetime')$path$,
                'to_text'
            );
    END IF;
END;
$queryables$;

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
