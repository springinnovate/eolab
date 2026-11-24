"""Concurrent workers share durable admission without sharing native processes."""

import asyncio
from concurrent.futures import ProcessPoolExecutor
from dataclasses import replace
from multiprocessing import active_children, get_context
import os
from threading import Event
import time
from typing import Any
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
import pytest

from eolab_app.processing.job_store import PostgresJobStore
from eolab_app.processing.job_notifications import PostgresJobWakeup
from eolab_app.processing.models import (
    Artifact,
    PreparedJobPlan,
    ProcessingLimits,
    ProcessingError,
)
from eolab_app.processing.native_processes import create_native_process
from eolab_app.processing.worker import ProcessingWorker
from eolab_app.execution.reusable_process import ReusableProcess
from eolab_jobs.worker_claim import claim_next_job
from test_processing_jobs import boundary, store, HEADERS, _paused_clip, clip_inputs
from test_processing_calculations import ENDPOINT, request_body


def claim_from_process(
    arguments: tuple[str, ProcessingLimits, bool],
) -> dict[str, Any] | None:
    """Claim through an independent Python process and database connection.

    Args:
        arguments: Database address, shared limits and whether to call the shared
            claim directly instead of using the Processing adapter.

    Returns:
        The claimed row, or None when other processes consumed capacity.
    """
    dsn, limits, direct = arguments
    if direct:
        with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as connection:
            with connection.cursor() as cursor:
                return claim_next_job(
                    cursor,
                    worker_count=limits.worker_count,
                    lease_seconds=limits.lease_seconds,
                )
    jobs = PostgresJobStore(limits, dsn)
    try:
        jobs.open()
        return jobs.claim_next_job()
    finally:
        jobs.close()


def test_cross_process_claims_bound_worker_count_and_preserve_fairness(
    store: PostgresJobStore,
) -> None:
    """Independent claimers cannot overfill worker slots; new owners get a turn.

    Args:
        store: Disposable PostgreSQL queue.
    """
    store.limits = replace(store.limits, worker_count=2)
    for index in range(6):
        store.submit(
            "stack",
            str(index),
            PreparedJobPlan({}, {}, operation="test.v1"),
            str(index),
        )
    visitor = store.submit(
        "visitor", "first", PreparedJobPlan({}, {}, operation="test.v1"), "visitor"
    )
    with ProcessPoolExecutor(max_workers=4, mp_context=get_context("spawn")) as workers:
        claims = list(
            workers.map(
                claim_from_process,
                [
                    (store.conninfo, store.limits, direct)
                    for direct in (True, False) * 4
                ],
            )
        )
    active = [row for row in claims if row]
    assert len(active) == 2
    assert {row["owner"] for row in active} == {"stack", "visitor"}
    assert visitor["job_id"] in {row["id"] for row in active}
    # A full pool can answer even while the subscriber table is unavailable.
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "LOCK TABLE processing.job_subscribers IN ACCESS EXCLUSIVE MODE"
        )
        assert store.claim_next_job() is None
    # Cancellation and an expired heartbeat do not release native capacity.
    row = active[0]
    store.cancel(row["id"], row["owner"])
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET lease_until=now()-interval '1 second' WHERE id=%s",
            (row["id"],),
        )
    assert store.claim_next_job() is None
    assert store.finish(row["id"], row["attempt_id"], None)
    assert store.claim_next_job() is not None


