from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from eolab_app.settings import get_settings


def create_app() -> FastAPI:
    application = FastAPI(
        title="EOLab",
        description="Catalog-driven Earth observation application shell.",
        version="0.1.0",
    )

    @application.get("/healthz", tags=["system"])
    def healthz() -> dict[str, str]:
        settings = get_settings()
        return {
            "status": "ok",
            "service": "eolab",
            "version": settings.app_version,
        }

    @application.get("/api/config", tags=["system"])
    def public_config() -> dict[str, object]:
        return get_settings().as_public_dict()

    static_directory = Path(__file__).parent / "static"
    application.mount(
        "/",
        StaticFiles(directory=static_directory, html=True, check_dir=False),
        name="frontend",
    )

    return application


app = create_app()
