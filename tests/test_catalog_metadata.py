"""Test the catalog metadata worker boundary."""

import asyncio
from concurrent.futures import Executor, Future, ThreadPoolExecutor
from concurrent.futures.process import BrokenProcessPool
import os
from pathlib import Path
import pickle
from time import sleep
from typing import Any, NoReturn
from unittest.mock import AsyncMock, Mock

import pytest

from eolab_app.catalog.handlers import (
    DatasetHandler,
    DatasetHandlerRegistry,
    HandlerDiscovery,
    create_default_dataset_handler_registry,
)
from eolab_app.catalog.metadata import (
    MetadataPipeline,
    build_dataset_metadata,
    create_metadata_executor,
)
from eolab_app.catalog.models import DatasetCandidate, DatasetMetadataResult
from eolab_app.catalog.ports import DatasetDiscovery
from eolab_app.catalog.scanner import ScanManager
from tests.catalog_support import RecordingCatalogDatabase, RecordingCatalogWriter


def discover_no_test_datasets(
    directory_path: Path,
    directory_names: tuple[str, ...],
    file_names: tuple[str, ...],
) -> HandlerDiscovery:
    """Provide the unused discovery half of a metadata-only test handler.

    Args:
        directory_path: Directory being scanned.
        directory_names: Sorted child directory names.
        file_names: Sorted child file names.

    Returns:
        An empty discovery result.
    """
    del directory_path, directory_names, file_names
    return HandlerDiscovery()


def build_test_items(
    source_root: Path,
    candidate: DatasetCandidate,
) -> tuple[dict[str, Any], ...]:
    """Emit the Item count encoded in a test candidate's filename.

    Args:
        source_root: Root directory mounted for scanning.
        candidate: Dataset whose stem specifies the result cardinality.

    Returns:
        Zero, one, or multiple valid STAC Items.
    """
    del source_root
    item_count = int(candidate.path.stem)
    return tuple({
        "id": f"{candidate.path.stem}-{item_index}",
        "collection": "eolab-mounted-geotiffs",
        "geometry": {"type": "Point", "coordinates": [0, 0]},
    } for item_index in range(item_count))


def test_handler_registry_supports_zero_one_and_multiple_items(
    tmp_path: Path,
) -> None:
    """Keep source-result cardinality independent from Item cardinality.

    Args:
        tmp_path: Isolated mounted source root.
    """
    registry = DatasetHandlerRegistry(handlers=(DatasetHandler(
        name="cardinality",
        discover=discover_no_test_datasets,
        build_items=build_test_items,
    ),))

    results = [
        build_dataset_metadata(
            tmp_path,
            DatasetCandidate(tmp_path / str(item_count), "cardinality"),
            registry,
        )
        for item_count in range(3)
    ]

    assert [len(result.items) for result in results] == [0, 1, 2]
    assert all(result.error is None for result in results)


def test_unknown_dataset_builder_is_captured_as_a_dataset_failure(
    tmp_path: Path,
) -> None:
    """Keep dispatch failures local to one metadata result.

    Args:
        tmp_path: Isolated mounted source root.
    """
    dataset_path = tmp_path / "unknown.bin"
    dataset_path.touch()

    result = build_dataset_metadata(
        tmp_path,
        DatasetCandidate(dataset_path, "unknown"),
    )

    assert result.items == ()
    assert result.error == "'Unknown dataset handler: unknown'"
    assert result.elapsed_seconds >= result.processing_seconds >= 0


def test_metadata_pipeline_owns_bounded_worker_completion() -> None:
    """An empty workload starts and shuts down every configured worker."""

    async def collect_results() -> list[DatasetMetadataResult]:
        """Collect all results from an empty bounded pipeline.

        Returns:
            The empty list emitted after worker shutdown.
        """
        pipeline = MetadataPipeline(
            Path("/scan-source"),
            worker_count=2,
            result_queue_size=2,
            dataset_handlers=create_default_dataset_handler_registry(),
            executor_factory=ThreadPoolExecutor,
        )
        return [result async for result in pipeline.results([])]

    assert asyncio.run(collect_results()) == []


