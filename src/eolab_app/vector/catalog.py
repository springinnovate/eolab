"""Concrete STAC catalog adapter for vector visualization workflows."""

from typing import Any

import httpx2

from eolab_app.vector.errors import VectorNotFoundError, VectorUpstreamError
from eolab_app.vector.models import CatalogVectorRequest


class StacVectorCatalog:
    """Translate internal STAC responses into vector application results."""

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
        request: CatalogVectorRequest,
    ) -> dict[str, Any]:
        """Load and validate one authoritative scanner-owned vector Item.

        Args:
            request: Validated Collection and Item identity.

        Returns:
            STAC Item matching the requested identity.

        Raises:
            VectorNotFoundError: If the Item does not exist.
            VectorUpstreamError: If the catalog is unavailable or invalid.
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
            raise VectorUpstreamError(
                "The STAC catalog service is unavailable"
            ) from error
        if response.status_code == 404:
            raise VectorNotFoundError("Catalog Item not found")
        if response.status_code != 200:
            raise VectorUpstreamError(
                "The STAC catalog returned an unexpected response"
            )
        try:
            item = response.json()
        except ValueError as error:
            raise VectorUpstreamError(
                "The STAC catalog returned an invalid Item"
            ) from error
        if (
            not isinstance(item, dict)
            or item.get("id") != request.item_id
            or item.get("collection") != request.collection_id
        ):
            raise VectorUpstreamError(
                "The STAC catalog returned an invalid Item"
            )
        return item

    async def upsert_item(
        self,
        request: CatalogVectorRequest,
        item: dict[str, Any],
    ) -> None:
        """Persist one assessed vector Item through the bulk upsert API.

        Args:
            request: Validated Collection and Item identity.
            item: Complete replacement STAC Item.

        Raises:
            VectorUpstreamError: If the catalog is unavailable or rejects the
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
            raise VectorUpstreamError(
                "The STAC catalog service is unavailable"
            ) from error
        if not response.is_success:
            raise VectorUpstreamError(
                "The STAC catalog could not save the vector assessment"
            )