def test_rolled_back_shared_claim_is_available_to_processing(
    store: PostgresJobStore,
) -> None:
    """Release the slot and fair turn when a caller rolls back its outer transaction.

    Args:
        store: Disposable PostgreSQL queue shared by both claim paths.
    """
    queued = store.submit(
        "owner", "request", PreparedJobPlan({}, {}, operation="test.v1"), "hash"
    )
    with psycopg.connect(
        store.conninfo, autocommit=True, row_factory=dict_row
    ) as connection:
        with connection.transaction(force_rollback=True), connection.cursor() as cursor:
            claim = claim_next_job(cursor, worker_count=1, lease_seconds=20)
            assert claim["id"] == queued["job_id"]
            # Earlier worker releases use this same database-wide lock key.
            with psycopg.connect(store.conninfo) as observer:
                assert observer.execute(
                    "SELECT pg_try_advisory_xact_lock(7610329)"
                ).fetchone() == (False,)
        turns = connection.execute("SELECT owner FROM processing.job_turns").fetchall()
        assert turns == []
    retried = store.claim_next_job()
    assert retried["id"] == claim["id"] and retried["attempt_id"] != claim["attempt_id"]


def test_prepared_job_keeps_its_attempt_without_disk_admission(
    store: PostgresJobStore,
) -> None:
    """Preparation keeps its running attempt until the worker publishes the result.

    Args:
        store: Disposable PostgreSQL queue with two worker slots.
    """
    store.limits = replace(store.limits, worker_count=2)
    for owner in ("first", "second"):
        store.submit(
            owner, "request", PreparedJobPlan({}, {}, operation="test.v1"), "hash"
        )
    first, second = store.claim_next_job(), store.claim_next_job()
    saved = store.save_prepared_job(
        second["id"],
        second["attempt_id"],
        PreparedJobPlan({"prepared": True}, {}, operation="test.v1"),
    )
    assert saved["status"] == "running" and saved["attempt_id"] == second["attempt_id"]
    assert saved["reserved_bytes"] == 0
    assert store.finish(
        first["id"], first["attempt_id"], Artifact(80, "0" * 64, "result")
    )
    assert store.finish(
        second["id"], second["attempt_id"], Artifact(90, "1" * 64, "result")
    )


def test_release_wakes_idle_workers_before_fallback(store: PostgresJobStore) -> None:
    """A committed completion wakes an already waiting worker immediately.

    Args:
        store: Disposable PostgreSQL queue.
    """
    store.submit("one", "one", PreparedJobPlan({}, {}, operation="test.v1"), "one")
    active = store.claim_next_job()
    store.submit("two", "two", PreparedJobPlan({}, {}, operation="test.v1"), "two")

    async def scenario() -> None:
        """Register, check occupied capacity, then await a real PostgreSQL hint."""
        wakeup = PostgresJobWakeup(store.conninfo)
        try:
            await wakeup.arm()
            assert store.claim_next_job() is None
            waiter = asyncio.create_task(wakeup.wait(10))
            await asyncio.to_thread(
                store.finish, active["id"], active["attempt_id"], None
            )
            assert await asyncio.wait_for(waiter, 1)
            assert store.claim_next_job() is not None
        finally:
            await wakeup.close()

    with asyncio.Runner(loop_factory=asyncio.SelectorEventLoop) as runner:
        runner.run(scenario())


