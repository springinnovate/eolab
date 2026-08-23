"""Bounded verification and deletion of missing scanner-owned Items."""

import asyncio
import json
import tempfile
from collections.abc import Iterable
from itertools import batched
from pathlib import Path
from urllib.parse import unquote, urlsplit

from eolab_app.catalog.collections import SCAN_COLLECTION_IDENTIFIERS
from eolab_app.catalog.models import CatalogItemSource, ReconciliationStatus
from eolab_app.catalog.ports import CatalogDatabase
from eolab_app.catalog.remote import RemoteAssetAvailability


DEFAULT_RECONCILIATION_PAGE_SIZE = 500
DEFAULT_RECONCILIATION_CONCURRENCY = 8
DEFAULT_RECONCILIATION_SPOOL_MEMORY_BYTES = 1024 * 1024


class MissingItemReconciler:
    """Verify mounted and remote candidates before deleting any Item."""

    def __init__(
        self,
        source_root: Path,
        catalog_database: CatalogDatabase,
        item_batch_size: int,
        *,
        page_size: int = DEFAULT_RECONCILIATION_PAGE_SIZE,
        concurrency: int = DEFAULT_RECONCILIATION_CONCURRENCY,
        spool_memory_bytes: int = DEFAULT_RECONCILIATION_SPOOL_MEMORY_BYTES,
        remote_asset_availability: RemoteAssetAvailability | None = None,
    ) -> None:
        """Configure missing-Item reconciliation.

        Args:
            source_root: Root of the mounted scan source.
            catalog_database: Catalog inventory and transactional deletion port.
            item_batch_size: Maximum keys in each database delete batch.
            page_size: Maximum catalog Items loaded for each inventory page.
            concurrency: Maximum simultaneous source Asset checks.
            spool_memory_bytes: Missing-key bytes retained in memory before
                spilling to a temporary file.
            remote_asset_availability: Optional provider adapter for unsigned
                remote Asset locations.

        """
        self.source_root = source_root
        self.catalog_database = catalog_database
        self.item_batch_size = item_batch_size
        self.page_size = page_size
        self.concurrency = concurrency
        self.spool_memory_bytes = spool_memory_bytes
        self.remote_asset_availability = remote_asset_availability

    async def reconcile(self, status: ReconciliationStatus) -> int:
        """Verify source Assets and delete only proven stale Items.

        Args:
            status: Mutable reconciliation progress owned by the active scan.

        Returns:
            Number of catalog Items removed. Any verification or deletion
            failure is captured in ``status`` and returns zero.
        """
        status.state = "checking"
        try:
            mount_signature = await asyncio.to_thread(
                source_signature,
                self.source_root,
            )
            with tempfile.SpooledTemporaryFile(
                max_size=self.spool_memory_bytes,
                mode="w+t",
                encoding="utf-8",
            ) as missing_items:
                async for item_page in self.catalog_database.scanner_item_pages(
                    SCAN_COLLECTION_IDENTIFIERS,
                    self.page_size,
                ):
                    for item_group in batched(
                        item_page,
                        self.concurrency,
                    ):
                        availability = await asyncio.gather(*(
                            asyncio.to_thread(
                                catalog_item_is_missing,
                                item,
                                self.source_root,
                                self.remote_asset_availability,
                            )
                            for item in item_group
                        ))
                        for item, is_missing in zip(
                            item_group,
                            availability,
                            strict=True,
                        ):
                            status.checked += 1
                            if is_missing:
                                status.missing += 1
                                missing_items.write(json.dumps([
                                    item.collection,
                                    item.item_id,
                                ]))
                                missing_items.write("\n")

                if await asyncio.to_thread(
                    source_signature,
                    self.source_root,
                ) != mount_signature:
                    raise OSError(
                        "The mounted scan source changed during reconciliation"
                    )

                status.state = "deleting"
                missing_items.seek(0)
                status.removed = await self.catalog_database.delete_item_batches(
                    missing_item_batches(missing_items, self.item_batch_size)
                )
            status.state = "completed"
        except Exception as error:
            status.state = "failed"
            status.error = str(error)
        return status.removed


def catalog_item_is_missing(
    item: CatalogItemSource,
    source_root: Path,
    remote_asset_availability: RemoteAssetAvailability | None = None,
) -> bool:
    """Check whether any required Asset is absent from its configured source.

    Args:
        item: Catalog Item source locations to inspect.
        source_root: Root of the mounted source tree.
        remote_asset_availability: Optional provider verifier for remote Assets.

    Returns:
        Whether at least one required mounted or remote source Asset is missing.

    Raises:
        ValueError: If an Asset location is outside configured sources.
        OSError: If a local Asset exists but is not a mounted file.
        Exception: If a remote Asset cannot be verified safely.
    """
    resolved_source_root = source_root.resolve()
    mount_uri = urlsplit(resolved_source_root.as_uri())
    mount_uri_path = unquote(mount_uri.path).rstrip("/")
    is_missing = False
    for asset_href in item.asset_hrefs:
        asset_uri = urlsplit(asset_href)
        if asset_uri.scheme != "file":
            if remote_asset_availability is None:
                raise ValueError(
                    f"{item.collection}/{item.item_id} has an Asset outside the scan mount"
                )
            if remote_asset_availability.is_missing(asset_href):
                is_missing = True
            continue
        asset_uri_path = unquote(asset_uri.path)
        if (
            asset_uri.scheme != "file"
            or asset_uri.netloc != mount_uri.netloc
            or asset_uri.query
            or asset_uri.fragment
            or not asset_uri_path.startswith(f"{mount_uri_path}/")
        ):
            raise ValueError(
                f"{item.collection}/{item.item_id} has an Asset outside the scan mount"
            )
        relative_path = Path(asset_uri_path[len(mount_uri_path) + 1 :])
        try:
            source_path = (source_root / relative_path).resolve(strict=True)
        except FileNotFoundError:
            is_missing = True
            continue
        if (
            not source_path.is_relative_to(resolved_source_root)
            or not source_path.is_file()
        ):
            raise OSError(
                f"{item.collection}/{item.item_id} source Asset is not a mounted file"
            )
    return is_missing


def source_signature(source_root: Path) -> tuple[int, int]:
    """Identify the mounted root before the destructive phase begins.

    Args:
        source_root: Root of the mounted source tree.

    Returns:
        Device and inode identifiers for the mounted root.

    Raises:
        OSError: If the root cannot be inspected.
    """
    file_status = source_root.stat()
    return file_status.st_dev, file_status.st_ino


def missing_item_batches(
    missing_items: Iterable[str],
    batch_size: int,
) -> Iterable[list[tuple[str, str]]]:
    """Decode spooled missing keys into bounded database batches.

    Args:
        missing_items: JSON-encoded Collection and Item identifier pairs.
        batch_size: Maximum number of keys per batch.

    Yields:
        Bounded batches of Collection and Item identifier pairs.
    """
    batch: list[tuple[str, str]] = []
    for line in missing_items:
        collection, item_id = json.loads(line)
        batch.append((collection, item_id))
        if len(batch) == batch_size:
            yield batch
            batch = []
    if batch:
        yield batch
