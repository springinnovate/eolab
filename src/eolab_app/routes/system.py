"""HTTP routes for application identity and liveness."""

from fastapi import APIRouter


def create_system_router(
    app_version: str,
    public_configuration: dict[str, object],
) -> APIRouter:
    """Create system routes from browser-safe application values.

    Args:
        app_version: Baked Git-derived application version.
        public_configuration: Validated browser-safe configuration document.

    Returns:
        Router exposing liveness and public configuration.
    """
    router = APIRouter(tags=["system"])

    @router.get("/healthz")
    def healthz() -> dict[str, str]:
        """Report application liveness and the configured release version.

        Returns:
            Current liveness status.
        """
        return {
            "status": "ok",
            "service": "eolab",
            "version": app_version,
        }

    @router.get("/api/config")
    def configuration() -> dict[str, object]:
        """Return the browser-safe application configuration.

        Returns:
            Public application configuration.
        """
        return public_configuration

    return router
