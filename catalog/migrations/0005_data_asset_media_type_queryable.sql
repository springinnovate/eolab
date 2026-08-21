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

-- Expose the scanner-owned data Asset media type without copying it into a
-- second Item property or requiring existing Items to be rescanned.
CREATE OR REPLACE FUNCTION pgstac.eolab_data_asset_media_type(
    item_content jsonb
)
RETURNS text
AS $function$
    SELECT item_content->'assets'->'data'->>'type';
$function$
LANGUAGE SQL IMMUTABLE PARALLEL SAFE STRICT;

DO $queryable$
DECLARE
    existing_queryable pgstac.queryables%ROWTYPE;
BEGIN
    SELECT *
    INTO existing_queryable
    FROM pgstac.queryables
    WHERE
        name = 'eolab_data_asset_media_type'
        AND collection_ids IS NULL;

    IF NOT FOUND THEN
        INSERT INTO pgstac.queryables (
            name,
            definition,
            property_path,
            property_wrapper
        ) VALUES (
            'eolab_data_asset_media_type',
            '{"type":"string","title":"Data Asset media type"}'::jsonb,
            'content',
            'eolab_data_asset_media_type'
        );
    ELSIF
        existing_queryable.definition IS DISTINCT FROM
            '{"type":"string","title":"Data Asset media type"}'::jsonb
        OR existing_queryable.property_path IS DISTINCT FROM 'content'
        OR existing_queryable.property_wrapper IS DISTINCT FROM
            'eolab_data_asset_media_type'
        OR existing_queryable.property_index_type IS NOT NULL
    THEN
        RAISE EXCEPTION 'EOLab data Asset media type queryable has an unexpected definition';
    END IF;
END;
$queryable$;

-- Keep this index application-owned. pgSTAC's generated queryable indexes
-- assume values live directly below Item properties, while this expression
-- intentionally reads the authoritative nested Asset metadata.
CREATE INDEX IF NOT EXISTS eolab_items_data_asset_media_type_idx
ON pgstac.items (pgstac.eolab_data_asset_media_type(content));

COMMIT;
