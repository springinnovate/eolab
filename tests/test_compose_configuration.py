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
    assert '"SCAN_WRITER_COUNT=${EOLAB_SCAN_WRITER_COUNT:-4}"' in compose
    assert '"SCAN_BATCH_SIZE=${EOLAB_SCAN_BATCH_SIZE:-100}"' in compose
    assert '"EOLAB_SCAN_MOUNT_PATH=${EOLAB_SCAN_MOUNT_PATH' not in compose


def test_app_and_geoserver_refuse_a_writable_scan_mount() -> None:
    """Verify the effective kernel mode before either long-running service starts."""
    repository_root = COMPOSE_PATH.parent
    app_dockerfile = (repository_root / "Dockerfile").read_text(encoding="utf-8")
    geoserver_dockerfile = (repository_root / "Dockerfile.geoserver").read_text(
        encoding="utf-8"
    )
    guard = (
        repository_root / "deployment" / "require-read-only-scan-source.sh"
    ).read_text(encoding="utf-8")

    entrypoint = 'ENTRYPOINT ["/usr/local/bin/require-read-only-scan-source"]'
    assert entrypoint in app_dockerfile
    assert entrypoint in geoserver_dockerfile
    assert 'CMD ["bash", "/opt/startup.sh"]' in geoserver_dockerfile
    assert (
        "FROM docker.osgeo.org/geoserver:3.0.1@sha256:"
        "7cb827ba3f6d9fc04a6647fc0cfa6c254fc642407f0d99281fdf026d2540b558"
        in geoserver_dockerfile
    )
    assert '/proc/self/mountinfo' in guard
    assert '/scan-source ro(,| )' in guard
    assert 'exec "$@"' in guard


def test_app_image_avoids_repeated_gdal_directory_listing() -> None:
    """Avoid enumerating large mounted directories for every dataset open."""
    dockerfile = (COMPOSE_PATH.parent / "Dockerfile").read_text(encoding="utf-8")

    assert "GDAL_DISABLE_READDIR_ON_OPEN=TRUE" in dockerfile


def test_app_can_inventory_existing_catalog_items() -> None:
    """Give the app database access to classify existing scanner Items."""
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


def test_geoserver_is_internal_persistent_and_reads_the_scan_mount() -> None:
    """Keep GeoServer private while preserving its config and shared datasets."""
    compose = COMPOSE_PATH.read_text(encoding="utf-8")
    geoserver_service = compose.split("  geoserver:\n", 1)[1].split(
        "  geoserver-init:\n", 1
    )[0]

    assert "dockerfile: Dockerfile.geoserver" in geoserver_service
    assert "ports:" not in geoserver_service
    assert '"8080"' in geoserver_service
    assert "source: ${EOLAB_SCAN_MOUNT_PATH}" in geoserver_service
    assert "target: /scan-source" in geoserver_service
    assert "read_only: true" in geoserver_service
    assert "geoserver-data:/opt/geoserver_data" in geoserver_service
    assert '"RUN_UNPRIVILEGED=true"' in geoserver_service
    assert '"SKIP_DEMO_DATA=true"' in geoserver_service
    assert '"CORS_ENABLED=false"' in geoserver_service
    assert '"JSONP_ENABLED=false"' in geoserver_service
    assert (
        '"PROXY_BASE_URL=$${X-Forwarded-Proto}://$${X-Forwarded-Host}/geoserver '
        'http://geoserver:8080/geoserver"'
        in geoserver_service
    )
    assert '"PROXY_BASE_URL_HEADERS=true"' in geoserver_service
    assert '"GEOSERVER_ADMIN_PASSWORD=${EOLAB_GEOSERVER_ADMIN_PASSWORD:' in (
        geoserver_service
    )
    assert "start_period: 120s" in geoserver_service
    assert "name: ${EOLAB_GEOSERVER_DATA_VOLUME_NAME:-eolab-geoserver-data}" in (
        compose
    )


