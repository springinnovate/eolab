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