@pytest.mark.parametrize("batch", [False, True])
def test_two_real_native_workers_execute_and_deduplicate(
    boundary: Any, store: PostgresJobStore, batch: bool
) -> None:
    """Distinct jobs use separate native children; matching requests use one job.

    Args:
        boundary: Real HTTP service, raster source and Processing worker dependencies.
        batch: Use one batch admission or independent legacy HTTP submissions.
        store: Disposable PostgreSQL queue.
    """
    client, template, _, _, _ = boundary
    store.limits = replace(store.limits, worker_count=2)
    payload = request_body()
    inputs = [
        {**payload, "requestId": uuid4().hex},
        {**payload, "requestId": uuid4().hex},
        {**request_body(wholeRaster=True), "requestId": uuid4().hex},
    ]
    if batch:
        response = client.post(
            ENDPOINT + "/batch", json={"items": inputs}, headers=HEADERS
        )
        assert response.status_code == 200, response.text
        first, duplicate, second = [item["job"] for item in response.json()["items"]]
    else:
        first, duplicate, second = [
            client.post(ENDPOINT, json=item, headers=HEADERS).json() for item in inputs
        ]

    async def scenario() -> None:
        """Use two native processes and inspect simultaneous durable claims."""
        natives = [create_native_process(store.limits) for _ in range(2)]
        workers = [
            ProcessingWorker(
                template.authorizer,
                store,
                template.artifacts,
                store.limits,
                native=native,
                areas=template.areas,
            )
            for native in natives
        ]
        try:
            for native in natives:
                native.warm()
            rows = [store.claim_next_job(), store.claim_next_job()]
            assert all(rows)
            assert store.claim_next_job() is None
            assert len({native.child.process.pid for native in natives}) == 2
            artifacts = await asyncio.gather(
                *(worker._execute(row) for worker, row in zip(workers, rows))
            )
            for row, artifact in zip(rows, artifacts):
                assert artifact is not None
                assert store.finish(row["id"], row["attempt_id"], artifact)
        finally:
            await asyncio.gather(*(native.close() for native in natives))

    asyncio.run(scenario())
    results = [
        client.get("/api/processing/jobs/" + job["jobId"]).json()
        for job in (first, duplicate, second)
    ]
    assert all(job["status"] == "ready" for job in results)
    assert results[0]["result"]["rows"] == results[1]["result"]["rows"]
    with psycopg.connect(store.conninfo) as connection:
        assert connection.execute(
            "SELECT count(*) FROM processing.jobs"
        ).fetchone() == (2,)


@pytest.mark.parametrize("stop", ["cancel", "kill"])
def test_stopping_one_native_child_does_not_stop_other_jobs(
    boundary: Any, store: PostgresJobStore, monkeypatch: pytest.MonkeyPatch, stop: str
) -> None:
    """Cancellation or child death affects one attempt while its peer completes.

    Args:
        boundary: Real HTTP, source and artifact providers.
        store: Disposable PostgreSQL queue.
        monkeypatch: Substitute a real clip target with a controlled pause.
        stop: Either cancel through HTTP or terminate one native child.
    """
    import eolab_app.processing.worker as worker_module

    client, template, _, artifacts, _ = boundary
    store.limits = replace(store.limits, worker_count=2)
    monkeypatch.setattr(
        "eolab_app.processing.raster_operations.clip_process_target", _paused_clip
    )
    payload = clip_inputs(client)
    jobs = [
        client.post(
            "/api/processing/raster-clips",
            json={
                **payload,
                "selectedBounds": {**payload["selectedBounds"], "west": west},
                "requestId": uuid4().hex,
            },
            headers=HEADERS,
        ).json()
        for west in (0.1, 0.2)
    ]

    async def scenario() -> None:
        """Stop one process only after both have started writing private output."""
        natives = [ReusableProcess((_paused_clip,)) for _ in range(2)]
        workers = [
            ProcessingWorker(
                template.authorizer,
                store,
                artifacts,
                store.limits,
                native=native,
                areas=template.areas,
            )
            for native in natives
        ]
        tasks = [asyncio.create_task(worker.run_once()) for worker in workers]
        try:
            async with asyncio.timeout(20):
                while len(list((artifacts.root / "attempts").glob("*/checkpoint"))) < 2:
                    await asyncio.sleep(0.02)
            if stop == "cancel":
                client.post(
                    f"/api/processing/jobs/{jobs[0]['jobId']}/cancel", headers=HEADERS
                )
            else:
                natives[0].child.process.kill()
            assert all(await asyncio.gather(*tasks))
            states = [
                client.get(f"/api/processing/jobs/{job['jobId']}").json()["status"]
                for job in jobs
            ]
            assert states.count("ready") == 1
            assert states.count("cancelled" if stop == "cancel" else "failed") == 1
            assert len(list((artifacts.root / "results").iterdir())) == 1
            assert store.claim_next_job() is None
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await asyncio.gather(*(native.close() for native in natives))

    asyncio.run(scenario())


