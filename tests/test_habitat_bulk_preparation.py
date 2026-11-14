"""Exercise durable Habitat bulk checks and ordinary child-job admission."""

import asyncio
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from eolab_app.attribute_filter import VectorFilter
from eolab_app.catalog_selection import CatalogSelection, SelectionUnavailableError
from eolab_app.execution.reusable_process import ReusableProcess
from eolab_app.processing import habitat_bulk_preparation as bulk
from eolab_app.processing import habitat_preparation
from eolab_app.processing.aggregate_models import RasterAggregateLimits
from eolab_app.processing.artifacts import LocalJobArtifacts
from eolab_app.processing.clip_models import RasterClipLimits
from eolab_app.processing.habitat_earth_engine import (
    HabitatCacheCoverage,
    HabitatEarthEngineRuntime,
    HabitatEarthEngineSettings,
)
from eolab_app.processing.habitat_preparation_models import (
    BULK_OPERATION,
    HABITAT_PREPARATION_OWNER,
    OPERATION,
    HabitatBulkPreparationInputs,
    HabitatBulkPreparationReport,
    HabitatBulkPreparationSpec,
    HabitatInputPreparationRequest,
    QueuedHabitatBulkPreparation,
)
from eolab_app.processing.model_operations import get_model_operation
from eolab_app.processing.model_yaml import encode_canonical_json
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.operation_context import OperationContext
from eolab_app.processing.worker import ProcessingWorker
from test_processing_worker_results import configure_prepared_job_store


def _request(number: int) -> HabitatInputPreparationRequest:
    """Create one distinct named Catalog selection and stable child command.

    Args:
        number: Distinguishing source and request identifier.

    Returns:
        Ordinary valid preparation request for the same assessment year.
    """
    return HabitatInputPreparationRequest(
        requestId=f"bulk-child-{number:016x}",
        name=f"Area {number}",
        selection=CatalogSelection(
            collectionId="eolab-mounted-vectors",
            itemId=f"area-{number}",
            assetKey="data",
            layerName="polygons",
            filter=VectorFilter(),
        ),
        year=2018,
    )


