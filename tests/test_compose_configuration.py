"""Test deployment contracts expressed by Docker Compose."""

from pathlib import Path


COMPOSE_PATH = Path(__file__).parents[1] / "docker-compose.yml"


def test_public_app_variables_are_not_self_referential() -> None:
    """Keep Coolify deployment inputs editable instead of Compose-managed."""
    compose = COMPOSE_PATH.read_text(encoding="utf-8")
    variable_mappings = {
        "APP_TITLE": "EOLAB_APP_TITLE",
        "APP_SUBTITLE": "EOLAB_APP_SUBTITLE",
        "CATALOG_URL": "EOLAB_CATALOG_URL",
        "BASEMAP_URL": "EOLAB_BASEMAP_URL",
        "BASEMAP_ATTRIBUTION": "EOLAB_BASEMAP_ATTRIBUTION",
        "INITIAL_LATITUDE": "EOLAB_INITIAL_LATITUDE",
        "INITIAL_LONGITUDE": "EOLAB_INITIAL_LONGITUDE",
        "INITIAL_ZOOM": "EOLAB_INITIAL_ZOOM",
    }

    for container_variable, deployment_variable in variable_mappings.items():
        assert f'"{container_variable}=${{{deployment_variable}' in compose
        assert f'"{deployment_variable}=${{{deployment_variable}' not in compose


def test_scan_paths_share_one_read_only_deployment_mount() -> None:
    """Keep the host mount separate from container-relative scan paths."""
    compose = COMPOSE_PATH.read_text(encoding="utf-8")

    assert "source: ${EOLAB_SCAN_MOUNT_PATH}" in compose
    assert "target: /scan-source" in compose
    assert "read_only: true" in compose
    assert '"SCAN_MOUNT_PATH=/scan-source"' in compose
    assert '"SCAN_PATHS_WITHIN_MOUNT=${EOLAB_SCAN_PATHS_WITHIN_MOUNT:' in compose
    assert '"SCAN_DISPLAY_PATH_PREFIX=${EOLAB_SCAN_DISPLAY_PATH_PREFIX:' in compose
    assert '"SCAN_WORKER_COUNT=${EOLAB_SCAN_WORKER_COUNT:-8}"' in compose
    assert '"EOLAB_SCAN_MOUNT_PATH=${EOLAB_SCAN_MOUNT_PATH' not in compose


def test_app_can_count_existing_catalog_items() -> None:
    """Give the app read access to pgSTAC for one count at scan start."""
    compose = COMPOSE_PATH.read_text(encoding="utf-8")

    assert '"PGHOST=database"' in compose
    assert '"PGPORT=5432"' in compose
    assert '"PGDATABASE=eolab"' in compose
    assert '"PGUSER=eolab"' in compose
    assert '"PGPASSWORD=${EOLAB_DATABASE_PASSWORD:' in compose


def test_internal_stac_api_enables_writes_for_scanning() -> None:
    """Enable internal transaction routes while the app proxy remains read-only."""
    compose = COMPOSE_PATH.read_text(encoding="utf-8")

    assert '"ENABLE_TRANSACTIONS_EXTENSIONS=TRUE"' in compose


def test_catalog_migrator_packages_application_migrations() -> None:
    """Apply EOLab indexes after the pinned pgSTAC schema migration."""
    repository_root = COMPOSE_PATH.parent
    compose = COMPOSE_PATH.read_text(encoding="utf-8")
    dockerfile = (repository_root / "Dockerfile.catalog-migrate").read_text(
        encoding="utf-8"
    )
    migration_script = (repository_root / "catalog" / "migrate.sh").read_text(
        encoding="utf-8"
    )
    index_migration = (
        repository_root
        / "catalog"
        / "migrations"
        / "0001_item_substring_indexes.sql"
    ).read_text(encoding="utf-8")

    assert "dockerfile: Dockerfile.catalog-migrate" in compose
    assert "pypgstac migrate" in migration_script
    assert "psql --set=ON_ERROR_STOP=1" in migration_script
    assert "COPY catalog/migrations/ /catalog/migrations/" in dockerfile
    assert "pgstac.get_version() <> '0.9.12'" in index_migration
    assert "CREATE EXTENSION IF NOT EXISTS pg_trgm" in index_migration
    assert "eolab_items_title_trgm_idx" in index_migration
    assert "eolab_items_description_trgm_idx" in index_migration
    assert index_migration.count("USING GIN") == 2
    assert index_migration.count("gin_trgm_ops") == 2
    assert "upper(pgstac.to_text(content->'properties'->'title'))" in index_migration
    assert (
        "upper(pgstac.to_text(content->'properties'->'description'))"
        in index_migration
    )


def test_stac_api_uses_the_pinned_upstream_image() -> None:
    """Use upstream CQL2 Filter support without a custom API image."""
    compose = COMPOSE_PATH.read_text(encoding="utf-8")

    assert "stac-fastapi-pgstac:6.3.1@sha256:" in compose
    assert "dockerfile: Dockerfile.stac-api" not in compose
