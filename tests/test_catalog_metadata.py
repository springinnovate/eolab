"""Test the catalog metadata worker boundary."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from eolab_app.catalog.handlers import (
    DatasetHandler,
    DatasetHandlerRegistry,
    HandlerDiscovery,
    create_default_dataset_handler_registry,
)
from eolab_app.catalog.metadata import MetadataPipeline, build_dataset_metadata
from eolab_app.catalog.models import DatasetCandidate


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
    async def collect_results() -> list[object]:
        pipeline = MetadataPipeline(
            Path("/scan-source"),
            worker_count=2,
            result_queue_size=2,
            dataset_handlers=create_default_dataset_handler_registry(),
            executor_factory=ThreadPoolExecutor,
        )
        return [result async for result in pipeline.results([])]

    import asyncio

    assert asyncio.run(collect_results()) == []
