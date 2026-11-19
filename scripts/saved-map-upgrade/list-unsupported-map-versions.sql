-- List active published maps whose saved settings are outside version 5.
-- The result shows the map URL name and its stored version, if present.
-- Run before upgrading from the repository root with PostgreSQL connection settings for the site.
-- psql -X -v ON_ERROR_STOP=1 -f scripts/saved-map-upgrade/list-unsupported-map-versions.sql

SELECT slug, view->>'schemaVersion' AS version FROM saved_maps.maps
WHERE deleted_at IS NULL AND view->'schemaVersion' IS DISTINCT FROM '5'::jsonb ORDER BY slug;
