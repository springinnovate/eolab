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

-- STAC permits geometry:null and no bbox for records without a footprint.
-- Preserve the spatial admission invariant for every other Collection.
ALTER TABLE items ALTER COLUMN geometry DROP NOT NULL;
DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'pgstac.items'::regclass
          AND conname = 'eolab_spatial_geometry_required'
    ) THEN
        ALTER TABLE items ADD CONSTRAINT eolab_spatial_geometry_required
            CHECK (geometry IS NOT NULL OR collection = 'eolab-described-nonspatial');
    END IF;
END;
$migration$;

-- pgSTAC refreshes local partition date checks during range maintenance.
-- Parent invariants are inherited by every partition and must survive that
-- operation; PostgreSQL also forbids dropping an inherited check on a child.
-- Retain the pinned function's signature, authorization and search path.
CREATE OR REPLACE FUNCTION drop_table_constraints(t text) RETURNS text AS $$
DECLARE
    q text;
    _oid oid := partition_oid(t);
BEGIN
    IF _oid IS NULL THEN
        RETURN NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM partition_catalog_meta(t)) THEN
        RETURN NULL;
    END IF;
    t := get_partition_name(_oid);
    FOR q IN SELECT FORMAT(
        'ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I;', t, conname
    ) FROM pg_constraint
        WHERE conrelid = _oid AND contype = 'c' AND coninhcount = 0
    LOOP
        EXECUTE q;
    END LOOP;
    RETURN t;
END;
$$ LANGUAGE PLPGSQL SECURITY DEFINER SET SEARCH_PATH TO pgstac, public;

-- Curated envelopes are complete author-supplied values, not collection-base
-- deltas. Preserve their nulls, empty objects and literal pgSTAC marker strings
-- when the ordinary JSON slimming/merging operations recurse through an Item.
-- Private descriptor ownership also has required nullable fields; preserve that
-- exact reserved Asset so subsequent scans can decode the admitted source.
-- Both callers pass only the fields they own: the admitted Item on write, and
-- the already-projected Item on read. Missing ancestors are built explicitly.
CREATE OR REPLACE FUNCTION eolab_restore_catalog_metadata(
    output jsonb, source jsonb
) RETURNS jsonb AS $$
DECLARE
    asset_key text;
    asset jsonb;
    properties jsonb := output->'properties';
    assets jsonb := output->'assets';
BEGIN
    IF source->'properties' ? 'eolab:metadata' THEN
        properties := COALESCE(properties, '{}'::jsonb) || jsonb_build_object(
            'eolab:metadata', source#>'{properties,eolab:metadata}'
        );
    END IF;
    IF source#>'{properties,datetime}' = 'null'::jsonb THEN
        properties := COALESCE(properties, '{}'::jsonb) || '{"datetime":null}'::jsonb;
    END IF;
    IF properties IS NOT NULL THEN
        output := output || jsonb_build_object('properties', properties);
    END IF;
    FOR asset_key, asset IN SELECT key, value
        FROM jsonb_each(COALESCE(source->'assets', '{}'::jsonb))
        WHERE value ? 'eolab:metadata'
    LOOP
        assets := COALESCE(assets, '{}'::jsonb) || jsonb_build_object(
            asset_key,
            COALESCE(assets->asset_key, '{}'::jsonb) || jsonb_build_object(
                'eolab:metadata', asset->'eolab:metadata'
            )
        );
    END LOOP;
    IF source->'assets' ? 'eolab:descriptor-source' THEN
        assets := COALESCE(assets, '{}'::jsonb) || jsonb_build_object(
            'eolab:descriptor-source', source#>'{assets,eolab:descriptor-source}'
        );
    END IF;
    IF assets IS NOT NULL THEN
        output := output || jsonb_build_object('assets', assets);
    END IF;
    RETURN output;
END;
$$ LANGUAGE PLPGSQL IMMUTABLE PARALLEL SAFE;

CREATE OR REPLACE FUNCTION content_slim(_item jsonb) RETURNS jsonb AS $$
    SELECT eolab_restore_catalog_metadata(
        strip_jsonb(
            _item - '{id,geometry,collection,type}'::text[],
            collection_base_item(_item->>'collection')
        ) - '{id,geometry,collection,type}'::text[],
        _item
    );
$$ LANGUAGE SQL IMMUTABLE PARALLEL SAFE;

CREATE OR REPLACE FUNCTION content_hydrate(
    _item jsonb, _base_item jsonb, fields jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb AS $$
    WITH projected AS (
        SELECT jsonb_fields(_item, fields) AS item,
               jsonb_fields(_base_item, fields) AS base
    ), restored AS (
        SELECT item, eolab_restore_catalog_metadata(merge_jsonb(item, base), item) AS output
        FROM projected
    )
    SELECT CASE
        WHEN _item->>'collection' = 'eolab-described-nonspatial'
            AND item->'geometry' = 'null'::jsonb
        THEN output || '{"geometry":null}'::jsonb
        ELSE output
    END
    FROM restored;
$$ LANGUAGE SQL IMMUTABLE PARALLEL SAFE;

COMMIT;
