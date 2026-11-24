"""HTTP routes for application identity and liveness."""

from collections.abc import Callable

from fastapi import APIRouter, Request, Response


def create_system_router(
    app_version: str,
    public_configuration: dict[str, object],
    owner_cookie_issuers: tuple[Callable[[Request, Response], str], ...],
) -> APIRouter:
    """Create system routes from browser-safe application values.

    Args:
        app_version: Baked Git-derived application version.
        public_configuration: Validated browser-safe configuration document.
        owner_cookie_issuers: Functions that set each private ownership cookie on
            the startup response. Their owner hashes stay on the server.

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
        """Set the browser's ownership cookies before returning startup settings.

        Browser tabs coordinate this same-origin request before starting feature
        requests. A cross-site HTML navigation can omit an existing Strict cookie.

        Args:
            request: Startup request carrying any existing owner cookies.
            response: Private, non-cacheable response that sets the owner cookies.

        Returns:
            Public application configuration without ownership credentials.
        """
        for issue_cookie in owner_cookie_issuers:
            issue_cookie(request, response)
        response.headers["Cache-Control"] = "private, no-store"
        return public_configuration

    return router
