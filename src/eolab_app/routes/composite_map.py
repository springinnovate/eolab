"""HTTP delivery for authorized GeoServer-composed map tiles."""

import asyncio
import math
import re
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import httpx2
from fastapi import APIRouter, HTTPException, Request, Response

from eolab_app.diagnostics.tracker import GetMapRequestTracker
from eolab_app.rendering.composite import (
    CompositeMapPlanUnavailableError,
    CompositeMapRenderingService,
)
from eolab_app.rendering.errors import (
    PublishedLayerChangedError,
    PublishedLayerNotAuthorizedError,
    PublishedLayerRequestError,
)
from eolab_app.rendering.models import (
    CompositeMapPlanRequest,
    PublishedCompositeMapPlan,
)
from eolab_app.rendering.sld import build_get_map_document
from eolab_app.routes.geoserver_map import (
    forward_geoserver_get_map,
    geoserver_forward_headers,
)


_PLAN_ID_PATTERN = re.compile(r"[0-9a-f]{64}")
DEFAULT_COMPOSITE_TILE_CACHE_BYTES = 128 * 1024 * 1024
_COMPOSITE_TILE_PARAMETERS = frozenset({
    "bbox",
    "format",
    "height",
    "layers",
    "request",
    "service",
    "srs",
    "styles",
    "tiled",
    "tilesorigin",
    "transparent",
    "version",
    "width",
})


@dataclass(frozen=True)
class _CompositeTileKey:
    """Identify one normalized tile within a content-addressed plan."""

    plan_id: str
    bbox: tuple[float, float, float, float]
    width: int
    height: int
    spatial_reference: str


@dataclass(frozen=True)
class _CompositeTileRepresentation:
    """Retain an immutable GeoServer response independently of its connection."""

    status_code: int
    content: bytes
    headers: tuple[tuple[str, str], ...]
    cacheable: bool

    @classmethod
    def from_response(
        cls,
        response: httpx2.Response,
    ) -> "_CompositeTileRepresentation":
        """Copy one completed GeoServer response into an immutable value.

        Args:
            response: Completed internal GeoServer response.

        Returns:
            Independent response representation with a conservative cache flag.
        """
        content_type = response.headers.get("content-type", "").partition(";")[0]
        cacheable = (
            response.status_code == 200
            and content_type.lower() == "image/png"
        )
        return cls(
            status_code=response.status_code,
            content=bytes(response.content),
            headers=tuple(response.headers.multi_items()),
            cacheable=cacheable,
        )

    @property
    def size_bytes(self) -> int:
        """Return the bounded cache charge for content and header bytes.

        Returns:
            Encoded response bytes charged to the cache budget.
        """
        return 4 + len(self.content) + sum(
            len(name.encode("utf-8")) + len(value.encode("utf-8")) + 2
            for name, value in self.headers
        )

    def as_response(self) -> httpx2.Response:
        """Build an independent HTTP response for one waiting request.

        Returns:
            Completed GeoServer-compatible response value.
        """
        return httpx2.Response(
            self.status_code,
            content=self.content,
            headers=self.headers,
        )


@dataclass
class _InflightCompositeTile:
    """Track one shared render and the requests that still need it."""

    task: asyncio.Task[_CompositeTileRepresentation]
    waiter_count: int = 0


