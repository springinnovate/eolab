"""Scan-scoped STAC Transactions HTTP adapter."""

from typing import Any, NoReturn

import httpx2


DEFAULT_CATALOG_WRITE_TIMEOUT_SECONDS = 120
DEFAULT_CATALOG_ERROR_DETAIL_LIMIT = 500


class StacApiWriter:
    """Open scan-scoped STAC Transactions sessions."""

    def __init__(
        self,
        catalog_internal_url: str,
        transport: httpx2.AsyncBaseTransport | None = None,
        *,
        write_timeout_seconds: float = DEFAULT_CATALOG_WRITE_TIMEOUT_SECONDS,
        error_detail_limit: int = DEFAULT_CATALOG_ERROR_DETAIL_LIMIT,
    ) -> None:
        """Configure the internal catalog client.

        Args:
            catalog_internal_url: Internal STAC API base URL.
            transport: Optional HTTP transport used by tests.
            write_timeout_seconds: Per-operation upstream HTTP timeout.
            error_detail_limit: Maximum upstream response characters retained
                in a raised catalog error.
        """
        self.catalog_internal_url = catalog_internal_url.rstrip("/")
        self.transport = transport
        self.write_timeout_seconds = write_timeout_seconds
        self.error_detail_limit = error_detail_limit

    def session(self) -> "StacApiWriteSession":
        """Create an unopened write session for one scan.

        Returns:
            Scan-scoped STAC Transactions session.
        """
        return StacApiWriteSession(
            self.catalog_internal_url,
            self.transport,
            self.write_timeout_seconds,
            self.error_detail_limit,
        )


class StacApiWriteSession:
    """Create or update STAC records over one shared connection pool."""

    def __init__(
        self,
        catalog_internal_url: str,
        transport: httpx2.AsyncBaseTransport | None,
        write_timeout_seconds: float,
        error_detail_limit: int,
    ) -> None:
        """Configure a scan-scoped write session.

        Args:
            catalog_internal_url: Internal STAC API base URL.
            transport: Optional HTTP transport used by tests.
            write_timeout_seconds: Per-operation upstream HTTP timeout.
            error_detail_limit: Maximum upstream response characters retained
                in a raised catalog error.
        """
        self.catalog_internal_url = catalog_internal_url
        self.transport = transport
        self.write_timeout_seconds = write_timeout_seconds
        self.error_detail_limit = error_detail_limit
        self.client: httpx2.AsyncClient | None = None

    async def __aenter__(self) -> "StacApiWriteSession":
        """Open the shared HTTP client.

        Returns:
            Open write session.
        """
        self.client = httpx2.AsyncClient(
            base_url=self.catalog_internal_url,
            transport=self.transport,
            timeout=self.write_timeout_seconds,
        )
        return self

    async def __aexit__(self, *exception_details: object) -> None:
        """Close the shared HTTP client.

        Args:
            *exception_details: Exception context supplied by the async
                context-manager protocol.
        """
        if self.client is not None:
            await self.client.aclose()

    async def upsert_collection(self, collection: dict[str, Any]) -> None:
        """Create or replace a STAC Collection.

        Args:
            collection: Complete STAC Collection document.

        Raises:
            RuntimeError: If the session is unopened or the STAC API rejects
                the operation.
            httpx2.HTTPError: If the upstream request fails.
        """
        if self.client is None:
            raise RuntimeError("Catalog write session has not been opened")

        collection_identifier = collection["id"]
        resource_path = f"/collections/{collection_identifier}"
        existing_response = await self.client.get(resource_path)
        if existing_response.status_code == 404:
            write_response = await self.client.post("/collections", json=collection)
        elif existing_response.is_success:
            write_response = await self.client.put(resource_path, json=collection)
        else:
            raise_catalog_error(existing_response, self.error_detail_limit)

        if not write_response.is_success:
            raise_catalog_error(write_response, self.error_detail_limit)

    async def upsert_items(self, items: list[dict[str, Any]]) -> None:
        """Create or replace one nonempty, single-Collection Item batch.

        Args:
            items: Nonempty batch belonging to one Collection.

        Raises:
            RuntimeError: If the session is unopened or the STAC API rejects
                the operation.
            httpx2.HTTPError: If the upstream request fails.
        """
        if self.client is None:
            raise RuntimeError("Catalog write session has not been opened")

        collection_identifier = items[0]["collection"]
        write_response = await self.client.post(
            f"/collections/{collection_identifier}/bulk_items",
            json={
                "method": "upsert",
                "items": {item["id"]: item for item in items},
            },
        )
        if not write_response.is_success:
            raise_catalog_error(write_response, self.error_detail_limit)


def raise_catalog_error(
    response: httpx2.Response,
    detail_limit: int,
) -> NoReturn:
    """Raise a bounded error for an unsuccessful STAC API response.

    Args:
        response: Unsuccessful STAC API response.
        detail_limit: Maximum upstream response characters retained.

    Raises:
        RuntimeError: Always, with bounded upstream response text.
    """
    detail = response.text[:detail_limit]
    raise RuntimeError(
        f"STAC API returned {response.status_code} for {response.request.method} "
        f"{response.request.url.path}: {detail}"
    )
