"""Shared in-memory collaborators for catalog scanning tests."""

from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager
from typing import Any

from eolab_app.catalog.models import CatalogItemSource
from eolab_app.catalog.pgstac import catalog_item_source


class RecordingCatalogSession:
    """Record Collection and Item writes in memory."""

    def __init__(self, item_error: Exception | None = None) -> None:
        """Configure an optional bulk-write failure.

        Args:
            item_error: Exception raised by each Item write when supplied.
        """
        self.collections: dict[str, dict[str, Any]] = {}
        self.items: dict[tuple[str, str], dict[str, Any]] = {}
        self.item_batches: list[list[dict[str, Any]]] = []
        self.item_error = item_error

    async def __aenter__(self) -> "RecordingCatalogSession":
        """Return the open in-memory session.

        Returns:
            This recording session.
        """
        return self

    async def __aexit__(self, *exception_details: object) -> None:
        """Accept asynchronous context-manager teardown.

        Args:
            *exception_details: Exception context supplied by the protocol.
        """

    async def upsert_collection(self, collection: dict[str, Any]) -> None:
        """Record one Collection by identifier.

        Args:
            collection: Complete STAC Collection document.
        """
        self.collections[collection["id"]] = collection

    async def upsert_items(self, items: list[dict[str, Any]]) -> None:
        """Record a batch or raise the configured failure.

        Args:
            items: STAC Item batch.

        Raises:
            Exception: The configured test failure, when present.
        """
        self.item_batches.append(items)
        if self.item_error is not None:
            raise self.item_error
        self.items.update(
            ((item["collection"], item["id"]), item) for item in items
        )


class RecordingCatalogWriter:
    """Return the same in-memory write session for every scan."""

    def __init__(self, item_error: Exception | None = None) -> None:
        """Configure an optional Item-write failure.

        Args:
            item_error: Exception raised by Item writes when supplied.
        """
        self.write_session = RecordingCatalogSession(item_error)

    def session(self) -> AbstractAsyncContextManager[RecordingCatalogSession]:
        """Return the reusable recording session.

        Returns:
            Async context manager implementing catalog writes.
        """
        return self.write_session


class RecordingCatalogDatabase:
    """Record direct catalog operations requested by a scanner."""

    def __init__(self, catalog_writer: RecordingCatalogWriter) -> None:
        """Use written Items as the in-memory database inventory.

        Args:
            catalog_writer: Writer whose session owns the Item mapping.
        """
        self.catalog_writer = catalog_writer
        self.search_count_cache_invalidations = 0
        self.deleted_batches: list[list[tuple[str, str]]] = []
        self.requested_page_sizes: list[int] = []

    async def existing_item_keys(
        self,
        collection_identifiers: tuple[str, ...],
    ) -> set[tuple[str, str]]:
        """Return written Items in requested Collections.

        Args:
            collection_identifiers: Collections included in the inventory.

        Returns:
            Matching Collection and Item identifiers.
        """
        return {
            key
            for key in self.catalog_writer.write_session.items
            if key[0] in collection_identifiers
        }

    async def scanner_item_pages(
        self,
        collection_identifiers: tuple[str, ...],
        page_size: int,
    ) -> AsyncIterator[list[CatalogItemSource]]:
        """Yield stable bounded pages from the in-memory inventory.

        Args:
            collection_identifiers: Collections included in reconciliation.
            page_size: Maximum Items per page.

        Yields:
            Scanner-owned source Asset pages.
        """
        self.requested_page_sizes.append(page_size)
        scanner_items = [
            catalog_item_source(collection, item_id, item["assets"])
            for (collection, item_id), item in sorted(
                self.catalog_writer.write_session.items.items()
            )
            if collection in collection_identifiers and item.get("assets")
        ]
        for page_start in range(0, len(scanner_items), page_size):
            yield scanner_items[page_start : page_start + page_size]

    async def delete_item_batches(
        self,
        item_batches,
    ) -> int:
        """Remove all supplied keys from the in-memory inventory.

        Args:
            item_batches: Iterable of bounded key batches.

        Returns:
            Number of existing Items removed.
        """
        batches = list(item_batches)
        self.deleted_batches.extend(batches)
        removed = 0
        for item_batch in batches:
            for item_key in item_batch:
                if self.catalog_writer.write_session.items.pop(item_key, None):
                    removed += 1
        return removed

    async def invalidate_search_count_cache(self) -> None:
        """Record one count-cache invalidation."""
        self.search_count_cache_invalidations += 1