class _CompositeTileCache:
    """Coalesce and retain successful composite tiles within a byte bound."""

    def __init__(self, maximum_bytes: int) -> None:
        """Create an empty process-local least-recently-used cache.

        Args:
            maximum_bytes: Maximum combined response and header bytes retained.

        Raises:
            ValueError: If the cache byte bound is not positive.
        """
        if maximum_bytes < 1:
            raise ValueError("Composite tile cache bytes must be positive")
        self._maximum_bytes = maximum_bytes
        self._current_bytes = 0
        self._cache: OrderedDict[
            _CompositeTileKey,
            _CompositeTileRepresentation,
        ] = OrderedDict()
        self._inflight: dict[_CompositeTileKey, _InflightCompositeTile] = {}
        self._state_lock = asyncio.Lock()

    async def get(
        self,
        key: _CompositeTileKey,
        loader: Callable[[], Awaitable[httpx2.Response]],
    ) -> httpx2.Response:
        """Return a cached tile or share one new GeoServer render.

        Args:
            key: Content-addressed plan and normalized tile coordinates.
            loader: Deferred GeoServer request for one cache miss.

        Returns:
            Independent completed response for the requesting client.
        """
        async with self._state_lock:
            cached = self._cache.get(key)
            if cached is not None:
                self._cache.move_to_end(key)
                work = None
            else:
                work = self._inflight.get(key)
                if work is None:
                    task = asyncio.create_task(self._load(key, loader))
                    task.add_done_callback(self._retrieve_task_exception)
                    work = _InflightCompositeTile(task)
                    self._inflight[key] = work
                work.waiter_count += 1
        if cached is not None:
            return cached.as_response()
        if work is None:
            raise RuntimeError("Composite tile work was not established")
        try:
            representation = await asyncio.shield(work.task)
            return representation.as_response()
        finally:
            await self._release_waiter(key, work)

    async def _load(
        self,
        key: _CompositeTileKey,
        loader: Callable[[], Awaitable[httpx2.Response]],
    ) -> _CompositeTileRepresentation:
        """Load and conditionally retain one still-owned tile representation.

        Args:
            key: Content-addressed plan and normalized tile coordinates.
            loader: Deferred GeoServer request for one cache miss.

        Returns:
            Immutable successful or failed GeoServer response.
        """
        current_task = asyncio.current_task()
        try:
            representation = _CompositeTileRepresentation.from_response(
                await loader()
            )
            async with self._state_lock:
                work = self._inflight.get(key)
                if (
                    work is not None
                    and work.task is current_task
                    and representation.cacheable
                ):
                    self._remember(key, representation)
            return representation
        finally:
            async with self._state_lock:
                work = self._inflight.get(key)
                if work is not None and work.task is current_task:
                    self._inflight.pop(key)

    async def _release_waiter(
        self,
        key: _CompositeTileKey,
        work: _InflightCompositeTile,
    ) -> None:
        """Release one waiter and abandon a render that nobody still needs.

        Args:
            key: Content-addressed plan and normalized tile coordinates.
            work: Shared render awaited by the releasing request.

        Returns:
            None after updating shared ownership.
        """
        async with self._state_lock:
            work.waiter_count -= 1
            if work.waiter_count == 0 and not work.task.done():
                if self._inflight.get(key) is work:
                    self._inflight.pop(key)
                work.task.cancel()

    def _remember(
        self,
        key: _CompositeTileKey,
        representation: _CompositeTileRepresentation,
    ) -> None:
        """Retain one successful tile and evict older bytes to the configured bound.

        Args:
            key: Content-addressed plan and normalized tile coordinates.
            representation: Successful immutable PNG response.

        Returns:
            None after deterministic least-recently-used eviction.
        """
        size_bytes = representation.size_bytes
        if size_bytes > self._maximum_bytes:
            return
        previous = self._cache.pop(key, None)
        if previous is not None:
            self._current_bytes -= previous.size_bytes
        self._cache[key] = representation
        self._current_bytes += size_bytes
        while self._current_bytes > self._maximum_bytes:
            _, evicted = self._cache.popitem(last=False)
            self._current_bytes -= evicted.size_bytes

    @staticmethod
    def _retrieve_task_exception(
        task: asyncio.Task[_CompositeTileRepresentation],
    ) -> None:
        """Consume an abandoned task outcome to avoid an event-loop warning.

        Args:
            task: Finished shared render task.

        Returns:
            None after retrieving any outcome.
        """
        try:
            task.exception()
        except asyncio.CancelledError:
            pass


def validated_composite_tile_query(
    request: Request,
) -> tuple[tuple[float, float, float, float], int, int, str]:
    """Validate the exact Leaflet WMS tile contract for a composite plan.

    Args:
        request: Incoming same-origin tile request.

    Returns:
        Finite projected bounding box, pixel width, pixel height, and SRS.

    Raises:
        HTTPException: If the request is not one bounded transparent PNG tile.
    """
    entries = list(request.query_params.multi_items())
    query = {key.lower(): value for key, value in entries}
    if len(query) != len(entries):
        raise HTTPException(
            status_code=400,
            detail="Tile parameters must not repeat",
        )
    unsupported = query.keys() - _COMPOSITE_TILE_PARAMETERS
    if unsupported:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported tile parameter: {sorted(unsupported)[0]}",
        )
    required = {
        "service": "wms",
        "version": "1.1.1",
        "request": "getmap",
        "layers": "composite",
        "format": "image/png",
        "transparent": "true",
        "srs": "epsg:3857",
    }
    for name, expected in required.items():
        if query.get(name, "").lower() != expected:
            raise HTTPException(
                status_code=400,
                detail=f"{name} must be {expected}",
            )
    if query.get("styles", "") != "":
        raise HTTPException(status_code=400, detail="styles must be empty")
    try:
        width = int(query["width"])
        height = int(query["height"])
    except (KeyError, ValueError) as error:
        raise HTTPException(
            status_code=400,
            detail="width and height must be integers",
        ) from error
    if not 1 <= width <= 512 or not 1 <= height <= 512:
        raise HTTPException(
            status_code=400,
            detail="width and height must be between 1 and 512",
        )
    try:
        bbox = tuple(float(value) for value in query["bbox"].split(","))
    except (KeyError, ValueError) as error:
        raise HTTPException(
            status_code=400,
            detail="bbox must contain four finite numbers",
        ) from error
    if (
        len(bbox) != 4
        or not all(math.isfinite(value) for value in bbox)
        or bbox[0] >= bbox[2]
        or bbox[1] >= bbox[3]
    ):
        raise HTTPException(
            status_code=400,
            detail="bbox must contain an increasing finite extent",
        )
    return (bbox[0], bbox[1], bbox[2], bbox[3]), width, height, "EPSG:3857"