@pytest.mark.parametrize(
    "failure, reject_submission",
    [
        (RuntimeError("executor rejected submission"), True),
        (BrokenProcessPool("metadata worker exited"), False),
        (pickle.PicklingError("handler serialization failed"), False),
    ],
)
def test_executor_failure_stops_scan_and_allows_restart(
    tmp_path: Path, failure: Exception, reject_submission: bool
) -> None:
    """Propagate executor failures through scan status before allowing a retry.

    Args:
        tmp_path: Isolated source root.
        failure: Failure raised outside per-dataset metadata extraction.
        reject_submission: Whether submission itself fails instead of its future.
    """
    executor = Mock(spec=Executor)
    if reject_submission:
        executor.submit.side_effect = failure
    else:
        failed_future: Future[DatasetMetadataResult] = Future()
        failed_future.set_exception(failure)
        executor.submit.return_value = failed_future
    registry = DatasetHandlerRegistry(
        handlers=(
            DatasetHandler(
                name="cardinality",
                discover=discover_no_test_datasets,
                build_items=build_test_items,
            ),
        )
    )
    # Exceed the input queue capacity so cleanup must also stop its producer.
    candidates = [DatasetCandidate(tmp_path / "0", "cardinality")] * 8
    discovery = Mock(spec=DatasetDiscovery)
    discovery.discover.return_value = (candidates, [])
    writer = RecordingCatalogWriter()
    database = RecordingCatalogDatabase(writer)
    pipeline = MetadataPipeline(
        tmp_path, 1, 1, registry, executor_factory=Mock(return_value=executor)
    )
    manager = ScanManager(
        tmp_path,
        (tmp_path,),
        writer,
        database,
        1,
        1,
        1,
        discovery=discovery,
        metadata_pipeline=pipeline,
    )

    async def scan_and_retry() -> None:
        """Wait for failure cleanup and then complete another scan."""
        await manager.start()
        async with asyncio.timeout(5):
            while manager.status()["state"] != "failed":
                await asyncio.sleep(0)
        executor.shutdown.assert_called_once_with(wait=True, cancel_futures=True)
        assert manager.status()["errors"][-1]["error"] == f"Scan stopped: {failure}"
        assert database.search_count_cache_invalidations == 0
        assert writer.write_session.item_batches == []
        pipeline.executor_factory = ThreadPoolExecutor
        await manager.start()
        async with asyncio.timeout(5):
            while manager.status()["state"] != "completed":
                await asyncio.sleep(0)
        assert manager.status()["sourceDatasetsProcessed"] == len(candidates)
        assert database.search_count_cache_invalidations == 1

    asyncio.run(scan_and_retry())


