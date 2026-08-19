BEGIN;

INSERT INTO pgstac.pgstac_settings (name, value)
VALUES
    ('context', 'on'),
    -- Recount each search so a scan refresh cannot return a cached total.
    ('context_stats_ttl', '0 seconds')
ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value;

COMMIT;
