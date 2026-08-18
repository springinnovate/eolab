"""Create the EOLab FastAPI application and serve its browser assets."""

from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from eolab_app.settings import APPLICATION_VERSION_PATH, load_settings


def create_app(version_file_path: Path = APPLICATION_VERSION_PATH) -> FastAPI:
    """Create an application from the deployment environment.

    Args:
        version_file_path: File containing the Git-derived application version.

    Returns:
        A FastAPI application configured from the validated deployment
        environment, with its health and public-configuration routes
        registered and its static frontend mounted.

    Raises:
        FileNotFoundError: If the baked version file does not exist.
        KeyError: If a required environment variable is missing.
        ValueError: If an environment value violates the settings contract.
    """
    app_global_configuration = load_settings(version_file_path)
    application = FastAPI(
        title=app_global_configuration.app_title,
        description=app_global_configuration.app_subtitle,
        version=app_global_configuration.app_version,
    )

    @application.get("/healthz", tags=["system"])
    def healthz() -> dict[str, str]:
        """Report application liveness and the configured release version.

        Returns:
            The current liveness status.
        """
        return {
            "status": "ok",
            "service": "eolab",
            "version": app_global_configuration.app_version,
        }

    @application.get("/api/config", tags=["system"])
    def public_configuration() -> dict[str, object]:
        """Return the browser-safe application configuration.

        Returns:
            The public application configuration.
        """
        return app_global_configuration.as_public_dict()

    static_directory = Path(__file__).parent / "static"
    application.mount(
        "/",
        StaticFiles(directory=static_directory, html=True, check_dir=False),
        name="frontend",
    )

    return application
