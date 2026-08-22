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

-- Give every Item a stable, evenly distributed discovery key. A random key can
-- then seek into this index instead of counting and skipping matching rows.
CREATE INDEX IF NOT EXISTS eolab_items_random_key_idx
ON pgstac.items (
    (md5(collection || ':' || id)),
    collection,
    id
);

-- Seek forward from a random discovery key and wrap once at the end. This is
-- approximately uniform and keeps the interaction responsive without a
-- full-result random sort or offset scan. The current Item is excluded unless
-- it is the only match.
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
    random_key text;
    selected_item jsonb;
BEGIN
    item_where := coalesce(
        nullif(trim(pgstac.stac_search_to_where(search_request)), ''),
        'TRUE'
    );
    random_key := md5(random()::text || clock_timestamp()::text);

    EXECUTE format(
        $query$
         SELECT pgstac.content_hydrate(item) FROM pgstac.items AS item
         WHERE (%s)
           AND ($1 IS NULL OR collection <> $1 OR id <> $2)
           AND md5(collection || ':' || id) >= $3
         ORDER BY md5(collection || ':' || id), collection, id
         LIMIT 1
        $query$,
        item_where
    )
    INTO selected_item
    USING excluded_collection, excluded_item_id, random_key;

    IF selected_item IS NULL THEN
        EXECUTE format(
            $query$
             SELECT pgstac.content_hydrate(item) FROM pgstac.items AS item
             WHERE (%s)
               AND ($1 IS NULL OR collection <> $1 OR id <> $2)
               AND md5(collection || ':' || id) < $3
             ORDER BY md5(collection || ':' || id), collection, id
             LIMIT 1
            $query$,
            item_where
        )
        INTO selected_item
        USING excluded_collection, excluded_item_id, random_key;
    END IF;

    IF selected_item IS NULL AND excluded_collection IS NOT NULL THEN
        EXECUTE format(
            $query$
             SELECT pgstac.content_hydrate(item) FROM pgstac.items AS item
             WHERE (%s)
               AND collection = $1
               AND id = $2
             LIMIT 1
            $query$,
            item_where
        )
        INTO selected_item
        USING excluded_collection, excluded_item_id;
    END IF;

    RETURN selected_item;
END;
$function$;

COMMIT;
