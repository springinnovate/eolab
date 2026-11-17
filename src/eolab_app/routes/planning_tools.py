"""Serve Planning definitions and private browser-owned parcel scenarios."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress
import logging
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.routing import APIRoute
from starlette.responses import JSONResponse

from eolab_app.planning.models import (
    MAX_REQUEST_BYTES,
    PlanningError,
    PlanningTool,
    PlanningToolDocument,
    PlanningToolSummary,
    UpdatePlanningTool,
)
from eolab_app.planning.service import PlanningToolService
from eolab_app.planning.scenario_models import (
    CreateScenario,
    RenameScenario,
    Scenario,
    ScenarioAssignmentPage,
    SetScenarioAssignment,
)
from eolab_app.planning.scenario_service import PlanningScenarioService
from eolab_app.routes.browser_identity import get_browser_owner_hash
from eolab_app.routes.http_disconnect import (
    HttpClientDisconnectedError,
    run_until_http_disconnect,
)


class PlanningRoute(APIRoute):
    """Bound Planning request bodies and keep every response private."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        """Wrap FastAPI validation with private, bounded document delivery.

        Returns:
            Handler preserving disconnect events after bounded parsing.
        """
        handler = super().get_route_handler()

        async def private(request: Request) -> Response:
            """Read a bounded definition and translate errors with private headers.

            Args:
                request: Incoming Planning API request.

            Returns:
                Private endpoint or actionable error response.
            """
            try:
                if request.method in {"POST", "PUT"}:
                    body = bytearray()
                    async for chunk in request.stream():
                        if len(body) + len(chunk) > MAX_REQUEST_BYTES:
                            raise HTTPException(
                                413, "Planning requests must fit within 516 KiB."
                            )
                        body.extend(chunk)
                    delivered = False
                    original_receive = request.receive

                    async def receive() -> dict[str, Any]:
                        """Replay the bounded body once, then forward disconnect events.

                        Returns:
                            Original body or subsequent ASGI receive message.
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
                response = await handler(request)
            except PlanningError as error:
                response = JSONResponse(
                    {"detail": str(error)}, status_code=error.status
                )
            except HTTPException as error:
                response = JSONResponse(
                    {"detail": error.detail},
                    status_code=error.status_code,
                    headers=error.headers,
                )
            except RequestValidationError as error:
                response = await request_validation_exception_handler(request, error)
            except (RecursionError, UnicodeError):
                response = JSONResponse(
                    {
                        "detail": "Planning JSON is too deeply nested or contains invalid text."
                    },
                    status_code=422,
                )
            response.headers["Cache-Control"] = "private, no-store"
            response.headers["X-Content-Type-Options"] = "nosniff"
            return response

        return private


def planning_browser_owner(request: Request, response: Response) -> str:
    """Read browser identity and require same-origin Planning mutations.

    Args:
        request: Browser request with the existing private identity cookie.
        response: Response renewing that cookie.

    Returns:
        Server-only browser owner hash.

    Raises:
        HTTPException: A mutation lacks its required header or comes from another origin.
    """
    return get_browser_owner_hash(request, response, mutation_header="X-EOLab-Planning")


