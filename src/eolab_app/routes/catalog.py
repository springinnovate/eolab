"""Application Catalog discovery routes."""

import logging
from collections.abc import Awaitable, Callable
from typing import Any

import psycopg
from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator

from eolab_app.catalog.asset_access import (
    CatalogAttachment,
    CatalogAttachmentNotFound,
    CatalogAttachmentUnavailable,
)
from eolab_app.catalog.public_metadata import copy_public_catalog_metadata
from eolab_app.raster.errors import RasterFeatureError
from eolab_app.raster.source_models import TemporalTimeChoices, TemporalTimeQuery
from eolab_app.routes.http_disconnect import (
    HttpClientDisconnectedError,
    run_until_http_disconnect,
)
from eolab_app.routes.raster_http import raster_http_exception
from eolab_app.vector_field_values import (
    CatalogVectorFieldValueQuery,
    VectorFieldValuePage,
    VectorFieldValuesUnavailable,
)

LOGGER = logging.getLogger(__name__)


RandomCatalogItemLookup = Callable[
    [dict[str, Any], tuple[str, str] | None],
    Awaitable[dict[str, Any] | None],
]


CatalogAttachmentLookup = Callable[[str, str, str], Awaitable[CatalogAttachment]]


TemporalTimeLookup = Callable[[TemporalTimeQuery], Awaitable[TemporalTimeChoices]]
VectorFieldValueLookup = Callable[
    [CatalogVectorFieldValueQuery], Awaitable[VectorFieldValuePage | None]
]


class CatalogItemIdentity(BaseModel):
    """Identify one STAC Item within its Collection."""

    model_config = ConfigDict(extra="forbid")

    collection: str = Field(min_length=1)
    id: str = Field(min_length=1)


class CatalogSurpriseRequest(BaseModel):
    """Constrain random discovery with the active Catalog search."""

    model_config = ConfigDict(extra="forbid")

    search: dict[str, Any] = Field(default_factory=dict)
    exclude: CatalogItemIdentity | None = None

    @model_validator(mode="after")
    def validate_search_contract(self) -> "CatalogSurpriseRequest":
        """Accept only the search fields produced by the current Catalog UI."""
        supported_fields = {"filter-lang", "filter", "datetime"}
        unsupported_fields = self.search.keys() - supported_fields
        if unsupported_fields:
            unsupported = ", ".join(sorted(unsupported_fields))
            raise ValueError(f"Unsupported Catalog search field: {unsupported}")
        if "filter" in self.search:
            if self.search.get("filter-lang") != "cql2-json":
                raise ValueError("Catalog filters must use cql2-json")
        elif "filter-lang" in self.search:
            raise ValueError("filter-lang requires a Catalog filter")
        return self


