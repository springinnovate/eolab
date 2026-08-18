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


def test_scan_source_is_a_required_read_only_deployment_mount() -> None:
    """Let Coolify configure the host path without exposing it in the container."""
    compose = COMPOSE_PATH.read_text(encoding="utf-8")

    assert "source: ${EOLAB_SCAN_SOURCE_PATH:?EOLAB_SCAN_SOURCE_PATH must be set}" in compose
    assert "target: /scan-source" in compose
    assert "read_only: true" in compose
    assert '"SCAN_SOURCE_PATH=/scan-source"' in compose
    assert '"EOLAB_SCAN_SOURCE_PATH=${EOLAB_SCAN_SOURCE_PATH' not in compose


def test_internal_stac_api_enables_writes_for_scanning() -> None:
    """Enable internal transaction routes while the app proxy remains read-only."""
    compose = COMPOSE_PATH.read_text(encoding="utf-8")

    assert '"ENABLE_TRANSACTIONS_EXTENSIONS=TRUE"' in compose
