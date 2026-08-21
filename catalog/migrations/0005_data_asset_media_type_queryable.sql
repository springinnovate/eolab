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

-- Replace the first draft's whole-Item wrapper. pgSTAC applies a queryable's
-- property_wrapper to both operands of an equality comparison, so an extractor
-- that accepts an Item document cannot be used as a scalar wrapper.
DO $legacy_queryable$
BEGIN
    IF to_regprocedure(
        'pgstac.eolab_data_asset_media_type(jsonb)'
    ) IS NOT NULL THEN
        DROP INDEX IF EXISTS pgstac.eolab_items_data_asset_media_type_idx;
        DROP FUNCTION pgstac.eolab_data_asset_media_type(jsonb);
    END IF;

    DELETE FROM pgstac.queryables
    WHERE
        name = 'eolab_data_asset_media_type'
        AND collection_ids IS NULL;
END;
$legacy_queryable$;

-- Advertise pgSTAC's native nested Asset path. A null property_wrapper makes
-- pgSTAC apply its standard to_text conversion to both the property value and
-- the comparison literal.
DO $queryable$
DECLARE
    existing_queryable pgstac.queryables%ROWTYPE;
BEGIN
    SELECT *
    INTO existing_queryable
    FROM pgstac.queryables
    WHERE
        name = 'assets.data.type'
        AND collection_ids IS NULL;

    IF NOT FOUND THEN
        INSERT INTO pgstac.queryables (
            name,
            definition
        ) VALUES (
            'assets.data.type',
            '{"type":"string","title":"Data Asset media type"}'::jsonb
        );
    ELSIF
        existing_queryable.definition IS DISTINCT FROM
            '{"type":"string","title":"Data Asset media type"}'::jsonb
        OR existing_queryable.property_path IS NOT NULL
        OR existing_queryable.property_wrapper IS NOT NULL
        OR existing_queryable.property_index_type IS NOT NULL
    THEN
        RAISE EXCEPTION 'Data Asset media type queryable has an unexpected definition';
    END IF;
END;
$queryable$;

-- Keep this index application-owned. pgSTAC's generated queryable indexes
-- assume values live directly below Item properties, while this expression
-- intentionally reads the authoritative nested Asset metadata.
CREATE INDEX IF NOT EXISTS eolab_items_data_asset_media_type_idx
ON pgstac.items (
    pgstac.to_text(content->'assets'->'data'->'type')
);

COMMIT;
