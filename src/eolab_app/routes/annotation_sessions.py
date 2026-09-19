"""Same-origin HTTP API for joining sessions and sharing annotation layers."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress
import hashlib
import logging
import re
import secrets
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.routing import APIRoute
from starlette.responses import JSONResponse

from eolab_app.annotation_sessions.models import (
    SessionSummary,
    SessionSnapshot,
    SharedLayerContents,
    CreateSession,
    JoinSession,
    SessionError,
    ShareLayer,
    MAX_LAYER_BYTES,
)
from eolab_app.annotation_sessions.store import AnnotationSessionStore

COOKIE = "__Host-eolab-annotations"


class AnnotationSessionRoute(APIRoute):
    """Limit uploaded annotation JSON before parsing and translate storage failures."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        """Wrap the route with a bounded body reader and private response headers.

        Returns:
            Handler preserving normal FastAPI request validation.
        """
        handler = super().get_route_handler()

        async def bounded(request: Request) -> Response:
            """Read at most one layer and report errors without exposing database details.

            Args:
                request: Incoming browser request.

            Returns:
                Uncacheable success or actionable error response.

            Raises:
                HTTPException: If the request body exceeds the upload limit.
            """
            if request.method in {"POST", "PUT"}:
                body = bytearray()
                async for chunk in request.stream():
                    if len(body) + len(chunk) > MAX_LAYER_BYTES:
                        raise HTTPException(
                            413, "Annotation requests must fit within 8 MiB."
                        )
                    body.extend(chunk)
                delivered = False
                original_receive = request.receive

                async def receive() -> dict[str, Any]:
                    """Replay the bounded body exactly once.

                    Returns:
                        ASGI body message or the original disconnect event.
                    """
                    nonlocal delivered
                    if not delivered:
                        delivered = True
                        return {
                            "type": "http.request",
                            "body": bytes(body),
                            "more_body": False,
                        }
                    return await original_receive()

                request = Request(request.scope, receive)
            try:
                response = await handler(request)
            except SessionError as error:
                response = JSONResponse(
                    {"detail": str(error)}, status_code=error.status
                )
            response.headers["Cache-Control"] = "private, no-store"
            response.headers["X-Content-Type-Options"] = "nosniff"
            return response

        return bounded


def browser_identity(request: Request, response: Response) -> str:
    """Recognize a browser using an automatically generated private cookie.

    Args:
        request: Same-origin browser request.
        response: Response that receives a new HttpOnly cookie when needed.

    Returns:
        A one-way hash for membership lookups; the cookie is never returned as JSON.

    Raises:
        HTTPException: If a mutation lacks the same-origin request header.
    """
    if request.method != "GET":
        origin = request.headers.get("origin")
        if (
            request.headers.get("sec-fetch-site") == "cross-site"
            or (origin and urlsplit(origin).netloc != request.url.netloc)
            or request.headers.get("x-eolab-annotations") != "1"
        ):
            raise HTTPException(
                403, "Use a same-origin request with X-EOLab-Annotations: 1."
            )
    token = request.cookies.get(COOKIE, "")
    if not re.fullmatch(r"[a-f0-9]{64}", token):
        token = secrets.token_hex(32)
        response.set_cookie(
            COOKIE,
            token,
            max_age=30 * 86400,
            secure=True,
            httponly=True,
            samesite="strict",
            path="/",
        )
    return hashlib.sha256(token.encode()).hexdigest()


def create_annotation_sessions_router(store: AnnotationSessionStore) -> APIRouter:
    """Expose session commands and own periodic expired-data cleanup.

    Args:
        store: Annotation sessions' PostgreSQL storage.

    Returns:
        Router mounted independently of catalog, rendering and raster analysis.
    """

    @asynccontextmanager
    async def lifespan(_: Any) -> AsyncIterator[None]:
        """Maintain session storage without making other app features depend on it.

        Args:
            _: Application supplied by FastAPI.

        Yields:
            Control while routes are serving.
        """

        async def maintain() -> None:
            """Retry unavailable storage and periodically remove expired contributions.

            Returns:
                Runs until application shutdown cancels the task.
            """
            while True:
                delay = 300
                try:
                    await asyncio.to_thread(
                        store.initialize_and_remove_expired_sessions
                    )
                except SessionError:
                    logging.getLogger(__name__).warning(
                        "Annotation-session storage unavailable; retrying in 10 seconds"
                    )
                    delay = 10
                await asyncio.sleep(delay)

        task = asyncio.create_task(maintain())
        try:
            yield
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    router = APIRouter(
        prefix="/api/annotation-sessions",
        tags=["annotation sessions"],
        route_class=AnnotationSessionRoute,
        lifespan=lifespan,
    )
    Browser = Annotated[str, Depends(browser_identity)]

    @router.get("", response_model=list[SessionSummary])
    def list_sessions(browser: Browser) -> list[dict[str, Any]]:
        """List this browser's unexpired sessions.

        Args:
            browser: Authenticated cookie hash.

        Returns:
            Session summaries for restoring or switching sessions.
        """
        return store.list_sessions(browser)

    @router.post("", status_code=201, response_model=SessionSnapshot)
    def create(payload: CreateSession, browser: Browser) -> dict[str, Any]:
        """Create a session and its owner membership.

        Args:
            payload: Session and owner display names.
            browser: Authenticated cookie hash.

        Returns:
            The new session snapshot, including its join code.
        """
        return store.get_session_snapshot(
            store.create_session(browser, payload.name, payload.contributorName),
            browser,
        )

    @router.post("/join", response_model=SessionSnapshot)
    def join(payload: JoinSession, browser: Browser) -> dict[str, Any]:
        """Join a session with a code, retaining existing membership on retry.

        Args:
            payload: Join code and contributor display name.
            browser: Authenticated cookie hash.

        Returns:
            The joined session snapshot.
        """
        return store.get_session_snapshot(
            store.join_session(browser, payload.joinCode, payload.contributorName),
            browser,
        )

    @router.get("/{session_id}", response_model=SessionSnapshot)
    def snapshot(session_id: UUID, browser: Browser) -> dict[str, Any]:
        """Read session metadata without extending its lifetime.

        Args:
            session_id: Session identifier.
            browser: Authenticated cookie hash.

        Returns:
            Contributors and latest layer revisions, without polygon bodies.
        """
        return store.get_session_snapshot(session_id, browser)

    @router.get(
        "/{session_id}/contributors/{contributor_id}/layers/{layer_id}",
        response_model=SharedLayerContents,
    )
    def read_layer(
        session_id: UUID, contributor_id: UUID, layer_id: UUID, browser: Browser
    ) -> dict[str, Any]:
        """Read one shared polygon layer.

        Args:
            session_id: Session identifier.
            contributor_id: Layer author's identifier.
            layer_id: Author's layer identifier.
            browser: Authenticated reader cookie hash.

        Returns:
            GeoJSON and its revision.
        """
        return store.read_shared_layer(session_id, browser, contributor_id, layer_id)

    @router.put("/{session_id}/layers/{layer_id}")
    def share(
        session_id: UUID, layer_id: UUID, payload: ShareLayer, browser: Browser
    ) -> dict[str, int]:
        """Create or replace the caller's contribution using a revision check.

        Args:
            session_id: Session identifier.
            layer_id: Stable local layer identifier.
            payload: New GeoJSON and last acknowledged revision.
            browser: Author's authenticated cookie hash.

        Returns:
            Accepted revision for the next update.
        """
        return {
            "revision": store.save_shared_layer(session_id, browser, layer_id, payload)
        }

    @router.delete("/{session_id}/layers/{layer_id}", status_code=204)
    def withdraw(
        session_id: UUID,
        layer_id: UUID,
        browser: Browser,
        revision: Annotated[int, Query(ge=1)],
    ) -> None:
        """Withdraw the caller's shared copy, leaving local annotations untouched.

        Args:
            session_id: Session identifier.
            layer_id: Author's layer identifier.
            browser: Authenticated author cookie hash.
            revision: Latest observed layer revision.
        """
        store.withdraw_shared_layer(session_id, browser, layer_id, revision)

    @router.post("/{session_id}/actions/{action}", status_code=204)
    def manage(
        session_id: UUID,
        action: Literal["extend", "open-joining", "close-joining", "delete"],
        browser: Browser,
    ) -> None:
        """Extend availability or perform an owner-only session management action.

        Args:
            session_id: Session identifier.
            action: Requested session command.
            browser: Authenticated cookie hash.
        """
        store.apply_session_action(session_id, browser, action)

    @router.get("/{session_id}/export")
    def export(session_id: UUID, browser: Browser) -> JSONResponse:
        """Download current contributions with contributor names and identifiers.

        Args:
            session_id: Session identifier.
            browser: Authenticated member cookie hash.

        Returns:
            GeoJSON attachment suitable for keeping after session expiration.
        """
        return JSONResponse(
            store.export_session_geojson(session_id, browser),
            media_type="application/geo+json",
            headers={
                "Content-Disposition": 'attachment; filename="shared-annotations.geojson"'
            },
        )

    return router
