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

-- Hide the standard datetime paths behind application-owned functions so
-- pgSTAC's partition-index inspection does not mistake the trigram indexes for
-- its built-in datetime indexes.
CREATE OR REPLACE FUNCTION pgstac.eolab_item_datetime_text(item_content jsonb)
RETURNS text
AS $function$
    SELECT pgstac.to_text(COALESCE(
        NULLIF(item_content->'properties'->'datetime', 'null'::jsonb),
        item_content->'properties'->'start_datetime'
    ));
$function$
LANGUAGE SQL IMMUTABLE PARALLEL SAFE STRICT;

CREATE OR REPLACE FUNCTION pgstac.eolab_item_end_datetime_text(
    item_content jsonb
)
RETURNS text
AS $function$
    SELECT pgstac.to_text(item_content->'properties'->'end_datetime');
$function$
LANGUAGE SQL IMMUTABLE PARALLEL SAFE STRICT;

DO $queryables$
DECLARE
    eolab_queryable_count integer;
    queryables_use_wrappers boolean;
BEGIN
    SELECT
        count(*),
        bool_and(
            property_path IS NOT DISTINCT FROM 'content'
            AND property_wrapper IS NOT DISTINCT FROM CASE name
                WHEN 'eolab_datetime_text' THEN 'eolab_item_datetime_text'
                WHEN 'eolab_end_datetime_text' THEN
                    'eolab_item_end_datetime_text'
            END
            AND property_index_type IS NULL
        )
    INTO eolab_queryable_count, queryables_use_wrappers
    FROM pgstac.queryables
    WHERE
        collection_ids IS NULL
        AND name IN ('eolab_datetime_text', 'eolab_end_datetime_text');

    IF eolab_queryable_count <> 2 THEN
        RAISE EXCEPTION 'Expected two EOLab datetime queryables, found %',
            eolab_queryable_count;
    END IF;

    IF NOT queryables_use_wrappers THEN
        EXECUTE $drop$
            DROP INDEX IF EXISTS
                pgstac.eolab_items_datetime_text_trgm_idx,
                pgstac.eolab_items_end_datetime_text_trgm_idx
        $drop$;

        UPDATE pgstac.queryables
        SET
            property_path = 'content',
            property_wrapper = CASE name
                WHEN 'eolab_datetime_text' THEN 'eolab_item_datetime_text'
                WHEN 'eolab_end_datetime_text' THEN
                    'eolab_item_end_datetime_text'
            END,
            property_index_type = NULL
        WHERE
            collection_ids IS NULL
            AND name IN ('eolab_datetime_text', 'eolab_end_datetime_text');
    END IF;
END;
$queryables$;

CREATE INDEX IF NOT EXISTS eolab_items_datetime_text_trgm_idx
ON pgstac.items
USING GIN ((upper(pgstac.eolab_item_datetime_text(content))) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS eolab_items_end_datetime_text_trgm_idx
ON pgstac.items
USING GIN ((upper(pgstac.eolab_item_end_datetime_text(content))) gin_trgm_ops);

COMMIT;
