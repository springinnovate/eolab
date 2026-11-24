"""Apply map intersection filters with independent access to every original layer."""

import asyncio
from collections.abc import Callable
from contextlib import AsyncExitStack

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from eolab_app.bounded_geometry import GeometryValidationError
from eolab_app.catalog_selection import (
    SelectionUnavailableError,
    VectorSelection,
    DrawingSelection,
    VectorFilter,
    VectorSourceOwners,
)
from eolab_jobs.models import JobError
from eolab_app.rendering.errors import PublishedLayerChangedError, PublishedLayerNotAuthorizedError
from eolab_app.routes.browser_identity import get_browser_owner_hash
from eolab_app.routes.http_disconnect import HttpClientDisconnectedError, run_until_http_disconnect
from eolab_app.routes.vector_http import PrivateVectorRoute
from eolab_app.vector.display_feature_ids import display_feature_ranges
from eolab_app.vector.sampling import VectorSamplingService
from eolab_app.vector.sources import PublishedVectorRegistry
from eolab_app.drawings.models import DrawingProperties
from eolab_app.attribute_filter import validate_filter, AttributeFilterError


class SpatialMapFilter(BaseModel):
    """Bind a published target to its source and the current filters of the chosen polygon views."""

    model_config = ConfigDict(extra="forbid")
    layerName: str = Field(min_length=1, max_length=256)
    selection: VectorSelection


class DrawnIntersection(BaseModel):
    """Find which committed target drawings touch a filtered polygon view."""

    model_config = ConfigDict(extra="forbid")
    target: DrawingSelection
    filter: VectorFilter
    properties: tuple[DrawingProperties, ...] = Field(max_length=500)


def create_spatial_filter_router(
    reader: VectorSamplingService, registry: PublishedVectorRegistry,
    processing_owner: Callable[[Request, Response], str],
) -> APIRouter:
    """Connect map filtering to authorized original-vector and drawing reads.

    Args:
        reader: Source reader independent of map publication and visibility.
        registry: Map registry for the target's existing display.
        processing_owner: HTTP authority for private run files and drawings.

    Returns:
        Private, same-origin map and drawing filter endpoints.
    """
    router = APIRouter(prefix="/api/vector-filters", route_class=PrivateVectorRoute)

    def owners(request: Request, response: Response) -> VectorSourceOwners:
        """Check both browser ownership headers and return the corresponding credentials."""
        return VectorSourceOwners(get_browser_owner_hash(request, response, mutation_header="X-EOLab-Uploads"),
                                  processing_owner(request, response))

    @router.post("/map")
    async def filter_map(body: SpatialMapFilter, request: Request, response: Response) -> dict:
        """Apply the selection to the specified original publication and return whole-layer counts."""
        credentials = owners(request, response)

        async def apply() -> dict:
            """Keep both source authorities active until all native work finishes."""
            async with reader.open_selection(body.selection, credentials) as resolved:
                base = registry.require_current(body.layerName)
                if (base.source.source_path, base.source.layer_name) != (resolved.path, resolved.selection.layerName):
                    raise HTTPException(409, "The target map layer changed. Open its filter again.")
                if resolved.matches is None:
                    raise HTTPException(422, "Choose an Intersects layer condition.")
                ranges = await asyncio.to_thread(display_feature_ranges, resolved, resolved.matches.ids)
                alias = registry.authorize_filter(base.upstream_layer_name or body.layerName, body.selection.filter,
                                                  body.selection.calculated_fields, ranges)
                return {"layerName": alias, "filter": body.selection.filter.model_dump(mode="json", by_alias=True),
                        "count": {**resolved.matches.counts, "complete": True}}
        try:
            return await run_until_http_disconnect(request, apply())
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Map filter cancelled.") from error
        except (GeometryValidationError, SelectionUnavailableError, PublishedLayerChangedError, PublishedLayerNotAuthorizedError) as error:
            raise HTTPException(409, str(error)) from error
        except JobError as error:
            raise HTTPException(error.status, str(error)) from error

    @router.post("/drawings")
    async def filter_drawings(body: DrawnIntersection, request: Request, response: Response) -> list[int]:
        """Return matching zero-based drawing positions for the applied field and spatial conditions."""
        credentials = owners(request, response)

        async def apply() -> list[int]:
            """Compare the committed target drawing against the selected original polygons."""
            async with AsyncExitStack() as stack:
                target = await stack.enter_async_context(reader.open_polygon_view(body.target, credentials))
                if len(body.properties) != len(target):
                    raise HTTPException(409, "The target drawing changed. Reapply its filter.")
                validate_filter(body.filter, {"name": "str", "note": "str"})
                boundaries = {
                    str(rule.layerId): await stack.enter_async_context(reader.open_polygon_view(rule.source, credentials))
                    for rule in body.filter.intersections
                }
                properties = tuple(feature.model_dump() for feature in body.properties)
                matches = await reader.compare_layers(target, boundaries, body.filter, properties)
                return sorted(matches.ids)
        try:
            return await run_until_http_disconnect(request, apply())
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Drawing filter cancelled.") from error
        except (GeometryValidationError, SelectionUnavailableError, AttributeFilterError) as error:
            raise HTTPException(409, str(error)) from error
        except JobError as error:
            raise HTTPException(error.status, str(error)) from error

    return router
