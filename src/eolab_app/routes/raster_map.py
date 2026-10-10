"""Owner-authorized HTTP delivery for raster viewport display grids."""

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response

from eolab_app.raster.errors import RasterFeatureError
from eolab_app.rendering.raster_window import RasterMapWindowRequest, RasterMapWindows
from eolab_app.raster.source_models import RunArtifactReference
from eolab_app.routes.http_disconnect import (
    HttpClientDisconnectedError,
    run_until_http_disconnect,
)
from eolab_app.routes.raster_http import raster_http_exception
from eolab_app.source_files import SourceFileError


def create_raster_map_router(
    windows: RasterMapWindows, session_owner: Callable[[Request, Response], str]
) -> APIRouter:
    """Connect bounded map rendering to the composed source and session authorities.

    Args:
        windows: Raster rendering adapter using original-source access.
        session_owner: Application-injected same-origin session authority.

    Returns:
        Rendering routes with no dependency on analysis or Processing implementations.
    """
    router = APIRouter(prefix="/api/rendering", tags=["rendering"])

    @router.post("/raster-window")
    async def read_map_window(
        body: RasterMapWindowRequest, request: Request, response: Response
    ) -> dict[str, Any]:
        """Read only a bounded display grid and keep all responses out of shared caches.

        Args:
            body: Source reference, viewport bounds and output dimensions.
            request: Session and client-disconnection context.
            response: Response receiving session and cache headers.

        Returns:
            Versioned original-source samples for map coloring only.

        Raises:
            HTTPException: On authorization, capacity, reading or disconnect failure.
        """
        headers = {"Cache-Control": "private, no-store"}
        response.headers.update(headers)
        try:
            owner = (
                session_owner(request, response)
                if isinstance(body.source, RunArtifactReference)
                else None
            )
            return await run_until_http_disconnect(request, windows.read(body, owner))
        except SourceFileError as error:
            raise HTTPException(error.status, str(error), headers=headers) from error
        except RasterFeatureError as error:
            failure = raster_http_exception(error)
            failure.headers = {**(failure.headers or {}), **headers}
            raise failure from error
        except HttpClientDisconnectedError as error:
            raise HTTPException(
                499, "The raster display request was canceled.", headers=headers
            ) from error

    return router
