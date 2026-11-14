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

-- Return only the deliberately public metadata envelopes on an Item and Assets.
-- Source selectors, hrefs and unrelated Item properties are never traversed.
CREATE OR REPLACE FUNCTION pgstac.eolab_curated_envelopes(item_content jsonb)
RETURNS SETOF jsonb
LANGUAGE SQL IMMUTABLE PARALLEL SAFE STRICT
AS $function$
    SELECT envelope
    FROM (
        SELECT item_content->'properties'->'eolab:metadata' AS envelope
        UNION ALL
        SELECT asset->'eolab:metadata'
        FROM jsonb_each(COALESCE(item_content->'assets', '{}'::jsonb)) AS assets(key, asset)
        WHERE key NOT IN ('eolab:temporal-source', 'eolab:vector-field-values',
                          'eolab:asset-source', 'eolab:descriptor-source')
    ) AS envelopes
    WHERE jsonb_typeof(envelope) = 'object';
$function$;

-- Extract scalar values, not JSON keys or syntax. Null has no searchable text;
-- zero and false remain meaningful supplied annotations.
-- Curated annotation objects are author-declared public, including their keys.
CREATE OR REPLACE FUNCTION pgstac.eolab_metadata_scalar_text(metadata_value jsonb)
RETURNS SETOF text
LANGUAGE SQL IMMUTABLE PARALLEL SAFE STRICT
AS $function$
    SELECT scalar #>> '{}'
    FROM jsonb_path_query(
        metadata_value,
        'strict $.** ? (@.type() == "string" || @.type() == "number" || @.type() == "boolean")'
    ) AS scalar_values(scalar);
$function$;

-- Project the v1 envelope's explicit public fields. Publication IDs are internal
-- associations; supplied study_ids remain ordinary searchable text.
-- Unknown fields cannot silently enter the projection with a future schema.
CREATE OR REPLACE FUNCTION pgstac.eolab_item_metadata_text(item_content jsonb)
RETURNS text
LANGUAGE SQL IMMUTABLE PARALLEL SAFE STRICT
AS $function$
    WITH envelopes AS MATERIALIZED (
        SELECT envelope FROM pgstac.eolab_curated_envelopes(item_content) AS envelope
    ), selected_values AS (
        SELECT jsonb_build_array(
            envelope->'title', envelope->'description', envelope->'keywords',
            envelope->'license', envelope->'attribution', envelope->'doi',
            envelope->'citation', envelope->'categories', envelope->'risks',
            envelope->'statuses', envelope->'study_ids', envelope->'study_time',
            envelope->'annotations'
        ) AS value FROM envelopes
        UNION ALL
        SELECT jsonb_build_array(
            publication->'title', publication->'doi', publication->'citation',
            publication->'authors', publication->'year', publication->'notes',
            publication->'annotations'
        )
        FROM envelopes, jsonb_array_elements(
            COALESCE(envelope->'publications', '[]'::jsonb)
        ) AS publication
        UNION ALL
        SELECT jsonb_build_array(asset->'title', asset->'description')
        FROM jsonb_each(COALESCE(item_content->'assets', '{}'::jsonb)) AS assets(key, asset)
        WHERE key NOT IN ('eolab:temporal-source', 'eolab:vector-field-values',
                          'eolab:asset-source', 'eolab:descriptor-source')
    ), combined_values AS (
        -- Walk one JSON value per Item. Calling the set-returning scalar helper
        -- for every selected field multiplies planner estimates and triggers
        -- repeated JIT compilation during ordinary bulk ingestion.
        SELECT jsonb_agg(value) AS value FROM selected_values
    ), scalar_values AS (
        SELECT DISTINCT scalar
        FROM combined_values, pgstac.eolab_metadata_scalar_text(value) AS scalar
    )
    -- pgSTAC also applies a queryable wrapper to the literal operand of a
    -- direct comparison. Preserve that JSON string instead of treating it as
    -- an Item. Nested casei comparisons supply their own scalar wrapper.
    SELECT CASE WHEN jsonb_typeof(item_content) = 'string'
        THEN item_content #>> '{}'
        ELSE string_agg(scalar, E'\n' ORDER BY scalar COLLATE "C") END
    FROM scalar_values;
$function$;

-- Return distinct lowercase labels across Item and Asset envelopes. Each filter
-- matches the owning Item; separate filters may match different Assets.
CREATE OR REPLACE FUNCTION pgstac.eolab_item_metadata_labels(
    item_content jsonb, label_field text
)
RETURNS jsonb
LANGUAGE SQL IMMUTABLE PARALLEL SAFE STRICT
AS $function$
    SELECT COALESCE(jsonb_agg(label ORDER BY label COLLATE "C"), '[]'::jsonb)
    FROM (
        SELECT DISTINCT lower(value #>> '{}') AS label
        FROM pgstac.eolab_curated_envelopes(item_content) AS envelope,
            jsonb_array_elements(COALESCE(envelope->label_field, '[]'::jsonb)) AS value
    ) AS labels;
$function$;

COMMENT ON FUNCTION pgstac.eolab_item_metadata_text(jsonb) IS
'Search supplied Item/Asset metadata scalar values and Asset titles/descriptions; exclude private source fields, URLs and internal publication IDs. Preserve JSON string operands when used as a pgSTAC queryable wrapper. Ordinary Item upserts and deletes maintain the expression indexes.';
COMMENT ON FUNCTION pgstac.eolab_item_metadata_labels(jsonb, text) IS
'Return unique lowercase labels from one curated field across the Item and its Assets for exact case-insensitive CQL2 array membership.';

DO $queryables$
DECLARE
    desired record;
    existing pgstac.queryables%ROWTYPE;
BEGIN
    FOR desired IN SELECT * FROM (VALUES
        ('eolab_metadata_text',
            '{"type":"string","title":"Curated dataset and supporting-file text"}'::jsonb,
            'content', 'eolab_item_metadata_text'),
        ('eolab_categories',
            '{"type":"array","items":{"type":"string"},"title":"Category labels"}'::jsonb,
            'pgstac.eolab_item_metadata_labels(content, ''categories'')', 'to_text_array'),
        ('eolab_time_basis',
            '{"type":"string","title":"Observation or source-modified timestamp basis"}'::jsonb,
            'content->''properties''->''eolab:time_basis''', 'to_text')
    ) AS definitions(name, definition, property_path, property_wrapper)
    LOOP
        SELECT * INTO existing FROM pgstac.queryables
        WHERE name = desired.name AND collection_ids IS NULL;
        IF NOT FOUND THEN
            INSERT INTO pgstac.queryables (name, definition, property_path, property_wrapper)
            VALUES (desired.name, desired.definition, desired.property_path, desired.property_wrapper);
        ELSIF existing.definition IS DISTINCT FROM desired.definition
            OR existing.property_path IS DISTINCT FROM desired.property_path
            OR existing.property_wrapper IS DISTINCT FROM desired.property_wrapper
            OR existing.property_index_type IS NOT NULL THEN
            RAISE EXCEPTION 'Curated metadata queryable % has an unexpected definition', desired.name;
        END IF;
    END LOOP;
END;
$queryables$;

-- pgSTAC generates indexes only for direct properties. These application-owned
-- expressions match its CQL2 compilation while leaving partition policy intact.
CREATE INDEX IF NOT EXISTS eolab_items_metadata_text_trgm_idx ON pgstac.items
USING GIN ((upper(pgstac.eolab_item_metadata_text(content))) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS eolab_items_categories_idx ON pgstac.items
USING GIN (pgstac.to_text_array(pgstac.eolab_item_metadata_labels(content, 'categories')));

COMMIT;