def create_catalog_router(
    random_item_lookup: RandomCatalogItemLookup,
    temporal_time_lookup: TemporalTimeLookup,
    vector_field_value_lookup: VectorFieldValueLookup,
    attachment_lookup: CatalogAttachmentLookup,
) -> APIRouter:
    """Create Catalog discovery endpoints without rendering dependencies.

    Args:
        random_item_lookup: Authoritative filtered random Item lookup.
        temporal_time_lookup: Authorized observation-label lookup from source metadata.
        vector_field_value_lookup: Paged string lookup from private admission metadata.
        attachment_lookup: Resolve a stored Asset identity to its confined original file.

    Returns:
        Router for discovery, temporal choices, prepared values and file downloads.
    """
    router = APIRouter(prefix="/api/catalog", tags=["catalog"])

    @router.get("/asset", response_class=FileResponse)
    async def download_catalog_asset(
        request: Request,
        collection: str = Query(min_length=1),
        item: str = Query(min_length=1),
        asset: str = Query(min_length=1),
    ) -> FileResponse:
        """Download one cataloged local file using only its stored Asset identity.

        Args:
            request: Incoming request used to cancel a disconnected lookup.
            collection: Owning STAC Collection ID.
            item: Owning Item ID within the Collection.
            asset: Named Asset key within the Item.

        Returns:
            Original file as an attachment; supplied HTML or scripts are never
            served as active application content.

        Raises:
            HTTPException: If the identity has no local download, the file is
                unavailable, the Catalog cannot be read, or the client leaves.
        """
        try:
            attachment = await run_until_http_disconnect(
                request, attachment_lookup(collection, item, asset)
            )
        except CatalogAttachmentNotFound as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except CatalogAttachmentUnavailable as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except psycopg.Error as error:
            raise HTTPException(
                status_code=503, detail="The Catalog is unavailable. Try again shortly."
            ) from error
        except HttpClientDisconnectedError as error:
            raise HTTPException(
                status_code=499, detail="Download request cancelled."
            ) from error
        return FileResponse(
            attachment.path,
            media_type="application/octet-stream",
            filename=attachment.path.name,
            content_disposition_type="attachment",
            headers={
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @router.post("/vector-field-values", response_model=VectorFieldValuePage)
    async def vector_field_values(
        body: CatalogVectorFieldValueQuery, response: Response
    ) -> VectorFieldValuePage:
        """Return prepared string suggestions using only a Catalog Item identity.

        Args:
            body: Catalog identity, string field, substring and bounded page.
            response: Response receiving no-store headers for explicit refresh.

        Returns:
            Exact strings and a continuation offset, without source paths.

        Raises:
            HTTPException: If the Item or inventory is missing, or storage fails.
        """
        response.headers["Cache-Control"] = "no-store"
        try:
            page = await vector_field_value_lookup(body)
        except VectorFieldValuesUnavailable as error:
            raise HTTPException(
                409, str(error), headers={"Cache-Control": "no-store"}
            ) from error
        except psycopg.Error as error:
            LOGGER.exception("Catalog field value lookup failed")
            raise HTTPException(503, "Catalog field values are unavailable.") from error
        if page is None:
            raise HTTPException(404, "Catalog Item not found")
        return page

    @router.post("/surprise")
    async def surprise_me(request: CatalogSurpriseRequest) -> dict[str, Any]:
        """Return a matching random Item without private source locations.

        Args:
            request: Active Catalog filters and an optional Item to exclude.

        Returns:
            Public Item metadata under the literal key ``"item"``.

        Raises:
            HTTPException: If the filters are invalid, no Item matches, or the
                database is unavailable.
        """
        excluded_item = None
        if request.exclude is not None:
            excluded_item = (
                request.exclude.collection,
                request.exclude.id,
            )
        try:
            item = await random_item_lookup(request.search, excluded_item)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except (psycopg.Error, RuntimeError) as error:
            LOGGER.exception("Random Catalog discovery failed")
            raise HTTPException(
                status_code=503,
                detail="Random Catalog discovery is unavailable",
            ) from error
        if item is None:
            raise HTTPException(
                status_code=404,
                detail="No Catalog Items match the active filters",
            )
        return {"item": copy_public_catalog_metadata(item)}

    @router.post("/temporal-times", response_model=TemporalTimeChoices)
    async def get_temporal_times(
        body: TemporalTimeQuery, request: Request, response: Response
    ) -> TemporalTimeChoices:
        """Return available months and actual UTC labels for one variable.

        Args:
            body: Catalog variable and optional requested month.
            request: HTTP cancellation context.
            response: Response receiving no-store headers for explicit refresh.

        Returns:
            Exact choices without synthesizing missing observations.

        Raises:
            HTTPException: If Catalog or source access fails, or the client disconnects.
        """
        response.headers["Cache-Control"] = "no-store"
        try:
            return await run_until_http_disconnect(request, temporal_time_lookup(body))
        except RasterFeatureError as error:
            failure = raster_http_exception(error)
            failure.headers = {**(failure.headers or {}), "Cache-Control": "no-store"}
            raise failure from error
        except HttpClientDisconnectedError as error:
            raise HTTPException(
                499,
                "The observation time request was canceled",
                headers={"Cache-Control": "no-store"},
            ) from error

    return router
