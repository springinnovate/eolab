-- List active published maps that still store the retired shared polygon label setting.
-- The result shows only map URL names and includes affected version 5 maps.
-- Run before upgrading from the repository root with PostgreSQL connection settings for the site.
-- psql -X -v ON_ERROR_STOP=1 -f scripts/saved-map-upgrade/list-retired-shared-label-settings.sql

SELECT slug FROM saved_maps.maps
WHERE deleted_at IS NULL
  AND view @? '$.layers[*] ? (exists(@.sharedAnnotation) && exists(@.appearance.notes))'
ORDER BY slug;
