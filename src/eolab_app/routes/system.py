"""HTTP routes for application identity and liveness."""

from fastapi import APIRouter, Request, Response

from eolab_app.routes.browser_identity import establish_browser_identity


def create_system_router(
    app_version: str,
    public_configuration: dict[str, object],
) -> APIRouter:
    """Create system routes from browser-safe application values.

    Args:
        app_version: Baked Git-derived application version.
        public_configuration: Validated browser-safe configuration document.

    Returns:
        Router exposing liveness and browser startup configuration.
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
    def configuration(request: Request, response: Response) -> dict[str, object]:
        """Establish browser ownership and return its startup configuration.

        Browser composition awaits this same-origin request before starting
        concurrent feature requests. Do not establish a Strict cookie on HTML
        navigation: a cross-site link can omit an existing browser cookie.

        Args:
            request: Startup request carrying the same-origin browser cookie.
            response: Private, non-cacheable response that sets the owner cookie.

        Returns:
            Public application configuration without ownership credentials.
        """
        establish_browser_identity(request, response)
        response.headers["Cache-Control"] = "private, no-store"
        return public_configuration

    return router