def test_geoserver_initializer_is_idempotent_image_owned_configuration() -> None:
    """Package bootstrap assets and gate them on a healthy GeoServer."""
    repository_root = COMPOSE_PATH.parent
    compose = COMPOSE_PATH.read_text(encoding="utf-8")
    initializer = (repository_root / "geoserver" / "initialize.py").read_text(
        encoding="utf-8"
    )
    initializer_dockerfile = (
        repository_root / "Dockerfile.geoserver-init"
    ).read_text(encoding="utf-8")

    assert "dockerfile: Dockerfile.geoserver-init" in compose
    assert "condition: service_healthy" in compose
    assert '"GEOSERVER_MASTER_PASSWORD=${EOLAB_GEOSERVER_MASTER_PASSWORD:' in compose
    assert "COPY geoserver/ ./" in initializer_dockerfile
    assert 'client.request("DELETE"' not in initializer
    assert 'WORKSPACE_NAME = "eolab"' in initializer
    assert 'RASTER_STYLE_NAME = "dynamic-raster"' in initializer


def test_app_keeps_geoserver_registration_credentials_internal() -> None:
    """Give the backend REST access without exposing the keystore secret."""
    compose = COMPOSE_PATH.read_text(encoding="utf-8")
    app_service = compose.split("  app:\n", 1)[1].split("\nvolumes:\n", 1)[0]

    assert '"WMS_URL=/geoserver/eolab/wms"' in app_service
    assert '"GEOSERVER_INTERNAL_URL=http://geoserver:8080/geoserver"' in app_service
    assert '"GEOSERVER_ADMIN_USER=eolab"' in app_service
    assert '"GEOSERVER_ADMIN_PASSWORD=${EOLAB_GEOSERVER_ADMIN_PASSWORD:' in app_service
    assert "EOLAB_GEOSERVER_MASTER_PASSWORD" not in app_service
    assert "depends_on:" not in app_service


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


def test_catalog_migrator_adds_datetime_substring_queryables() -> None:
    """Expose standard STAC datetime values as indexed text queryables."""
    migration = (
        COMPOSE_PATH.parent
        / "catalog"
        / "migrations"
        / "0003_datetime_substring_indexes.sql"
    ).read_text(encoding="utf-8")

    assert "eolab_datetime_text" in migration
    assert "eolab_end_datetime_text" in migration
    assert "MERGE INTO pgstac.queryables" not in migration
    assert "IF has_datetime_queryable <> has_end_datetime_queryable" in migration
    assert "IF NOT has_datetime_queryable THEN" in migration
    assert "NULLIF(content->'properties'->'datetime', 'null'::jsonb)" in migration
    assert "content->'properties'->'start_datetime'" in migration
    assert "eolab_items_datetime_text_trgm_idx" in migration
    assert "eolab_items_end_datetime_text_trgm_idx" in migration
    assert migration.count("USING GIN") == 2
    assert migration.count("gin_trgm_ops") == 2


def test_catalog_migrator_hides_datetime_paths_from_pgstac_indexes() -> None:
    """Keep application trigram indexes outside pgSTAC's index ownership."""
    migration = (
        COMPOSE_PATH.parent
        / "catalog"
        / "migrations"
        / "0004_datetime_index_wrappers.sql"
    ).read_text(encoding="utf-8")

    assert "eolab_item_datetime_text(item_content jsonb)" in migration
    assert "eolab_item_end_datetime_text" in migration
    assert "property_path = 'content'" in migration
    assert "upper(pgstac.eolab_item_datetime_text(content))" in migration
    assert "upper(pgstac.eolab_item_end_datetime_text(content))" in migration
    assert migration.count("gin_trgm_ops") == 2


def test_stac_api_uses_the_pinned_upstream_image() -> None:
    """Use upstream CQL2 Filter support without a custom API image."""
    compose = COMPOSE_PATH.read_text(encoding="utf-8")

    assert "stac-fastapi-pgstac:6.3.1@sha256:" in compose
    assert "dockerfile: Dockerfile.stac-api" not in compose
