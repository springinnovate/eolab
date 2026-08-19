BEGIN;

INSERT INTO pgstac.pgstac_settings (name, value)
VALUES
    ('context', 'auto'),
    -- EOLab invalidates this cache after scans; the TTL covers other writers.
    ('context_stats_ttl', '1 day')
ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value;

COMMIT;
