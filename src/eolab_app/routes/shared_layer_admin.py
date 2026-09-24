"""Password-protected administration of shared layers, separate from the map UI."""

from collections.abc import Awaitable, Callable
from datetime import datetime
from importlib.resources import files
import secrets
from typing import Annotated, Any
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.routing import APIRoute
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import BaseModel
from starlette.responses import JSONResponse

from eolab_app.annotation_sessions.models import SessionError
from eolab_app.annotation_sessions.store import AnnotationSessionStore


class AdminSharedLayer(BaseModel):
    """Shared-layer metadata for administrators; excludes polygons and credentials.

    Attributes:
        id: Persistent layer identifier.
        name: Display name chosen when creating the layer.
        joinCode: Existing invitation code, usable only while the layer is active.
        deletedAt: Time of reversible deletion, or None for an active layer.
        contributorCount: Number of retained contributor memberships.
        polygonCount: Number of retained polygons across all contributions.
    """

    id: UUID
    name: str
    joinCode: str
    deletedAt: datetime | None
    contributorCount: int
    polygonCount: int


class SharedLayerAdminRoute(APIRoute):
    """Keep administrative responses private, including authentication failures."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        """Apply response protections and translate expected authorization/storage errors.

        Returns:
            Route handler with private cache and browser security headers.
        """
        handler = super().get_route_handler()

        async def respond(request: Request) -> Response:
            """Handle one administration request without exposing database errors.

            Args:
                request: Incoming page, asset or API request.

            Returns:
                Protected response, including an authentication challenge when required.
            """
            try:
                response = await handler(request)
            except HTTPException as error:
                response = JSONResponse(
                    {"detail": error.detail}, error.status_code, headers=error.headers
                )
            except SessionError as error:
                response = JSONResponse({"detail": str(error)}, error.status)
            response.headers.update(
                {
                    "Cache-Control": "private, no-store",
                    "X-Content-Type-Options": "nosniff",
                    "Referrer-Policy": "no-referrer",
                    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
                }
            )
            return response

        return respond


def create_shared_layer_admin_router(
    store: AnnotationSessionStore, password: str
) -> APIRouter:
    """Expose a standalone admin page and reversible shared-layer deletion API.

    Args:
        store: Existing shared-layer store; its normal startup initializes the schema.
        password: Validated administrator password from settings. Empty disables all routes.

    Returns:
        Router requiring HTTP Basic authentication as admin for every page and API call.
        Deploy behind HTTPS; contributor cookies never grant administration access.
    """
    basic = HTTPBasic(auto_error=False, realm="EOLab administration")

    def require_administrator(
        request: Request,
        credentials: Annotated[HTTPBasicCredentials | None, Depends(basic)],
    ) -> None:
        """Authenticate the administrator and require same-origin mutation requests.

        Args:
            request: Page or management API request.
            credentials: Browser's HTTP Basic credentials, if supplied.

        Raises:
            HTTPException: If administration is disabled, authentication fails, or a
                mutation lacks the same-origin custom header.
        """
        if not password:
            raise HTTPException(404, "Administration is not configured.")
        username = credentials.username if credentials else ""
        supplied = credentials.password if credentials else ""
        correct_user = secrets.compare_digest(username.encode(), b"admin")
        correct_password = secrets.compare_digest(supplied.encode(), password.encode())
        if not (correct_user and correct_password):
            raise HTTPException(
                401,
                "Sign in as admin with the administrator password.",
                headers={"WWW-Authenticate": 'Basic realm="EOLab administration"'},
            )
        if request.method not in {"GET", "HEAD"}:
            origin = request.headers.get("origin")
            if (
                request.headers.get("x-eolab-admin") != "1"
                or request.headers.get("sec-fetch-site") == "cross-site"
                or (origin and urlsplit(origin).netloc != request.url.netloc)
            ):
                raise HTTPException(403, "Use the administrator page on this site.")

    router = APIRouter(
        route_class=SharedLayerAdminRoute,
        dependencies=[Depends(require_administrator)],
        tags=["Shared layer administration"],
    )

    @router.get("/admin-eolab", include_in_schema=False)
    def page() -> Response:
        """Return the independent shared-layer management page.

        Returns:
            HTML page containing no shared-layer data or credentials.
        """
        return Response(
            files("eolab_app.annotation_sessions")
            .joinpath("admin.html")
            .read_text(encoding="utf-8"),
            media_type="text/html",
        )

    @router.get("/admin-eolab/admin.js", include_in_schema=False)
    def javascript() -> Response:
        """Return the admin page's client code.

        Returns:
            JavaScript using only the authenticated administration API.
        """
        return Response(
            files("eolab_app.annotation_sessions")
            .joinpath("admin.js")
            .read_text(encoding="utf-8"),
            media_type="text/javascript",
        )

    @router.get("/admin-eolab/admin.css", include_in_schema=False)
    def stylesheet() -> Response:
        """Return the standalone page's styles.

        Returns:
            CSS independent of map controls and the frontend build.
        """
        return Response(
            files("eolab_app.annotation_sessions")
            .joinpath("admin.css")
            .read_text(encoding="utf-8"),
            media_type="text/css",
        )

    @router.get("/api/admin/shared-layers", response_model=list[AdminSharedLayer])
    def list_layers() -> list[dict[str, Any]]:
        """List all retained layers on this site, including deleted ones.

        Returns:
            Metadata and counts without polygon contents or contributor credentials.

        Raises:
            SessionError: If storage is unavailable.
        """
        return store.list_layers_for_administration()

    @router.delete("/api/admin/shared-layers/{layer_id}", status_code=204)
    def delete_layer(layer_id: UUID) -> Response:
        """Make a layer unavailable while preserving its data for Undo.

        Args:
            layer_id: Shared layer selected by the administrator.

        Returns:
            Empty success response; already-deleted layers are unchanged.

        Raises:
            SessionError: If the layer is missing or storage is unavailable.
        """
        store.set_layer_deleted(layer_id, deleted=True)
        return Response(status_code=204)

    @router.post("/api/admin/shared-layers/{layer_id}/restore", status_code=204)
    def restore_layer(layer_id: UUID) -> Response:
        """Restore a deleted layer with the same share code and contributor ownership.

        Args:
            layer_id: Shared layer selected by the administrator.

        Returns:
            Empty success response; active layers are unchanged.

        Raises:
            SessionError: If the layer is missing or storage is unavailable.
        """
        store.set_layer_deleted(layer_id, deleted=False)
        return Response(status_code=204)

    return router
