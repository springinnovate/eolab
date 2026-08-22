"""Bounded process-pool metadata extraction pipeline."""

import asyncio
from collections.abc import AsyncIterator, Callable
from concurrent.futures import Executor, ProcessPoolExecutor
from multiprocessing import get_context
from pathlib import Path
from time import perf_counter, process_time
from typing import Any

from eolab_app.catalog.geotiff import build_stac_item as build_geotiff_stac_item
from eolab_app.catalog.models import DatasetCandidate, DatasetMetadataResult
from eolab_app.catalog.shapefile import build_stac_item as build_shapefile_stac_item


DatasetItemBuilder = Callable[..., dict[str, Any]]
MetadataExecutorFactory = Callable[[int], Executor]

DATASET_ITEM_BUILDERS: dict[str, DatasetItemBuilder] = {
    ".tif": build_geotiff_stac_item,
    ".tiff": build_geotiff_stac_item,
    ".shp": build_shapefile_stac_item,
}


class MetadataPipeline:
    """Stream per-dataset metadata through bounded worker queues."""

    def __init__(
        self,
        source_root: Path,
        worker_count: int,
        result_queue_size: int,
        executor_factory: MetadataExecutorFactory | None = None,
    ) -> None:
        """Configure metadata extraction.

        Args:
            source_root: Root of the mounted source tree.
            worker_count: Number of concurrent metadata workers.
            result_queue_size: Maximum completed results awaiting consumption.
            executor_factory: Creates the worker executor. The default uses
                isolated spawned processes; tests may inject threads.

        """
        self.source_root = source_root
        self.worker_count = worker_count
        self.result_queue_size = result_queue_size
        self.executor_factory = executor_factory or create_metadata_executor

    async def results(
        self,
        dataset_candidates: list[DatasetCandidate],
    ) -> AsyncIterator[DatasetMetadataResult]:
        """Yield metadata results while owning all worker resources.

        Args:
            dataset_candidates: Deterministically ordered datasets to inspect.

        Yields:
            One success or captured per-dataset failure for every candidate.

        Raises:
            RuntimeError: If a worker or executor fails outside an individual
                dataset builder call.
        """
        path_queue: asyncio.Queue[DatasetCandidate | None] = asyncio.Queue(
            maxsize=self.worker_count * 2
        )
        result_queue: asyncio.Queue[DatasetMetadataResult | None] = asyncio.Queue(
            maxsize=self.result_queue_size
        )
        metadata_executor = self.executor_factory(self.worker_count)
        path_producer = asyncio.create_task(
            enqueue_dataset_candidates(
                dataset_candidates,
                path_queue,
                self.worker_count,
            )
        )
        metadata_workers = [
            asyncio.create_task(
                read_dataset_metadata(
                    self.source_root,
                    path_queue,
                    result_queue,
                    metadata_executor,
                )
            )
            for _ in range(self.worker_count)
        ]
        completed_workers = 0
        try:
            while completed_workers < self.worker_count:
                metadata_result = await result_queue.get()
                if metadata_result is None:
                    completed_workers += 1
                else:
                    yield metadata_result
        finally:
            path_producer.cancel()
            for metadata_worker in metadata_workers:
                metadata_worker.cancel()
            await asyncio.gather(
                path_producer,
                *metadata_workers,
                return_exceptions=True,
            )
            await asyncio.to_thread(
                metadata_executor.shutdown,
                wait=True,
                cancel_futures=True,
            )


async def enqueue_dataset_candidates(
    dataset_candidates: list[DatasetCandidate],
    path_queue: asyncio.Queue[DatasetCandidate | None],
    metadata_worker_count: int,
) -> None:
    """Feed discovered datasets to a bounded metadata-work queue.

    Args:
        dataset_candidates: Datasets awaiting metadata extraction.
        path_queue: Bounded worker input queue.
        metadata_worker_count: Number of completion sentinels to enqueue.
    """
    for dataset_candidate in dataset_candidates:
        await path_queue.put(dataset_candidate)
    for _ in range(metadata_worker_count):
        await path_queue.put(None)


async def read_dataset_metadata(
    source_root: Path,
    path_queue: asyncio.Queue[DatasetCandidate | None],
    result_queue: asyncio.Queue[DatasetMetadataResult | None],
    metadata_executor: Executor,
) -> None:
    """Read dataset metadata until the producer signals completion.

    Args:
        source_root: Root of the mounted source tree.
        path_queue: Bounded worker input queue.
        result_queue: Bounded metadata result queue.
        metadata_executor: Executor running metadata extraction.
    """
    event_loop = asyncio.get_running_loop()
    while (dataset_candidate := await path_queue.get()) is not None:
        metadata_result = await event_loop.run_in_executor(
            metadata_executor,
            build_dataset_metadata,
            source_root,
            dataset_candidate,
        )
        await result_queue.put(metadata_result)
    await result_queue.put(None)


def build_dataset_metadata(
    source_root: Path,
    dataset_candidate: DatasetCandidate,
) -> DatasetMetadataResult:
    """Build one Item while separating worker CPU from elapsed time.

    Args:
        source_root: Root of the mounted source tree.
        dataset_candidate: Dataset and any companion files to inspect.

    Returns:
        Item or per-dataset failure with worker timing.
    """
    elapsed_started = perf_counter()
    processing_started = process_time()
    dataset_path = dataset_candidate.path
    builder_arguments: list[Any] = [source_root, dataset_path]
    if dataset_candidate.component_paths:
        builder_arguments.append(dataset_candidate.component_paths)
    try:
        item = DATASET_ITEM_BUILDERS[dataset_path.suffix.lower()](*builder_arguments)
        if item["geometry"] is None:
            raise ValueError(
                "Dataset has no spatial footprint; pgSTAC requires Item geometry"
            )
        error_message = None
    except Exception as error:
        item = None
        error_message = str(error)
    elapsed_seconds = perf_counter() - elapsed_started
    return DatasetMetadataResult(
        path=dataset_path,
        item=item,
        error=error_message,
        elapsed_seconds=elapsed_seconds,
        processing_seconds=min(
            process_time() - processing_started,
            elapsed_seconds,
        ),
    )


def create_metadata_executor(worker_count: int) -> ProcessPoolExecutor:
    """Create isolated metadata workers without inheriting app threads.

    Args:
        worker_count: Number of worker processes.

    Returns:
        Spawn-based metadata executor.
    """
    return ProcessPoolExecutor(
        max_workers=worker_count,
        mp_context=get_context("spawn"),
    )
