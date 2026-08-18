"""Create the EOLab FastAPI application and serve its browser assets."""

from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from eolab_app.settings import load_settings


def create_app() -> FastAPI:
    """Create an application from the deployment environment.

    Returns:
        A FastAPI application configured from the validated deployment
        environment, with its health and public-configuration routes
        registered and its static frontend mounted.

    Raises:
        KeyError: If a required environment variable is missing.
        ValueError: If an environment value violates the settings contract.
    """
    app_global_configuration = load_settings()
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
