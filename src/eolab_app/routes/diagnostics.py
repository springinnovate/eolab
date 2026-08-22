"""HTTP route for the browser-safe rendering diagnostics summary."""

from typing import Protocol

from fastapi import APIRouter, Response

from eolab_app.diagnostics import RenderingDiagnostics


class RenderingDiagnosticsProvider(Protocol):
    """Provide the current browser-safe rendering observation."""

    async def get(self) -> RenderingDiagnostics:
        """Return the current rendering observation.

        Returns:
            Available metrics or the stable unavailable variant.
        """


def create_diagnostics_router(
    diagnostics: RenderingDiagnosticsProvider,
) -> APIRouter:
    """Create the rendering diagnostics route.

    Args:
        diagnostics: Application service that supplies current observations.

    Returns:
        Router exposing the browser-safe diagnostics endpoint.
    """
    router = APIRouter(tags=["rendering"])

    @router.get(
        "/api/rendering/diagnostics",
        response_model=RenderingDiagnostics,
    )
    async def diagnostics_summary(response: Response) -> RenderingDiagnostics:
        """Return a non-cacheable summary of internal rendering state.

        Args:
            response: Outgoing response whose cache policy is set here.

        Returns:
            Current allowlisted metrics or the stable unavailable variant.
        """
        response.headers["cache-control"] = "no-store"
        return await diagnostics.get()

    return router