def test_producer_failure_interrupts_result_wait(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Report producer failure even when no worker can emit a result.

    Args:
        tmp_path: Isolated source root.
        monkeypatch: Injects a failure at the pipeline's producer boundary.
    """
    failure = RuntimeError("candidate producer failed")
    monkeypatch.setattr(
        "eolab_app.catalog.metadata.enqueue_dataset_candidates",
        AsyncMock(side_effect=failure),
    )
    executor = Mock(spec=Executor)
    pipeline = MetadataPipeline(
        tmp_path,
        2,
        1,
        create_default_dataset_handler_registry(),
        executor_factory=Mock(return_value=executor),
    )

    async def collect_results() -> None:
        """Require producer failure to escape without an external cancellation."""
        with pytest.raises(RuntimeError, match="candidate producer failed") as raised:
            async with asyncio.timeout(5):
                await anext(pipeline.results([]))
        assert raised.value is failure

    asyncio.run(collect_results())
    executor.shutdown.assert_called_once_with(wait=True, cancel_futures=True)


def test_worker_failure_while_iterator_is_suspended(
    tmp_path: Path,
) -> None:
    """Deliver a worker failure on iteration without cancelling consumer work.

    Args:
        tmp_path: Isolated source root.
    """
    candidate = DatasetCandidate(tmp_path / "unknown.bin", "unknown")
    result = build_dataset_metadata(tmp_path, candidate)
    first_future: Future[DatasetMetadataResult] = Future()
    first_future.set_result(result)
    second_future: Future[DatasetMetadataResult] = Future()
    executor = Mock(spec=Executor)
    executor.submit.side_effect = [first_future, second_future]
    pipeline = MetadataPipeline(
        tmp_path,
        2,
        1,
        create_default_dataset_handler_registry(),
        executor_factory=Mock(return_value=executor),
    )

    async def consume_results() -> None:
        """Suspend between results while another worker reports its failure."""
        results = pipeline.results([candidate, candidate])
        assert await anext(results) is result
        second_future.set_exception(BrokenProcessPool("worker failed between results"))
        await asyncio.sleep(0)
        with pytest.raises(BrokenProcessPool, match="worker failed between results"):
            async with asyncio.timeout(5):
                await anext(results)

    asyncio.run(consume_results())
    executor.shutdown.assert_called_once_with(wait=True, cancel_futures=True)


def exit_metadata_worker(source_root: Path, candidate: DatasetCandidate) -> NoReturn:
    """Exit the spawned worker before it can return dataset metadata.

    Args:
        source_root: Unused mounted source root.
        candidate: Unused dataset candidate.
    """
    del source_root, candidate
    os._exit(1)


def test_spawned_metadata_worker_exit_propagates(tmp_path: Path) -> None:
    """Exercise a real process-pool failure through the result iterator.

    Args:
        tmp_path: Isolated source root.
    """
    registry = DatasetHandlerRegistry(
        handlers=(
            DatasetHandler(
                name="exit",
                discover=discover_no_test_datasets,
                build_items=exit_metadata_worker,
            ),
        )
    )
    pipeline = MetadataPipeline(tmp_path, 1, 1, registry)

    async def collect_results() -> None:
        """Require native worker exit to finish iterator cleanup and raise."""
        with pytest.raises(BrokenProcessPool):
            async with asyncio.timeout(30):
                await anext(
                    pipeline.results([DatasetCandidate(tmp_path / "exit", "exit")])
                )

    asyncio.run(collect_results())


def wait_for_metadata_release(
    source_root: Path, candidate: DatasetCandidate
) -> tuple[dict[str, Any], ...]:
    """Hold native work until the test permits it to exit.

    Args:
        source_root: Directory containing worker lifecycle marker files.
        candidate: Unused dataset candidate.

    Returns:
        An empty successful Item result after release.
    """
    del candidate
    (source_root / "started").touch()
    while not (source_root / "release").exists():
        sleep(0.01)
    (source_root / "exited").touch()
    return ()


def test_cancellation_waits_for_native_metadata_work(tmp_path: Path) -> None:
    """Keep executor ownership until cancelled native work actually exits.

    Args:
        tmp_path: Isolated source root and worker lifecycle markers.
    """
    registry = DatasetHandlerRegistry(
        handlers=(
            DatasetHandler(
                name="blocked",
                discover=discover_no_test_datasets,
                build_items=wait_for_metadata_release,
            ),
        )
    )
    executor = Mock(spec=Executor, wraps=create_metadata_executor(1))
    shutdown = executor.shutdown
    pipeline = MetadataPipeline(
        tmp_path, 1, 1, registry, executor_factory=Mock(return_value=executor)
    )

    async def cancel_result_wait() -> None:
        """Cancel result consumption, release the worker, and await shutdown."""
        results = pipeline.results([DatasetCandidate(tmp_path / "blocked", "blocked")])
        next_result = asyncio.create_task(anext(results))
        try:
            async with asyncio.timeout(30):
                while not (tmp_path / "started").exists():
                    await asyncio.sleep(0.01)
            next_result.cancel()
            async with asyncio.timeout(5):
                while not shutdown.called:
                    await asyncio.sleep(0)
            assert not next_result.done()
            assert not (tmp_path / "exited").exists()
        finally:
            (tmp_path / "release").touch()
            if not shutdown.called:
                next_result.cancel()
            with pytest.raises(asyncio.CancelledError):
                await next_result
        assert (tmp_path / "exited").exists()
        shutdown.assert_called_once_with(wait=True, cancel_futures=True)

    asyncio.run(cancel_result_wait())
