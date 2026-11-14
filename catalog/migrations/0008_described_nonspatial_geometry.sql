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

COMMIT;