def _context(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> OperationContext:
    """Connect the operation to observable storage and authorized-source boundaries.

    Args:
        tmp_path: Private runtime cache and credential fixture paths.
        monkeypatch: Replace only scientific configuration loading with a fixed digest.

    Returns:
        Existing worker context whose store and source reader record interactions.
    """
    store = Mock()
    store.find_request.return_value = None
    store.list_session_jobs_page.return_value = []
    store.submit.side_effect = lambda owner, key, plan, checksum: {
        "id": hashlib.md5(key.encode(), usedforsecurity=False).hexdigest()
    }
    monkeypatch.setattr(
        habitat_preparation,
        "load_habitat_stack",
        lambda year: SimpleNamespace(raster_configuration_sha256="c" * 64),
    )
    runtime = HabitatEarthEngineRuntime(
        HabitatEarthEngineSettings("project", tmp_path / "credentials.json"),
        tmp_path / "cache",
    )
    limits = RasterClipLimits()
    return OperationContext(
        jobs=store,
        areas=SimpleNamespace(resolve_for_sampling=AsyncMock()),
        limits=limits,
        aggregate_limits=RasterAggregateLimits.with_lifecycle(limits),
        native=None,
        run_native=AsyncMock(),
        reuse_results=False,
        report_progress=AsyncMock(),
        operation_settings={BULK_OPERATION: runtime},
    )


def _queued(*requests: HabitatInputPreparationRequest) -> QueuedHabitatBulkPreparation:
    """Capture ordinary requests in one durable administrator command.

    Args:
        requests: Distinct saved areas chosen by the admission boundary.

    Returns:
        Bulk operation's immutable queued specification.
    """
    return QueuedHabitatBulkPreparation(
        request=HabitatBulkPreparationInputs(
            requestId="bulk-command-123456", areas=requests
        )
    )


def test_bulk_checks_all_active_history_and_queues_more_than_fifty_areas(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Use all history pages, skip active/cached areas, and continue after source errors.

    Args:
        tmp_path: Isolated server-only paths.
        monkeypatch: Controlled source and cache boundaries.
    """
    context = _context(tmp_path, monkeypatch)
    requests = tuple(_request(number) for number in range(61))
    now = datetime.now(timezone.utc)
    older = {"status": "failed", "created_at": now, "id": "f" * 32}
    active_plan = habitat_preparation.build_habitat_input_preparation_submission(
        requests[0]
    )
    active = {
        "status": "running",
        "retained_metadata": active_plan.retained_metadata,
        "metadata_expires_at": None,
        "created_at": now,
        "id": "a" * 32,
    }
    context.jobs.list_session_jobs_page.side_effect = [[older] * 100, [active]]

    async def coverage(
        selection: CatalogSelection, year: int, reader: Any, cache: Path
    ) -> HabitatCacheCoverage:
        """Authorize the selected source and return its controlled coverage or failure.

        Args:
            selection: Saved Catalog polygon descriptor.
            year: Assessment year passed by the operation.
            reader: Existing source authorization boundary.
            cache: Server-controlled cache directory.

        Returns:
            Complete cached coverage for area one and missing coverage otherwise.

        Raises:
            SelectionUnavailableError: For the unavailable third source.
        """
        assert reader is context.areas
        await reader.resolve_for_sampling(selection)
        if selection.item_id == "area-2":
            raise SelectionUnavailableError("This saved polygon layer is unavailable.")
        missing = 0 if selection.item_id == "area-1" else 90
        return HabitatCacheCoverage("c" * 64, year, 90, 90 - missing, missing)

    monkeypatch.setattr(bulk, "get_habitat_cache_coverage", coverage)
    prepared = asyncio.run(
        bulk.prepare_habitat_bulk_preparation(context, _queued(*requests), None)
    )
    report = HabitatBulkPreparationSpec.model_validate(prepared.specification).report
    assert (
        report.areaCount,
        report.queuedCount,
        report.cachedCount,
        report.activeCount,
        report.failedCount,
    ) == (61, 58, 1, 1, 1)
    assert [row.status for row in report.outcomes[:4]] == [
        "active",
        "cached",
        "failed",
        "queued",
    ]
    assert report.outcomes[2].detail == "This saved polygon layer is unavailable."
    assert context.jobs.list_session_jobs_page.call_args_list[1].args == (
        HABITAT_PREPARATION_OWNER,
        (OPERATION,),
        100,
        (now, "f" * 32),
    )
    assert context.jobs.submit.call_count == 58
    for call in context.jobs.submit.call_args_list:
        owner, request_id, plan, request_hash = call.args
        assert owner == HABITAT_PREPARATION_OWNER
        assert plan.operation == OPERATION
        assert plan.summary["configurationSha256"] == "c" * 64
        assert len(request_hash) == 64
    assert prepared.retained_metadata == {"inputs": {"areaCount": 61}}
    assert [call.args[0] for call in context.report_progress.await_args_list] == [
        {
            "phase": "checking_habitat_areas",
            "completed": completed,
            "total": 61,
            "unit": "areas",
        }
        for completed in range(62)
    ]


def test_bulk_recovers_child_before_rechecking_changed_sources(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Reuse an accepted child command even after its source becomes unavailable.

    Args:
        tmp_path: Isolated server-only paths.
        monkeypatch: Reject any cache or source access after command recovery.
    """
    context = _context(tmp_path, monkeypatch)
    request = _request(1)
    checksum = hashlib.sha256(
        encode_canonical_json(request.model_dump(mode="json", exclude={"requestId"}))
    ).hexdigest()
    context.jobs.find_request.return_value = {
        "id": "d" * 32,
        "operation": OPERATION,
        "request_hash": checksum,
    }
    coverage = AsyncMock(
        side_effect=AssertionError("Recovery must precede source reads")
    )
    monkeypatch.setattr(bulk, "get_habitat_cache_coverage", coverage)
    prepared = asyncio.run(
        bulk.prepare_habitat_bulk_preparation(context, _queued(request), None)
    )
    report = HabitatBulkPreparationSpec.model_validate(prepared.specification).report
    assert report.queuedCount == 1 and report.outcomes[0].jobId == "d" * 32
    coverage.assert_not_awaited()
    context.jobs.submit.assert_not_called()


@pytest.mark.parametrize(
    "failure",
    [
        ProcessingError("denied", "Source access denied.", 403),
        ValueError("private/config/path"),
        OSError("private/cache/path"),
    ],
)
def test_bulk_records_one_admission_failure_and_continues(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: Exception
) -> None:
    """Keep public errors path-free and admit later areas after one failure.

    Args:
        tmp_path: Isolated server-only paths.
        monkeypatch: Controlled coverage and admission boundaries.
        failure: Safe application failure or raw external failure to sanitize.
    """
    context = _context(tmp_path, monkeypatch)
    monkeypatch.setattr(
        bulk,
        "get_habitat_cache_coverage",
        AsyncMock(return_value=HabitatCacheCoverage("c" * 64, 2018, 1, 0, 1)),
    )
    context.jobs.submit.side_effect = [failure, {"id": "e" * 32}]
    prepared = asyncio.run(
        bulk.prepare_habitat_bulk_preparation(
            context, _queued(_request(1), _request(2)), None
        )
    )
    report = HabitatBulkPreparationSpec.model_validate(prepared.specification).report
    assert (report.failedCount, report.queuedCount) == (1, 1)
    assert "private" not in report.model_dump_json()
    assert report.outcomes[1].jobId == "e" * 32


def test_cancellation_stops_remaining_checks_but_keeps_accepted_children(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Stop bulk planning without cancelling a child accepted before the stop.

    Args:
        tmp_path: Isolated server-only paths.
        monkeypatch: Hold the second coverage read until its cancellation.
    """
    context = _context(tmp_path, monkeypatch)

    async def run() -> None:
        """Cancel while the second area is being checked and observe its cleanup."""
        started, stopped = asyncio.Event(), asyncio.Event()

        async def coverage(
            selection: CatalogSelection, year: int, reader: Any, cache: Path
        ) -> HabitatCacheCoverage:
            """Complete the first read and retain the second until it is cancelled.

            Args:
                selection: Area being checked.
                year: Requested assessment year.
                reader: Unused controlled source reader.
                cache: Unused private cache path.

            Returns:
                Missing coverage for the first area.

            Raises:
                asyncio.CancelledError: For the second area after cleanup is marked.
            """
            if selection.item_id == "area-1":
                return HabitatCacheCoverage("c" * 64, year, 1, 0, 1)
            started.set()
            try:
                await asyncio.Future()
            finally:
                stopped.set()

        monkeypatch.setattr(bulk, "get_habitat_cache_coverage", coverage)
        task = asyncio.create_task(
            bulk.prepare_habitat_bulk_preparation(
                context, _queued(_request(1), _request(2), _request(3)), None
            )
        )
        await asyncio.wait_for(started.wait(), timeout=5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert stopped.is_set()
        assert context.jobs.submit.call_count == 1
        context.jobs.cancel.assert_not_called()

    asyncio.run(run())


def test_empty_scope_finishes_without_source_or_runtime_access(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Publish a useful empty receipt without requiring an available source reader.

    Args:
        tmp_path: Isolated fixture paths.
        monkeypatch: Scientific configuration fixture.
    """
    context = _context(tmp_path, monkeypatch)
    context = OperationContext(
        context.jobs,
        None,
        context.limits,
        context.aggregate_limits,
        None,
        context.run_native,
        False,
        report_progress=context.report_progress,
    )
    prepared = asyncio.run(
        bulk.prepare_habitat_bulk_preparation(context, _queued(), None)
    )
    report = HabitatBulkPreparationSpec.model_validate(prepared.specification).report
    assert report.areaCount == report.queuedCount == report.failedCount == 0
    context.jobs.list_session_jobs_page.assert_not_called()
    context.jobs.submit.assert_not_called()
    context.report_progress.assert_awaited_once_with(
        {"phase": "checking_habitat_areas", "completed": 0, "total": 0, "unit": "areas"}
    )


def test_cancellation_waits_for_inflight_child_admission(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Retain the worker slot until an already dispatched database admission settles.

    Args:
        tmp_path: Isolated server-only paths.
        monkeypatch: Complete coverage immediately and block the first admission.
    """
    context = _context(tmp_path, monkeypatch)
    monkeypatch.setattr(
        bulk,
        "get_habitat_cache_coverage",
        AsyncMock(return_value=HabitatCacheCoverage("c" * 64, 2018, 1, 0, 1)),
    )

    async def run() -> None:
        """Cancel twice while a database thread is committing the first child."""
        started, release, accepted = asyncio.Event(), Event(), []
        loop = asyncio.get_running_loop()

        def submit(owner: str, key: str, plan: Any, checksum: str) -> dict[str, str]:
            """Simulate a database transaction that commits after cancellation arrives.

            Args:
                owner: Fixed administrator scope.
                key: Stable child command identifier.
                plan: Ordinary preparation plan.
                checksum: Canonical ordinary request identity.

            Returns:
                The accepted child's identifier after recording its commit.

            Raises:
                RuntimeError: If the test fails to release the blocked transaction.
            """
            loop.call_soon_threadsafe(started.set)
            if not release.wait(5):
                raise RuntimeError("Test did not release admission")
            accepted.append(key)
            return {"id": "a" * 32}

        context.jobs.submit.side_effect = submit
        task = asyncio.create_task(
            bulk.prepare_habitat_bulk_preparation(
                context, _queued(_request(1), _request(2)), None
            )
        )
        try:
            await asyncio.wait_for(started.wait(), timeout=5)
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert accepted == [_request(1).requestId]
        assert context.jobs.submit.call_count == 1
        context.jobs.cancel.assert_not_called()
        context.report_progress.assert_awaited_once_with(
            {
                "phase": "checking_habitat_areas",
                "completed": 0,
                "total": 2,
                "unit": "areas",
            }
        )

    asyncio.run(run())


@pytest.mark.parametrize("stop_after", [None, 0, 1])
def test_registered_worker_reports_checks_and_obeys_its_attempt_lease(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stop_after: int | None
) -> None:
    """Report every check through the worker and stop further work after lease loss.

    Args:
        tmp_path: Isolated normal artifact storage and runtime paths.
        monkeypatch: Controlled source/cache boundaries; native report writer remains real.
        stop_after: Check count at which the store rejects this attempt, or None.
    """
    context = _context(tmp_path, monkeypatch)
    monkeypatch.setattr(
        bulk,
        "get_habitat_cache_coverage",
        AsyncMock(return_value=HabitatCacheCoverage("c" * 64, 2018, 1, 0, 1)),
    )
    queued = _queued(_request(1), _request(2))
    plan = bulk.build_habitat_bulk_preparation_submission(queued.request)
    now = datetime.now(timezone.utc)
    row = {
        "id": "a" * 32,
        "attempt_id": "b" * 32,
        "input_uploads": {},
        "operation": BULK_OPERATION,
        "spec": plan.specification,
        "summary": plan.summary,
        "retained_metadata": plan.retained_metadata,
        "reserved_bytes": 0,
        "created_at": now,
        "updated_at": now,
        "expires_at": now + timedelta(hours=1),
        "status": "running",
        "progress": {},
        "error": None,
    }
    store = context.jobs
    configure_prepared_job_store(store, row)
    store.claim_next_job.return_value = row
    store.heartbeat.return_value = store.finish.return_value = True
    snapshots: list[dict[str, Any]] = []

    def heartbeat(identifier: str, attempt: str, progress: dict[str, Any]) -> bool:
        """Record operation checkpoints and emulate a cancelled or expired lease.

        Args:
            identifier: Claimed job identifier supplied by the worker.
            attempt: Current attempt token supplied by the worker.
            progress: Supervisor heartbeat or operation-owned progress snapshot.

        Returns:
            Whether the attempt may continue, including empty supervisor heartbeats.
        """
        assert (identifier, attempt) == (row["id"], row["attempt_id"])
        if progress.get("unit") == "areas":
            snapshots.append(progress)
            return progress["completed"] != stop_after
        return True

    store.heartbeat.side_effect = heartbeat
    artifacts = LocalJobArtifacts(tmp_path / "artifacts")
    artifacts.initialize()
    native = ReusableProcess(
        (bulk.habitat_bulk_preparation_process_target,), recycle_bytes=1024**3
    )
    worker = ProcessingWorker(
        Mock(),
        store,
        artifacts,
        context.limits,
        native=native,
        areas=context.areas,
        operation_settings=context.operation_settings,
    )

    async def run() -> None:
        """Execute the registered worker and release its supervised native process."""
        try:
            assert await worker.run_once()
        finally:
            await native.close()

    asyncio.run(run())
    last = 2 if stop_after is None else stop_after
    assert snapshots == [
        {
            "phase": "checking_habitat_areas",
            "completed": count,
            "total": 2,
            "unit": "areas",
        }
        for count in range(last + 1)
    ]
    if stop_after is not None:
        assert store.submit.call_count == stop_after
        assert store.finish.call_args.args[2] is None
        assert store.finish.call_args.args[3]["code"] == "interrupted"
        store.cancel.assert_not_called()
        return
    artifact = store.finish.call_args.args[2]
    assert artifact.queued_count == 2 and artifact.failed_count == 0
    report = HabitatBulkPreparationReport.model_validate_json(
        artifacts.result_path(row["attempt_id"], result_name="result.json").read_text()
    )
    assert report.queuedCount == 2 and len(report.outcomes) == 2
    assert store.submit.call_count == 2
    store.get.assert_not_called()
    store.cancel.assert_not_called()
    operation = get_model_operation(BULK_OPERATION)
    assert operation.output.kind == "report" and operation.reusable is None
    assert (
        bulk.describe_habitat_bulk_preparation_outcome(
            {
                "area_count": 1,
                "queued_count": 1,
                "cached_count": 0,
                "active_count": 0,
                "failed_count": 0,
            }
        )["queuedCount"]
        == 1
    )
