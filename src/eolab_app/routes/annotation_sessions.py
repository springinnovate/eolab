"""Same-origin HTTP API for joining sessions and sharing annotation layers."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress
import hashlib
import logging
import re
import secrets
from typing import Annotated, Any
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Request, Response
from fastapi.routing import APIRoute
from starlette.responses import JSONResponse

from eolab_app.annotation_sessions.models import (
    SessionSummary,
    SessionSnapshot,
    InvitationSnapshot,
    SharedLayerContents,
    CreateSession,
    ContributorProfile,
    ContributorColor,
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
            if request.method in {"POST", "PUT", "PATCH"}:
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
        response: Response that renews the private cookie for one year.

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
        max_age=365 * 86400,
        secure=True,
        httponly=True,
        samesite="strict",
        path="/",
    )
    return hashlib.sha256(token.encode()).hexdigest()


def create_annotation_sessions_router(store: AnnotationSessionStore) -> APIRouter:
    """Expose session commands and own periodic join-attempt cleanup.

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
            """Retry unavailable storage and periodically remove old join-attempt counters.

            Returns:
                Runs until application shutdown cancels the task.
            """
            while True:
                delay = 300
                try:
                    await asyncio.to_thread(store.initialize_and_clean_join_attempts)
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
        """List this browser's shared annotation layers.

        Args:
            browser: Authenticated cookie hash.

        Returns:
            Session summaries for restoring or switching sessions.
        """
        return store.list_sessions(browser)

    @router.post("", status_code=201, response_model=SessionSnapshot)
    def create(payload: CreateSession, browser: Browser) -> dict[str, Any]:
        """Create a shared layer and its first contributor.

        Args:
            payload: Shared-layer and contributor display names.
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
        """Join with the supplied display name while retaining any existing membership.

        Args:
            payload: Join code and contributor display name.
            browser: Authenticated cookie hash.

        Returns:
            The session snapshot with the caller's supplied display name.

        Raises:
            SessionError: If the code is unavailable, new membership is disallowed,
                join limits are reached or storage is unavailable.
        """
        return store.get_session_snapshot(
            store.join_session(browser, payload.joinCode, payload.contributorName),
            browser,
        )

    @router.patch("/{session_id}/profile", response_model=ContributorProfile)
    def update_profile(
        session_id: UUID, payload: ContributorProfile, browser: Browser
    ) -> ContributorProfile:
        """Change this browser's contributor name without editing another member.

        Args:
            session_id: Active session the browser has joined.
            payload: Validated display name.
            browser: Authenticated browser-cookie hash.

        Returns:
            The name saved for this contributor.

        Raises:
            SessionError: If membership is absent or storage is unavailable.
        """
        store.update_contributor_name(session_id, browser, payload.name)
        return payload

    @router.patch("/{session_id}/color", response_model=ContributorColor)
    def update_color(
        session_id: UUID, payload: ContributorColor, browser: Browser
    ) -> ContributorColor:
        """Change your polygon color in this shared layer.

        Args:
            session_id: Shared layer the browser has joined.
            payload: Validated hexadecimal fill color.
            browser: Authenticated cookie hash; the request cannot name another author.

        Returns:
            The saved color, applied to all of this contributor's polygons.

        Raises:
            SessionError: If membership is absent or storage is unavailable.
        """
        store.update_contributor_color(session_id, browser, payload.color)
        return ContributorColor(color=payload.color.upper())

    @router.get("/{session_id}", response_model=SessionSnapshot)
    def snapshot(session_id: UUID, browser: Browser) -> dict[str, Any]:
        """Read contributor identities and shared polygon revisions.

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

    @router.get("/{session_id}/export")
    def export(session_id: UUID, browser: Browser) -> JSONResponse:
        """Download current contributions with contributor names and identifiers.

        Args:
            session_id: Session identifier.
            browser: Authenticated member cookie hash.

        Returns:
            GeoJSON attachment with the original authorship of every polygon.
        """
        return JSONResponse(
            store.export_session_geojson(session_id, browser),
            media_type="application/geo+json",
            headers={
                "Content-Disposition": 'attachment; filename="shared-annotations.geojson"'
            },
        )

    @router.get(
        "/invitations/{session_id}/{join_code}", response_model=InvitationSnapshot
    )
    def view_invited_layer(
        session_id: UUID,
        join_code: Annotated[str, Path(pattern=r"^[A-Z2-9]{8}$")],
        browser: Annotated[str, Depends(browser_identity)],
    ) -> dict[str, Any]:
        """Read live contributor and revision metadata without joining the layer.

        Args:
            session_id: Shared layer referenced by the map.
            join_code: Invitation belonging to that same layer.
            browser: Private cookie hash for recognizing an existing contributor.

        Returns:
            Current metadata and this browser's existing contributor ID, if any.

        Raises:
            SessionError: If the invitation is invalid or storage is unavailable.
        """
        return store.get_session_snapshot(session_id, browser, join_code=join_code)

    @router.get(
        "/invitations/{session_id}/{join_code}/contributors/{contributor_id}/layers/{layer_id}",
        response_model=SharedLayerContents,
    )
    def read_invited_contribution(
        session_id: UUID,
        join_code: Annotated[str, Path(pattern=r"^[A-Z2-9]{8}$")],
        contributor_id: UUID,
        layer_id: UUID,
        browser: Annotated[str, Depends(browser_identity)],
    ) -> dict[str, Any]:
        """Read one current contribution through the map's layer invitation.

        Args:
            session_id: Layer referenced by the map.
            join_code: Invitation for that layer, not an edit credential.
            contributor_id: Author of the requested polygons.
            layer_id: Contribution's layer identifier.
            browser: Private browser-cookie hash.

        Returns:
            Validated polygon collection and its revision.

        Raises:
            SessionError: If the invitation or requested contribution is unavailable.
        """
        return store.read_shared_layer(
            session_id,
            browser,
            contributor_id,
            layer_id,
            join_code=join_code,
        )

    return router
