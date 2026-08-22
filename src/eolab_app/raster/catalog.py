"""Concrete STAC catalog adapter for raster application services."""

from typing import Any

import httpx2

from eolab_app.raster.errors import (
    RasterNotFoundError,
    RasterUpstreamError,
)
from eolab_app.raster.models import CatalogRasterRequest


class StacRasterCatalog:
    """Translate internal STAC responses into raster application results."""

    def __init__(
        self,
        catalog_client: httpx2.AsyncClient,
        catalog_internal_url: str,
    ) -> None:
        """Create an adapter over a shared internal STAC client.

        Args:
            catalog_client: Shared client for the internal STAC API.
            catalog_internal_url: Internal STAC API base URL.
        """
        self._catalog_client = catalog_client
        self._catalog_internal_url = catalog_internal_url.rstrip("/")

    async def get_item(
        self,
        request: CatalogRasterRequest,
    ) -> dict[str, Any]:
        """Load and validate the authoritative scanner-owned STAC Item.

        Args:
            request: Validated Collection and Item identity.

        Returns:
            STAC Item matching the requested identity.

        Raises:
            RasterNotFoundError: If the Item does not exist.
            RasterUpstreamError: If the catalog is unavailable or invalid.
        """
        item_url = (
            f"{self._catalog_internal_url}/collections/"
            f"{request.collection_id}/items/{request.item_id}"
        )
        try:
            response = await self._catalog_client.get(
                item_url,
                headers={"Accept": "application/geo+json"},
            )
        except httpx2.RequestError as error:
            raise RasterUpstreamError(
                "The STAC catalog service is unavailable"
            ) from error
        if response.status_code == 404:
            raise RasterNotFoundError("Catalog Item not found")
        if response.status_code != 200:
            raise RasterUpstreamError(
                "The STAC catalog returned an unexpected response"
            )

        try:
            item = response.json()
        except ValueError as error:
            raise RasterUpstreamError(
                "The STAC catalog returned an invalid Item"
            ) from error
        if (
            not isinstance(item, dict)
            or item.get("id") != request.item_id
            or item.get("collection") != request.collection_id
        ):
            raise RasterUpstreamError(
                "The STAC catalog returned an invalid Item"
            )
        return item

    async def upsert_item(
        self,
        request: CatalogRasterRequest,
        item: dict[str, Any],
    ) -> None:
        """Persist one assessed STAC Item through the bulk upsert API.

        Args:
            request: Validated Collection and Item identity.
            item: Complete replacement STAC Item.

        Raises:
            RasterUpstreamError: If the catalog is unavailable or rejects the
                update.
        """
        try:
            response = await self._catalog_client.post(
                f"{self._catalog_internal_url}/collections/"
                f"{request.collection_id}/bulk_items",
                json={
                    "method": "upsert",
                    "items": {request.item_id: item},
                },
            )
        except httpx2.RequestError as error:
            raise RasterUpstreamError(
                "The STAC catalog service is unavailable"
            ) from error
        if not response.is_success:
            raise RasterUpstreamError(
                "The STAC catalog could not save the raster assessment"
            )
