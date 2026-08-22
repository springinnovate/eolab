"""Test the extensible dataset-handler pipeline as one catalog workflow."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from eolab_app.catalog.handlers import (
    DatasetHandler,
    DatasetHandlerRegistry,
    DatasetMatch,
    HandlerDiscovery,
)
from eolab_app.catalog.metadata import MetadataPipeline
from eolab_app.catalog.models import DatasetCandidate
from eolab_app.catalog.scanner import ScanManager
from tests.catalog_support import RecordingCatalogDatabase, RecordingCatalogWriter


def discover_cardinality_sources(
    directory_path: Path,
    directory_names: tuple[str, ...],
    file_names: tuple[str, ...],
) -> HandlerDiscovery:
    """Recognize every test `.source` file as one logical dataset.

    Args:
        directory_path: Directory containing the listed entries.
        directory_names: Sorted child directory names, unused by this handler.
        file_names: Sorted child file names.

    Returns:
        Test source matches without directory pruning.
    """
    del directory_names
    return HandlerDiscovery(matches=tuple(
        DatasetMatch(directory_path / file_name)
        for file_name in file_names
        if Path(file_name).suffix == ".source"
    ))


def build_cardinality_items(
    source_root: Path,
    candidate: DatasetCandidate,
) -> tuple[dict[str, Any], ...]:
    """Emit zero, one, or three Items, or fail, based on the source stem.

    Args:
        source_root: Root directory mounted for scanning.
        candidate: Test source selected during discovery.

    Returns:
        Cardinality requested by the candidate stem.

    Raises:
        ValueError: If the candidate represents the isolated failure case.
    """
    del source_root
    if candidate.path.stem == "failed":
        raise ValueError("candidate metadata failed")
    item_count = {"zero": 0, "one": 1, "multiple": 3}[candidate.path.stem]
    return tuple({
        "id": f"{candidate.path.stem}-{item_index}",
        "collection": "eolab-mounted-vectors",
        "geometry": {"type": "Point", "coordinates": [item_index, 0]},
    } for item_index in range(item_count))


def test_mixed_handler_results_preserve_source_progress_and_item_batching(
    tmp_path: Path,
) -> None:
    """Process mixed sources while batching every emitted Item independently.

    Args:
        tmp_path: Isolated mounted source root.
    """
    for source_name in (
        "zero.source",
        "one.source",
        "multiple.source",
        "failed.source",
    ):
        (tmp_path / source_name).touch()
    registry = DatasetHandlerRegistry(handlers=(DatasetHandler(
        name="cardinality",
        discover=discover_cardinality_sources,
        build_items=build_cardinality_items,
    ),))
    metadata_pipeline = MetadataPipeline(
        tmp_path,
        worker_count=2,
        result_queue_size=4,
        dataset_handlers=registry,
        executor_factory=ThreadPoolExecutor,
    )
    catalog_writer = RecordingCatalogWriter()
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogDatabase(catalog_writer),
        2,
        1,
        2,
        dataset_handlers=registry,
        metadata_pipeline=metadata_pipeline,
    )

    async def run_scan() -> dict[str, Any]:
        """Run the manager to a terminal state.

        Returns:
            Final public scan status.
        """
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["state"] == "completed"
    assert status["sourceDatasetsDiscovered"] == 4
    assert status["sourceDatasetsProcessed"] == 4
    assert status["catalogItemsProduced"] == 4
    assert status["catalogItemsWritten"] == 4
    assert status["failed"] == 1
    assert status["errors"] == [{
        "path": "failed.source",
        "error": "candidate metadata failed",
    }]
    assert sorted(
        len(item_batch)
        for item_batch in catalog_writer.write_session.item_batches
    ) == [2, 2]
    assert {
        item["id"]
        for item in catalog_writer.write_session.items.values()
    } == {"one-0", "multiple-0", "multiple-1", "multiple-2"}
