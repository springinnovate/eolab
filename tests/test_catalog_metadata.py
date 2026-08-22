"""Test the catalog metadata worker boundary."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from eolab_app.catalog.metadata import MetadataPipeline, build_dataset_metadata
from eolab_app.catalog.models import DatasetCandidate


def test_unknown_dataset_builder_is_captured_as_a_dataset_failure(
    tmp_path: Path,
) -> None:
    """Keep dispatch failures local to one metadata result."""
    dataset_path = tmp_path / "unknown.bin"
    dataset_path.touch()

    result = build_dataset_metadata(
        tmp_path,
        DatasetCandidate(dataset_path),
    )

    assert result.item is None
    assert result.error == "'.bin'"
    assert result.elapsed_seconds >= result.processing_seconds >= 0


def test_metadata_pipeline_owns_bounded_worker_completion() -> None:
    """An empty workload starts and shuts down every configured worker."""
    async def collect_results() -> list[object]:
        pipeline = MetadataPipeline(
            Path("/scan-source"),
            worker_count=2,
            result_queue_size=2,
            executor_factory=ThreadPoolExecutor,
        )
        return [result async for result in pipeline.results([])]

    import asyncio

    assert asyncio.run(collect_results()) == []
