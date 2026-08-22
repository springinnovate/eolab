"""Application Catalog discovery routes."""

import logging
from collections.abc import Awaitable, Callable
from typing import Any

import psycopg
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator


LOGGER = logging.getLogger(__name__)


RandomCatalogItemLookup = Callable[
    [dict[str, Any], tuple[str, str] | None],
    Awaitable[dict[str, Any] | None],
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
) -> APIRouter:
    """Create the filtered random-discovery endpoint."""
    router = APIRouter(prefix="/api/catalog", tags=["catalog"])

    @router.post("/surprise")
    async def surprise_me(request: CatalogSurpriseRequest) -> dict[str, Any]:
        """Return one random Item matching the active Catalog filters."""
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
        return {"item": item}

    return router