def create_planning_tools_router(service: PlanningToolService) -> APIRouter:
    """Expose author-only tools and initialize storage independently of other APIs.

    Args:
        service: Planning source-validation and persistence owner.

    Returns:
        Router with private responses and independently retried schema setup.
    """

    @asynccontextmanager
    async def lifespan(_: Any) -> AsyncIterator[None]:
        """Retry owned schema setup without delaying unrelated application routes.

        Args:
            _: Application supplied by FastAPI.

        Yields:
            Control while endpoints serve requests.
        """

        async def initialize() -> None:
            """Retry temporary storage outages until initialized or shutdown cancels work.

            Returns:
                Once the Planning schema is ready.
            """
            while True:
                try:
                    await asyncio.to_thread(service.store.initialize_schema)
                    return
                except PlanningError:
                    logging.getLogger(__name__).warning(
                        "Planning storage unavailable; retrying in 10 seconds"
                    )
                    await asyncio.sleep(10)

        task = asyncio.create_task(initialize())
        try:
            yield
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    router = APIRouter(
        prefix="/api/planning/tools",
        tags=["planning"],
        route_class=PlanningRoute,
        lifespan=lifespan,
    )
    Author = Annotated[str, Depends(planning_browser_owner)]

    @router.get("", response_model=list[PlanningToolSummary])
    def list_tools(author: Author) -> list[PlanningToolSummary]:
        """List this browser author's saved Planning tools.

        Args:
            author: Server-derived owner hash.

        Returns:
            Author-only summaries without layer definitions.

        Raises:
            PlanningError: Storage is unavailable.
        """
        return service.store.list_tools(author)

    @router.get(
        "/{identifier}", response_model=PlanningTool, response_model_exclude_unset=True
    )
    def get_tool(identifier: UUID, author: Author) -> PlanningTool:
        """Return a complete tool only to its original browser author.

        Args:
            identifier: Opaque tool ID.
            author: Server-derived owner hash.

        Returns:
            Stored layer roles, intervention names and revision.

        Raises:
            PlanningError: The tool is unavailable to this author or storage failed.
        """
        return service.store.get_tool(author, identifier)

    @router.post(
        "",
        status_code=201,
        response_model=PlanningTool,
        response_model_exclude_unset=True,
    )
    async def create_tool(
        payload: PlanningToolDocument,
        request: Request,
        response: Response,
        author: Author,
    ) -> PlanningTool:
        """Validate live Catalog roles and parcel IDs before saving a new tool.

        Args:
            payload: New durable tool definition.
            request: Request whose disconnect cancels validation.
            response: Response carrying the created tool's location.
            author: Server-derived owner hash.

        Returns:
            Created author-owned definition at revision one.

        Raises:
            HTTPException: The author disconnected during validation.
            PlanningError: Source validation or storage failed.
        """
        try:
            result = await run_until_http_disconnect(
                request, service.create_tool(author, payload)
            )
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Planning tool creation cancelled") from error
        response.headers["Location"] = f"/api/planning/tools/{result.id}"
        return result

    @router.put(
        "/{identifier}", response_model=PlanningTool, response_model_exclude_unset=True
    )
    async def update_tool(
        identifier: UUID, payload: UpdatePlanningTool, request: Request, author: Author
    ) -> PlanningTool:
        """Replace this author's tool only at the last acknowledged revision.

        Args:
            identifier: Existing opaque tool ID.
            payload: Replacement definition and expected revision.
            request: Request whose disconnect cancels validation.
            author: Server-derived owner hash.

        Returns:
            Updated tool and new revision.

        Raises:
            HTTPException: The author disconnected during validation.
            PlanningError: Ownership, revision, source validation or storage failed.
        """
        try:
            return await run_until_http_disconnect(
                request, service.update_tool(author, identifier, payload)
            )
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Planning tool update cancelled") from error

    return router


