"""External contracts used by the catalog scan coordinator."""

from collections.abc import AsyncIterator, Iterable
from contextlib import AbstractAsyncContextManager
from typing import Any, Protocol

from eolab_app.catalog.models import (
    CatalogItemSource,
    DatasetCandidate,
    DatasetMetadataResult,
    ReconciliationStatus,
    ScanError,
)


class DatasetDiscovery(Protocol):
    """Discover supported datasets within the configured source mount."""

    def discover(self) -> tuple[list[DatasetCandidate], list[ScanError]]:
        """Return deterministic candidates and tolerated walk errors.

        Returns:
            Discovered datasets and directory traversal failures.
        """


class DatasetMetadataReader(Protocol):
    """Stream bounded metadata extraction results."""

    def results(
        self,
        dataset_candidates: list[DatasetCandidate],
    ) -> AsyncIterator[DatasetMetadataResult]:
        """Extract one result for every candidate.

        Args:
            dataset_candidates: Datasets awaiting metadata extraction.

        Yields:
            Per-source zero-or-more Item successes and captured failures.
        """


class CatalogReconciler(Protocol):
    """Verify and remove missing scanner-owned Items."""

    async def reconcile(self, status: ReconciliationStatus) -> int:
        """Run reconciliation while updating typed progress.

        Args:
            status: Mutable reconciliation status for the active scan.

        Returns:
            Number of Items removed, or zero after a captured failure.
        """


class CatalogWriteSession(Protocol):
    """Catalog operations required by one scan."""

    async def upsert_collection(self, collection: dict[str, Any]) -> None:
        """Create or replace a STAC Collection.

        Args:
            collection: Complete STAC Collection document.
        """

    async def upsert_items(self, items: list[dict[str, Any]]) -> None:
        """Create or replace a batch of STAC Items.

        Args:
            items: Nonempty batch belonging to one Collection.
        """


class CatalogWriter(Protocol):
    """Factory for a scan-scoped catalog write session."""

    def session(self) -> AbstractAsyncContextManager[CatalogWriteSession]:
        """Open one catalog write session.

        Returns:
            Async context manager for a shared write session.
        """


class CatalogDatabase(Protocol):
    """Direct catalog operations needed outside STAC Transactions."""

    async def existing_item_keys(
        self,
        collection_identifiers: tuple[str, ...],
    ) -> set[tuple[str, str]]:
        """Return Collection and Item identifiers already stored.

        Args:
            collection_identifiers: Collections included in the inventory.

        Returns:
            Existing Collection and Item identifier pairs.
        """

    def scanner_item_pages(
        self,
        collection_identifiers: tuple[str, ...],
        page_size: int,
    ) -> AsyncIterator[list[CatalogItemSource]]:
        """Stream bounded pages of scanner-owned source Assets.

        Args:
            collection_identifiers: Scanner-owned Collections to inspect.
            page_size: Maximum number of Items in each page.

        Yields:
            Pages ordered by Collection and Item identifier.
        """

    async def delete_item_batches(
        self,
        item_batches: Iterable[list[tuple[str, str]]],
    ) -> int:
        """Atomically delete bounded batches of Collection and Item IDs.

        Args:
            item_batches: Batches of Collection and Item identifier pairs.

        Returns:
            Number of Items removed.
        """

    async def invalidate_search_count_cache(self) -> None:
        """Discard cached Item Search counts after a scan."""