def create_composite_map_router(
    rendering_service: CompositeMapRenderingService,
    geoserver_client: httpx2.AsyncClient,
    geoserver_internal_url: str,
    get_map_request_tracker: GetMapRequestTracker,
    maximum_tile_cache_bytes: int = DEFAULT_COMPOSITE_TILE_CACHE_BYTES,
) -> APIRouter:
    """Create the plan-registration and composite tile delivery boundary.

    Args:
        rendering_service: Neutral authorization and plan lifecycle service.
        geoserver_client: Shared unauthenticated GeoServer WMS client.
        geoserver_internal_url: Internal GeoServer base URL.
        get_map_request_tracker: Bounded GetMap request observer.
        maximum_tile_cache_bytes: Maximum process-local composite response bytes.

    Returns:
        Router serving safe render plans and their GeoServer-composed PNGs.
    """
    router = APIRouter(prefix="/api/map-rendering", tags=["rendering"])
    internal_wms_url = f"{geoserver_internal_url.rstrip('/')}/eolab/wms"
    tile_cache = _CompositeTileCache(maximum_tile_cache_bytes)

    @router.post("/plans", response_model=PublishedCompositeMapPlan)
    async def create_plan(
        plan: CompositeMapPlanRequest,
    ) -> PublishedCompositeMapPlan:
        """Authorize and retain one complete visible map presentation.

        Args:
            plan: Bounded top-first published layers and appearances.

        Returns:
            Content-addressed identity and browser WMS URL.

        Raises:
            HTTPException: If any layer, source, or style is not current.
        """
        try:
            return await rendering_service.create_plan(plan)
        except PublishedLayerChangedError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except (
            PublishedLayerNotAuthorizedError,
            PublishedLayerRequestError,
            ValueError,
        ) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @router.get("/plans/{plan_id}/wms", include_in_schema=False)
    async def render_plan(plan_id: str, request: Request) -> Response:
        """Render one authorized plan as a transparent GeoServer tile.

        Args:
            plan_id: Content-addressed current-process plan identity.
            request: Incoming bounded Leaflet WMS tile request.

        Returns:
            GeoServer-composed PNG response and safe cache headers.

        Raises:
            HTTPException: If the plan, tile request, source, style, or
                rendering service is unavailable.
        """
        if _PLAN_ID_PATTERN.fullmatch(plan_id) is None:
            raise HTTPException(
                status_code=404,
                detail="Composite map plan not found",
            )
        bbox, width, height, spatial_reference = validated_composite_tile_query(
            request
        )
        try:
            plan = await rendering_service.require_current(plan_id)
        except CompositeMapPlanUnavailableError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except PublishedLayerChangedError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except (
            PublishedLayerNotAuthorizedError,
            PublishedLayerRequestError,
        ) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        tile_key = _CompositeTileKey(
            plan_id,
            bbox,
            width,
            height,
            spatial_reference,
        )

        async def load_tile() -> httpx2.Response:
            """Render this cache miss through the existing GeoServer boundary.

            Returns:
                Completed internal GeoServer response.
            """
            get_map_document = build_get_map_document(
                plan.sld_document,
                bbox,
                width,
                height,
                spatial_reference,
            )
            return await geoserver_client.post(
                internal_wms_url,
                content=get_map_document,
                headers=geoserver_forward_headers(
                    request,
                    content_type="application/xml",
                ),
            )

        return await forward_geoserver_get_map(
            request,
            tile_cache.get(tile_key, load_tile),
            get_map_request_tracker,
        )

    return router
