"""Single-active-scan coordinator expressed as named pipeline phases."""

import asyncio
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter
from typing import Any

from eolab_app.catalog.collections import (
    SCAN_COLLECTION_IDENTIFIERS,
    SCAN_COLLECTIONS,
)
from eolab_app.catalog.discovery import FilesystemDatasetDiscovery
from eolab_app.catalog.handlers import (
    DatasetHandlerRegistry,
    create_default_dataset_handler_registry,
)
from eolab_app.catalog.metadata import MetadataPipeline
from eolab_app.catalog.models import (
    DatasetCandidate,
    DatasetMetadataResult,
    ScanError,
    ScanState,
    ScanStatus,
)
from eolab_app.catalog.ports import (
    CatalogDatabase,
    CatalogReconciler,
    CatalogWriter,
    CatalogWriteSession,
    DatasetDiscovery,
    DatasetItemFinalizer,
    DatasetMetadataReader,
)
from eolab_app.catalog.reconciliation import MissingItemReconciler


DEFAULT_SCAN_ERROR_DETAIL_LIMIT = 100


class ScanManager:
    """Own one in-process scan and coordinate its explicit phases."""

    def __init__(
        self,
        source_root: Path,
        source_paths: tuple[Path, ...],
        catalog_writer: CatalogWriter,
        catalog_database: CatalogDatabase,
        metadata_worker_count: int,
        catalog_writer_count: int,
        item_batch_size: int,
        *,
        dataset_handlers: DatasetHandlerRegistry | None = None,
        discovery: DatasetDiscovery | None = None,
        metadata_pipeline: DatasetMetadataReader | None = None,
        item_finalizer: DatasetItemFinalizer | None = None,
        reconciler: CatalogReconciler | None = None,
        error_detail_limit: int = DEFAULT_SCAN_ERROR_DETAIL_LIMIT,
    ) -> None:
        """Configure the scanner and its bounded phase collaborators.

        Args:
            source_root: Root of the mounted source tree.
            source_paths: Directories within the mount to scan.
            catalog_writer: STAC Transactions writer port.
            catalog_database: Direct catalog database port.
            metadata_worker_count: Concurrent metadata worker processes.
            catalog_writer_count: Concurrent catalog writes.
            item_batch_size: Maximum Items per bulk write or delete batch.
            dataset_handlers: Optional explicit handler registry shared by
                default discovery and metadata extraction.
            discovery: Optional filesystem discovery collaborator.
            metadata_pipeline: Optional metadata extraction collaborator.
            item_finalizer: Optional external assessment collaborator applied
                after extraction and before persistence.
            reconciler: Optional destructive reconciliation collaborator.
            error_detail_limit: Maximum individual failure details retained in
                the public scan status.

        """
        self.source_root = source_root
        self.catalog_writer = catalog_writer
        self.catalog_database = catalog_database
        self.metadata_worker_count = metadata_worker_count
        self.catalog_writer_count = catalog_writer_count
        self.item_batch_size = item_batch_size
        self.error_detail_limit = error_detail_limit
        active_dataset_handlers = (
            dataset_handlers or create_default_dataset_handler_registry()
        )
        self.discovery = discovery or FilesystemDatasetDiscovery(
            source_root,
            source_paths,
            active_dataset_handlers,
        )
        self.metadata_pipeline = metadata_pipeline or MetadataPipeline(
            source_root,
            metadata_worker_count,
            item_batch_size * 2,
            active_dataset_handlers,
        )
        self.item_finalizer = item_finalizer
        self.reconciler = reconciler or MissingItemReconciler(
            source_root,
            catalog_database,
            item_batch_size,
        )
        self._start_lock = asyncio.Lock()
        self._task: asyncio.Task[None] | None = None
        self._started_at_monotonic: float | None = None
        self._finished_at_monotonic: float | None = None
        self._status = self._new_status("not_started")

    def status(self) -> dict[str, Any]:
        """Return an isolated snapshot of current scan progress.

        Returns:
            Current public status with a live elapsed time.
        """
        status = self._status.as_public_dict()
        if self._started_at_monotonic is not None:
            elapsed_until = (
                perf_counter()
                if self._finished_at_monotonic is None
                else self._finished_at_monotonic
            )
            status["timing"]["elapsedSeconds"] = (
                elapsed_until - self._started_at_monotonic
            )
        return status

    async def start(self) -> dict[str, Any]:
        """Start a scan unless one is already running.

        Returns:
            Initial status for the newly started scan.

        Raises:
            RuntimeError: If a scan is already running.
        """
        async with self._start_lock:
            if self._task is not None and not self._task.done():
                raise RuntimeError("A dataset scan is already running")
            self._status = self._new_status("discovering")
            self._status.started_at = utc_now()
            self._started_at_monotonic = perf_counter()
            self._finished_at_monotonic = None
            self._task = asyncio.create_task(self._run())
            return self.status()

    async def _run(self) -> None:
        """Execute inventory, discovery, indexing, reconciliation, and cleanup."""
        reconciliation_task: asyncio.Task[int] | None = None
        try:
            existing_item_keys = await self._inventory_catalog()
            dataset_candidates, discovery_errors = await self._discover_datasets()
            self._record_discovery(dataset_candidates, discovery_errors)

            async with self.catalog_writer.session() as catalog_session:
                await self._write_collections(catalog_session)
                reconciliation_task = asyncio.create_task(
                    self._reconcile_missing_items()
                )
                await self._extract_and_write_items(
                    catalog_session,
                    dataset_candidates,
                    existing_item_keys,
                )

            await reconciliation_task
            await self._invalidate_search_count_cache()
            self._status.state = "completed"
        except Exception as error:
            await self._record_scan_failure(error, reconciliation_task)
        finally:
            self._finish_status()

    async def _inventory_catalog(self) -> set[tuple[str, str]]:
        """Capture scanner-owned Item identities before catalog writes.

        Returns:
            Existing Collection and Item identifier pairs.

        Raises:
            Exception: Propagates failures from the catalog database port.
        """
        phase_started = perf_counter()
        try:
            return await self.catalog_database.existing_item_keys(
                SCAN_COLLECTION_IDENTIFIERS
            )
        finally:
            self._status.timing.catalog_inventory_seconds = (
                perf_counter() - phase_started
            )

    async def _discover_datasets(
        self,
    ) -> tuple[list[DatasetCandidate], list[ScanError]]:
        """Run deterministic filesystem discovery off the event loop.

        Returns:
            Discovered datasets and bounded-path traversal errors.

        Raises:
            Exception: Propagates discovery failures outside tolerated walk
                errors.
        """
        phase_started = perf_counter()
        try:
            return await asyncio.to_thread(self.discovery.discover)
        finally:
            self._status.timing.discovery_seconds = perf_counter() - phase_started

    def _record_discovery(
        self,
        dataset_candidates: list[DatasetCandidate],
        discovery_errors: list[ScanError],
    ) -> None:
        """Advance status from discovery into metadata scanning.

        Args:
            dataset_candidates: Complete discovered dataset inventory.
            discovery_errors: Directory-walk failures to record.
        """
        self._status.discovered = len(dataset_candidates)
        self._status.failed = len(discovery_errors)
        self._status.errors.extend(discovery_errors[: self.error_detail_limit])
        self._status.errors_truncated = (
            len(discovery_errors) > self.error_detail_limit
        )
        self._status.state = "scanning"

    async def _write_collections(
        self,
        catalog_session: CatalogWriteSession,
    ) -> None:
        """Upsert all scanner-owned Collections.

        Args:
            catalog_session: Open STAC Transactions session.

        Raises:
            Exception: Propagates catalog writer failures.
        """
        phase_started = perf_counter()
        try:
            for collection in SCAN_COLLECTIONS:
                await catalog_session.upsert_collection(collection)
        finally:
            self._status.timing.catalog_write_seconds += (
                perf_counter() - phase_started
            )

    async def _extract_and_write_items(
        self,
        catalog_session: CatalogWriteSession,
        dataset_candidates: list[DatasetCandidate],
        existing_item_keys: set[tuple[str, str]],
    ) -> None:
        """Consume metadata results and issue bounded concurrent bulk writes.

        Args:
            catalog_session: Open STAC Transactions session.
            dataset_candidates: Datasets awaiting metadata extraction.
            existing_item_keys: Pre-scan catalog inventory.

        Raises:
            Exception: Propagates pipeline or catalog writer failures after
                cancelling sibling writes.
        """
        pending_items_by_collection: dict[str, list[dict[str, Any]]] = {
            collection_identifier: []
            for collection_identifier in SCAN_COLLECTION_IDENTIFIERS
        }
        catalog_write_tasks: set[asyncio.Task[None]] = set()
        metadata_results = aiter(
            self.metadata_pipeline.results(dataset_candidates)
        )
        try:
            while True:
                self._raise_completed_catalog_writes(catalog_write_tasks)
                phase_started = perf_counter()
                try:
                    metadata_result = await anext(metadata_results)
                except StopAsyncIteration:
                    self._status.timing.metadata_result_wait_seconds += (
                        perf_counter() - phase_started
                    )
                    break
                self._status.timing.metadata_result_wait_seconds += (
                    perf_counter() - phase_started
                )
                self._record_metadata_result(metadata_result)
                if metadata_result.error is not None:
                    continue

                for extracted_item in metadata_result.items:
                    item = (
                        await self.item_finalizer.finalize(extracted_item)
                        if self.item_finalizer is not None
                        else extracted_item
                    )
                    pending_items = pending_items_by_collection[
                        item["collection"]
                    ]
                    pending_items.append(item)
                    if len(pending_items) == self.item_batch_size:
                        self._schedule_item_write(
                            catalog_write_tasks,
                            catalog_session,
                            pending_items,
                            existing_item_keys,
                        )
                        pending_items_by_collection[item["collection"]] = []
                        await self._enforce_catalog_writer_limit(
                            catalog_write_tasks
                        )

            for pending_items in pending_items_by_collection.values():
                if pending_items:
                    self._schedule_item_write(
                        catalog_write_tasks,
                        catalog_session,
                        pending_items,
                        existing_item_keys,
                    )
                    await self._enforce_catalog_writer_limit(catalog_write_tasks)

            if catalog_write_tasks:
                await asyncio.wait(catalog_write_tasks)
                self._raise_completed_catalog_writes(catalog_write_tasks)
        finally:
            await metadata_results.aclose()
            for catalog_write_task in catalog_write_tasks:
                catalog_write_task.cancel()
            await asyncio.gather(
                *catalog_write_tasks,
                return_exceptions=True,
            )

    def _record_metadata_result(
        self,
        metadata_result: DatasetMetadataResult,
    ) -> None:
        """Accumulate one worker result into the active typed status.

        Args:
            metadata_result: Completed dataset metadata operation.
        """
        self._status.timing.metadata_worker_seconds += (
            metadata_result.elapsed_seconds
        )
        self._status.timing.metadata_processing_seconds += (
            metadata_result.processing_seconds
        )
        self._status.timing.metadata_io_wait_seconds += max(
            metadata_result.elapsed_seconds - metadata_result.processing_seconds,
            0,
        )
        relative_path = metadata_result.path.relative_to(
            self.source_root
        ).as_posix()
        self._status.current_file = relative_path
        self._status.processed += 1
        self._status.items_produced += len(metadata_result.items)
        if metadata_result.error is None:
            return
        self._status.failed += 1
        if len(self._status.errors) < self.error_detail_limit:
            self._status.errors.append({
                "path": relative_path,
                "error": metadata_result.error,
            })
        else:
            self._status.errors_truncated = True

    def _schedule_item_write(
        self,
        catalog_write_tasks: set[asyncio.Task[None]],
        catalog_session: CatalogWriteSession,
        items: list[dict[str, Any]],
        existing_item_keys: set[tuple[str, str]],
    ) -> None:
        """Add one single-Collection Item batch to the active write set.

        Args:
            catalog_write_tasks: Mutable set of active writes.
            catalog_session: Open STAC Transactions session.
            items: Complete nonempty Item batch.
            existing_item_keys: Pre-scan catalog inventory.
        """
        catalog_write_tasks.add(asyncio.create_task(
            self._upsert_items(
                catalog_session,
                items,
                existing_item_keys,
            )
        ))

    @staticmethod
    def _raise_completed_catalog_writes(
        catalog_write_tasks: set[asyncio.Task[None]],
    ) -> None:
        """Remove completed writes and propagate their first failure.

        Args:
            catalog_write_tasks: Mutable set of active writes.

        Raises:
            Exception: Propagates a completed catalog write failure.
        """
        completed_writes = {
            task for task in catalog_write_tasks if task.done()
        }
        for completed_write in completed_writes:
            catalog_write_tasks.remove(completed_write)
            completed_write.result()

    async def _enforce_catalog_writer_limit(
        self,
        catalog_write_tasks: set[asyncio.Task[None]],
    ) -> None:
        """Wait for a write when all configured slots are occupied.

        Args:
            catalog_write_tasks: Active catalog-write tasks.

        Raises:
            Exception: Propagates a completed catalog write failure.
        """
        if len(catalog_write_tasks) < self.catalog_writer_count:
            return
        await asyncio.wait(
            catalog_write_tasks,
            return_when=asyncio.FIRST_COMPLETED,
        )
        self._raise_completed_catalog_writes(catalog_write_tasks)

    async def _upsert_items(
        self,
        catalog_session: CatalogWriteSession,
        items: list[dict[str, Any]],
        existing_item_keys: set[tuple[str, str]],
    ) -> None:
        """Write one batch and classify its successfully cataloged Items.

        Args:
            catalog_session: Open STAC write session.
            items: Nonempty batch belonging to one Collection.
            existing_item_keys: Catalog inventory captured before the scan.

        Raises:
            Exception: Propagates catalog writer failures.
        """
        phase_started = perf_counter()
        try:
            await catalog_session.upsert_items(items)
        finally:
            self._status.timing.catalog_write_seconds += (
                perf_counter() - phase_started
            )
        self._status.indexed += len(items)
        self._status.already_in_catalog += sum(
            (item["collection"], item["id"]) in existing_item_keys
            for item in items
        )

    async def _reconcile_missing_items(self) -> int:
        """Run destructive reconciliation and record phase duration.

        Returns:
            Number of Items removed, or zero after a captured failure.
        """
        phase_started = perf_counter()
        try:
            return await self.reconciler.reconcile(self._status.reconciliation)
        finally:
            self._status.timing.reconciliation_seconds = (
                perf_counter() - phase_started
            )

    async def _invalidate_search_count_cache(self) -> None:
        """Invalidate pgSTAC search counts and record phase duration.

        Raises:
            Exception: Propagates a catalog database failure.
        """
        phase_started = perf_counter()
        try:
            await self.catalog_database.invalidate_search_count_cache()
        finally:
            self._status.timing.cache_invalidation_seconds = (
                perf_counter() - phase_started
            )

    async def _record_scan_failure(
        self,
        error: Exception,
        reconciliation_task: asyncio.Task[int] | None,
    ) -> None:
        """Finish overlapping cleanup before recording a terminal failure.

        Args:
            error: Failure that stopped the primary scan pipeline.
            reconciliation_task: Concurrent cleanup task, if it was started.
        """
        removed_items = 0
        if reconciliation_task is not None:
            removed_items = await reconciliation_task
        if removed_items:
            await self.catalog_database.invalidate_search_count_cache()
        self._status.state = "failed"
        self._status.errors.append({
            "path": None,
            "error": f"Scan stopped: {error}",
        })

    def _finish_status(self) -> None:
        """Record terminal timestamps and clear transient file progress."""
        self._status.current_file = None
        self._status.finished_at = utc_now()
        self._finished_at_monotonic = perf_counter()
        if self._started_at_monotonic is not None:
            self._status.timing.elapsed_seconds = (
                self._finished_at_monotonic - self._started_at_monotonic
            )

    def _new_status(self, state: ScanState) -> ScanStatus:
        """Create typed empty status for one scan run.

        Args:
            state: Initial scanner state.

        Returns:
            Mutable status owned exclusively by the new scan.
        """
        return ScanStatus(
            state=state,
            worker_count=self.metadata_worker_count,
            writer_count=self.catalog_writer_count,
            batch_size=self.item_batch_size,
        )


def utc_now() -> str:
    """Return the current UTC time in STAC timestamp form.

    Returns:
        ISO 8601 timestamp ending in ``Z``.
    """
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