def _wait_for_worker_cancellation(
    queue: Any, operation: str, arguments: tuple[Any, ...]
) -> None:
    """Keep a native clip alive until production supervision stops its process.

    Args:
        queue: Native result writer used for preparation requests.
        operation: Clip or preparation action selected by the operation adapter.
        arguments: Native source, specification, output directory and limits.
    """
    if operation == "plan":
        from eolab_app.processing.raster_clip import clip_process_target

        clip_process_target(queue, operation, arguments)
        return
    _, _, directory, _ = arguments
    (directory / "checkpoint").write_text(str(os.getpid()))
    while True:
        time.sleep(0.01)


@pytest.mark.parametrize(
    "pending_state", ["running", "cancelled", "committed", "replaced"]
)
def test_worker_retries_stopped_attempt_after_storage_recovers(
    boundary: Any,
    store: PostgresJobStore,
    monkeypatch: pytest.MonkeyPatch,
    pending_state: str,
) -> None:
    """Recover a stopped native job without reclaiming live or superseded attempts.

    Args:
        boundary: Real HTTP, source, artifact and worker providers.
        store: Disposable PostgreSQL queue with one execution slot.
        monkeypatch: Inject only native waiting and transient storage-call failures.
        pending_state: Keep the attempt running, cancel it, lose a committed write's
            response, or replace its token before retrying the acknowledgement.
    """
    import eolab_app.processing.raster_operations as operations

    client, worker, _, artifacts, _ = boundary
    original_target = operations.clip_process_target
    monkeypatch.setattr(
        operations, "clip_process_target", _wait_for_worker_cancellation
    )
    payload = clip_inputs(client)
    jobs = []
    for west in (0.1, 0.2):
        response = client.post(
            "/api/processing/raster-clips",
            json={
                **payload,
                "selectedBounds": {**payload["selectedBounds"], "west": west},
                "requestId": uuid4().hex,
            },
            headers=HEADERS,
        )
        assert response.status_code == 202, response.text
        jobs.append(response.json())
    heartbeat, finish = store.heartbeat, store.finish
    unavailable = Event()
    allow_heartbeat_failure = Event()
    finish_calls: list[tuple[str, str]] = []

    def fail_heartbeat(identifier: str, attempt: str, progress: dict[str, Any]) -> bool:
        """Fail heartbeats after the test has observed a live native child.

        Args:
            identifier: Claimed computation ID.
            attempt: Current execution token.
            progress: Operation-owned progress snapshot.

        Returns:
            Whether the real database still permits execution.

        Raises:
            ProcessingError: While the injected storage outage is active.
            TimeoutError: If the test does not release the controlled heartbeat.
        """
        if unavailable.is_set():
            if not allow_heartbeat_failure.wait(30):
                raise TimeoutError("Test did not release the heartbeat failure")
            raise ProcessingError(
                "processing_unavailable", "Temporary storage failure", 503
            )
        return heartbeat(identifier, attempt, progress)

    def fail_finish(
        identifier: str,
        attempt: str,
        artifact: Artifact | None,
        error: dict[str, str] | None = None,
        reusable_results: dict[str, dict[str, object]] | None = None,
    ) -> bool:
        """Fail terminal writes until recovery, optionally losing a committed response.

        Args:
            identifier: Stopped computation ID.
            attempt: Exact execution token whose exit is being acknowledged.
            artifact: Completed result, or None for the stopped operation.
            error: Sanitized failure supplied by production supervision.
            reusable_results: Optional scalar results to publish atomically.

        Returns:
            The real database's fenced transition result after recovery.

        Raises:
            ProcessingError: While the injected storage outage is active.
        """
        finish_calls.append((identifier, attempt))
        if unavailable.is_set():
            if pending_state == "committed" and len(finish_calls) == 1:
                assert finish(identifier, attempt, artifact, error, reusable_results)
            raise ProcessingError(
                "processing_unavailable", "Temporary storage failure", 503
            )
        return finish(identifier, attempt, artifact, error, reusable_results)

    monkeypatch.setattr(store, "heartbeat", fail_heartbeat)
    monkeypatch.setattr(store, "finish", fail_finish)

    async def scenario() -> None:
        """Observe native exit, durable retention, repeated failure and fenced recovery."""
        task = asyncio.create_task(worker.run_once())
        try:
            async with asyncio.timeout(30):
                while not list((artifacts.root / "attempts").glob("*/checkpoint")):
                    if task.done():
                        await task
                        pytest.fail("Worker stopped before the native checkpoint")
                    await asyncio.sleep(0.02)
            checkpoint = next((artifacts.root / "attempts").glob("*/checkpoint"))
            native_pid = int(checkpoint.read_text())
            assert native_pid in {child.pid for child in active_children()}
            assert store.claim_next_job() is None
            # Hold the failing heartbeat until the live-child checks are complete.
            unavailable.set()
            # Expired leases and cleanup cannot release an executing native child.
            with psycopg.connect(store.conninfo) as connection:
                connection.execute(
                    "UPDATE processing.jobs SET lease_until=now()-interval '1 minute' "
                    "WHERE attempt_id=%s",
                    (checkpoint.parent.name,),
                )
            await worker.cleanup()
            assert checkpoint.exists()
            assert native_pid in {child.pid for child in active_children()}
            assert store.claim_next_job() is None
            allow_heartbeat_failure.set()
            with pytest.raises(ProcessingError, match="Temporary storage failure"):
                await asyncio.wait_for(task, 30)
            assert native_pid not in {child.pid for child in active_children()}
            assert len(finish_calls) == 2
            identifier, attempt = finish_calls[0]
            assert finish_calls[1] == (identifier, attempt)
            assert attempt == checkpoint.parent.name
            if pending_state == "cancelled":
                response = client.post(
                    f"/api/processing/jobs/{jobs[0]['jobId']}/cancel", headers=HEADERS
                )
                assert response.json()["status"] == "cancelling"
            elif pending_state == "replaced":
                replacement_attempt = uuid4().hex
                with psycopg.connect(store.conninfo) as connection:
                    connection.execute(
                        "UPDATE processing.jobs SET attempt_id=%s WHERE id=%s",
                        (replacement_attempt, identifier),
                    )
            # More than the two immediate writes can fail without losing the retry.
            with pytest.raises(ProcessingError, match="Temporary storage failure"):
                await worker.run_once()
            assert len(finish_calls) == 3
            if pending_state in {"running", "cancelled"}:
                await worker.cleanup()
                assert checkpoint.exists()
                assert store.claim_next_job() is None
            assert (
                client.get(f"/api/processing/jobs/{jobs[1]['jobId']}").json()["status"]
                == "queued"
            )
            unavailable.clear()
            monkeypatch.setattr(operations, "clip_process_target", original_target)
            if pending_state == "replaced":
                assert not await worker.run_once()
                with psycopg.connect(store.conninfo) as connection:
                    assert connection.execute(
                        "SELECT status,attempt_id FROM processing.jobs WHERE id=%s",
                        (identifier,),
                    ).fetchone() == ("running", replacement_attempt)
                assert finish(identifier, replacement_attempt, None)
            assert await worker.run_once()
            statuses = [
                client.get(f"/api/processing/jobs/{job['jobId']}").json()["status"]
                for job in jobs
            ]
            expected = {
                "running": "interrupted",
                "cancelled": "cancelled",
                "committed": "failed",
                "replaced": "failed",
            }
            assert statuses == [expected[pending_state], "ready"]
            assert finish_calls[:4] == [(identifier, attempt)] * 4
            completed_calls = len(finish_calls)
            if pending_state == "replaced":
                # Superseded files use the existing orphan-cleanup grace period.
                os.utime(checkpoint.parent, (0, 0))
            await worker.cleanup()
            assert not checkpoint.exists()
            assert not await worker.run_once()
            assert len(finish_calls) == completed_calls
        finally:
            allow_heartbeat_failure.set()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())
