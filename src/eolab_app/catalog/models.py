"""Typed values shared by the catalog scanning pipeline."""

from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, TypedDict
from uuid import uuid4


ScanState = Literal[
    "not_started",
    "discovering",
    "scanning",
    "completed",
    "failed",
]
ReconciliationState = Literal[
    "not_started",
    "checking",
    "deleting",
    "completed",
    "failed",
]


class ScanError(TypedDict):
    """One bounded, browser-safe scan failure detail."""

    path: str | None
    error: str


@dataclass(frozen=True)
class DatasetCandidate:
    """A primary dataset path and any pre-grouped companion files.

    Attributes:
        path: Primary dataset path.
        component_paths: Companion files belonging to a multipart dataset.
    """

    path: Path
    component_paths: tuple[Path, ...] = ()


@dataclass(frozen=True)
class DatasetMetadataResult:
    """One dataset result with worker wall and CPU measurements.

    Attributes:
        path: Primary dataset path.
        item: Built STAC Item, or ``None`` when metadata extraction failed.
        error: Failure text, or ``None`` when metadata extraction succeeded.
        elapsed_seconds: Worker wall time.
        processing_seconds: Worker CPU time.
    """

    path: Path
    item: dict[str, Any] | None
    error: str | None
    elapsed_seconds: float
    processing_seconds: float


@dataclass(frozen=True)
class CatalogItemSource:
    """Source Assets for one scanner-owned catalog Item.

    Attributes:
        collection: Collection containing the Item.
        item_id: Item identifier within the Collection.
        asset_hrefs: Required source Asset locations.
    """

    collection: str
    item_id: str
    asset_hrefs: tuple[str, ...]


@dataclass
class ScanTiming:
    """Mutable measurements for one scan's named phases.

    Attributes:
        elapsed_seconds: Total scan wall time.
        catalog_inventory_seconds: Time spent reading existing Item keys.
        discovery_seconds: Time spent traversing configured source paths.
        metadata_result_wait_seconds: Coordinator time awaiting worker results.
        metadata_worker_seconds: Sum of per-dataset worker wall times.
        metadata_processing_seconds: Sum of per-dataset worker CPU times.
        metadata_io_wait_seconds: Derived non-CPU worker time.
        catalog_write_seconds: Accumulated Collection and Item write time.
        reconciliation_seconds: Missing-Item verification and deletion time.
        cache_invalidation_seconds: Search-count cache invalidation time.
    """

    elapsed_seconds: float = 0.0
    catalog_inventory_seconds: float = 0.0
    discovery_seconds: float = 0.0
    metadata_result_wait_seconds: float = 0.0
    metadata_worker_seconds: float = 0.0
    metadata_processing_seconds: float = 0.0
    metadata_io_wait_seconds: float = 0.0
    catalog_write_seconds: float = 0.0
    reconciliation_seconds: float = 0.0
    cache_invalidation_seconds: float = 0.0

    def as_public_dict(self) -> dict[str, float]:
        """Serialize timing fields using the established browser names.

        Returns:
            A new mapping with the existing camel-case timing shape.
        """
        return {
            "elapsedSeconds": self.elapsed_seconds,
            "catalogInventorySeconds": self.catalog_inventory_seconds,
            "discoverySeconds": self.discovery_seconds,
            "metadataResultWaitSeconds": self.metadata_result_wait_seconds,
            "metadataWorkerSeconds": self.metadata_worker_seconds,
            "metadataProcessingSeconds": self.metadata_processing_seconds,
            "metadataIoWaitSeconds": self.metadata_io_wait_seconds,
            "catalogWriteSeconds": self.catalog_write_seconds,
            "reconciliationSeconds": self.reconciliation_seconds,
            "cacheInvalidationSeconds": self.cache_invalidation_seconds,
        }


@dataclass
class ReconciliationStatus:
    """Mutable progress for missing-Item reconciliation.

    Attributes:
        state: Current reconciliation phase.
        checked: Scanner-owned Items whose source Assets were verified.
        missing: Items proven to have a missing required Asset.
        removed: Missing Items deleted transactionally.
        error: Captured verification or deletion failure.
    """

    state: ReconciliationState = "not_started"
    checked: int = 0
    missing: int = 0
    removed: int = 0
    error: str | None = None

    def as_public_dict(self) -> dict[str, object]:
        """Serialize reconciliation using its established public shape.

        Returns:
            A new browser-safe reconciliation mapping.
        """
        return {
            "state": self.state,
            "checked": self.checked,
            "missing": self.missing,
            "removed": self.removed,
            "error": self.error,
        }


@dataclass
class ScanStatus:
    """Typed mutable state for one scan run.

    Attributes:
        worker_count: Configured metadata worker processes.
        writer_count: Configured concurrent catalog writers.
        batch_size: Configured Item write and deletion batch size.
        state: Current scan state.
        id: Unique identifier for this run.
        discovered: Supported datasets found during traversal.
        processed: Dataset metadata results consumed.
        indexed: Items successfully written in this run.
        already_in_catalog: Written Items present before this run.
        failed: Discovery and per-dataset failures encountered.
        current_file: Mount-relative dataset most recently processed.
        started_at: UTC start timestamp.
        finished_at: UTC finish timestamp.
        errors: Bounded failure details plus any terminal scan failure.
        errors_truncated: Whether per-dataset details exceeded the bound.
        reconciliation: Missing-Item cleanup progress.
        timing: Named phase measurements.
    """

    worker_count: int
    writer_count: int
    batch_size: int
    state: ScanState = "not_started"
    id: str = field(default_factory=lambda: str(uuid4()))
    discovered: int = 0
    processed: int = 0
    indexed: int = 0
    already_in_catalog: int = 0
    failed: int = 0
    current_file: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    errors: list[ScanError] = field(default_factory=list)
    errors_truncated: bool = False
    reconciliation: ReconciliationStatus = field(
        default_factory=ReconciliationStatus
    )
    timing: ScanTiming = field(default_factory=ScanTiming)

    def as_public_dict(self) -> dict[str, Any]:
        """Return an isolated snapshot in the existing scan JSON shape.

        Returns:
            Deeply independent browser-safe scan status.
        """
        return {
            "id": self.id,
            "state": self.state,
            "discovered": self.discovered,
            "processed": self.processed,
            "indexed": self.indexed,
            "alreadyInCatalog": self.already_in_catalog,
            "failed": self.failed,
            "workerCount": self.worker_count,
            "writerCount": self.writer_count,
            "batchSize": self.batch_size,
            "currentFile": self.current_file,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "errors": deepcopy(self.errors),
            "errorsTruncated": self.errors_truncated,
            "reconciliation": self.reconciliation.as_public_dict(),
            "timing": self.timing.as_public_dict(),
        }