def create_planning_scenarios_router(service: PlanningScenarioService) -> APIRouter:
    """Expose tool-link reads and private, revision-checked scenario editing.

    Args:
        service: Scenario owner using the shared Planning store and parcel reader.

    Returns:
        Router reusing Planning's browser identity and bounded private responses.
    """
    router = APIRouter(
        prefix="/api/planning", tags=["planning"], route_class=PlanningRoute
    )
    Owner = Annotated[str, Depends(planning_browser_owner)]

    @router.get(
        "/tools/{identifier}/definition",
        response_model=PlanningTool,
        response_model_exclude_unset=True,
    )
    def get_definition(identifier: UUID, owner: Owner) -> PlanningTool:
        """Read a tool's current definition without granting access to its scenarios.

        Args:
            identifier: Opaque tool ID shared with the participant.
            owner: Browser identity established for subsequent private scenarios.

        Returns:
            Current definition with no author identity or participant data.

        Raises:
            PlanningError: The tool is missing or storage is unavailable.
        """
        return service.store.get_tool_definition(identifier)

    @router.get("/tools/{identifier}/scenarios", response_model=list[Scenario])
    def list_scenarios(identifier: UUID, owner: Owner) -> list[Scenario]:
        """List only this browser's scenarios for the linked tool.

        Args:
            identifier: Opaque tool ID.
            owner: Server-derived participant identity.

        Returns:
            Owned scenario metadata, excluding parcel assignments.

        Raises:
            PlanningError: The tool is missing or storage is unavailable.
        """
        return service.store.list_scenarios(owner, identifier)

    @router.post(
        "/tools/{identifier}/scenarios", response_model=Scenario, status_code=201
    )
    async def create_scenario(
        identifier: UUID, payload: CreateScenario, response: Response, owner: Owner
    ) -> Scenario:
        """Create an empty private scenario against an acknowledged tool revision.

        Args:
            identifier: Opaque tool ID.
            payload: Scenario name and expected current tool revision.
            response: Response receiving the scenario location.
            owner: Server-derived participant identity.

        Returns:
            New scenario metadata with revision one.

        Raises:
            PlanningError: The tool is missing, changed, or storage is unavailable.
        """
        result = await service.create_scenario(owner, identifier, payload)
        response.headers["Location"] = f"/api/planning/scenarios/{result.id}"
        return result

    @router.get("/scenarios/{identifier}", response_model=Scenario)
    def get_scenario(identifier: UUID, owner: Owner) -> Scenario:
        """Return scenario metadata only to the browser that created it.

        Args:
            identifier: Opaque scenario ID.
            owner: Server-derived participant identity.

        Returns:
            Owned metadata and the current tool revision.

        Raises:
            PlanningError: The scenario is unavailable to this browser or storage failed.
        """
        return service.store.get_scenario(owner, identifier)

    @router.put("/scenarios/{identifier}", response_model=Scenario)
    async def rename_scenario(
        identifier: UUID, payload: RenameScenario, owner: Owner
    ) -> Scenario:
        """Rename an owned scenario without overwriting a newer saved revision.

        Args:
            identifier: Opaque scenario ID.
            payload: Name and expected scenario/tool revisions.
            owner: Server-derived participant identity.

        Returns:
            Updated metadata and incremented scenario revision.

        Raises:
            PlanningError: Ownership, revision, or storage prevents the edit.
        """
        return await service.rename_scenario(owner, identifier, payload)

    @router.get(
        "/scenarios/{identifier}/assignments", response_model=ScenarioAssignmentPage
    )
    def read_assignments(
        identifier: UUID,
        owner: Owner,
        expectedRevision: Annotated[int, Query(ge=1)],
        offset: Annotated[int, Query(ge=0)] = 0,
        limit: Annotated[int, Query(ge=1, le=500)] = 100,
    ) -> ScenarioAssignmentPage:
        """Read a bounded assignment page from one acknowledged scenario revision.

        Args:
            identifier: Opaque scenario ID.
            owner: Server-derived participant identity.
            expectedRevision: Revision required for consistent multi-page reads.
            offset: Number of saved assignments to skip.
            limit: Maximum assignments in this response.

        Returns:
            Typed original parcel IDs and interventions, including filtered-out parcels.

        Raises:
            PlanningError: Ownership, revision, or storage prevents the read.
        """
        return service.store.read_assignments(
            owner, identifier, expectedRevision, offset, limit
        )

    @router.put("/scenarios/{identifier}/assignment", response_model=Scenario)
    async def set_assignment(
        identifier: UUID, payload: SetScenarioAssignment, request: Request, owner: Owner
    ) -> Scenario:
        """Assign, change or clear one original parcel's intervention and save it.

        Args:
            identifier: Opaque scenario ID.
            payload: Typed parcel ID, intervention or null, and both expected revisions.
            request: Request whose disconnect cancels native parcel validation.
            owner: Server-derived participant identity.

        Returns:
            Updated scenario metadata after the assignment is saved.

        Raises:
            HTTPException: The browser disconnected during source validation.
            PlanningError: Ownership, revision, source validation or storage failed.
        """
        try:
            return await run_until_http_disconnect(
                request, service.set_assignment(owner, identifier, payload)
            )
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Parcel assignment cancelled") from error

    return router
