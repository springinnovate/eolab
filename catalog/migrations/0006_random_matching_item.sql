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

-- Select uniformly by ordinal from the filtered result set. This scans the
-- matching rows without a full-result random sort. The exclusion is retried
-- only when it removed the sole
-- match, allowing repeated discovery to avoid an immediate repeat whenever
-- another Item exists.
CREATE OR REPLACE FUNCTION pgstac.eolab_random_matching_item(
    search_request jsonb,
    excluded_collection text DEFAULT NULL,
    excluded_item_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path TO pgstac, public
AS $function$
DECLARE
    item_where text;
    matching_count bigint;
    random_offset bigint;
    selected_item jsonb;
BEGIN
    item_where := pgstac.stac_search_to_where(search_request);

    EXECUTE format(
        'SELECT count(*) FROM pgstac.items
         WHERE (%s)
           AND ($1 IS NULL OR collection <> $1 OR id <> $2)',
        item_where
    )
    INTO matching_count
    USING excluded_collection, excluded_item_id;

    IF matching_count = 0 AND excluded_collection IS NOT NULL THEN
        excluded_collection := NULL;
        excluded_item_id := NULL;
        EXECUTE format(
            'SELECT count(*) FROM pgstac.items WHERE (%s)',
            item_where
        )
        INTO matching_count;
    END IF;

    IF matching_count = 0 THEN
        RETURN NULL;
    END IF;

    random_offset := floor(random() * matching_count)::bigint;
    EXECUTE format(
        'SELECT pgstac.content_hydrate(item) FROM pgstac.items AS item
         WHERE (%s)
           AND ($1 IS NULL OR collection <> $1 OR id <> $2)
         OFFSET $3 LIMIT 1',
        item_where
    )
    INTO selected_item
    USING excluded_collection, excluded_item_id, random_offset;

    RETURN selected_item;
END;
$function$;

COMMIT;
