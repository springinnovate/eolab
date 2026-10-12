"""Concurrent workers share durable admission without sharing native processes."""

import asyncio
from concurrent.futures import ProcessPoolExecutor
from dataclasses import replace
from multiprocessing import get_context
from typing import Any
from uuid import uuid4

import psycopg
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
from test_processing_jobs import boundary, store, HEADERS, _paused_clip, clip_inputs
from test_processing_calculations import ENDPOINT, request_body


def claim_from_process(
    arguments: tuple[str, ProcessingLimits],
) -> dict[str, Any] | None:
    """Claim through an independent Python process and database connection.

    Args:
        arguments: Disposable database address and common capacity settings.

    Returns:
        The claimed row, or None when other processes consumed capacity.
    """
    dsn, limits = arguments
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
        store.submit("stack", str(index), PreparedJobPlan({}, {}, 0), str(index))
    visitor = store.submit("visitor", "first", PreparedJobPlan({}, {}, 0), "visitor")
    with ProcessPoolExecutor(max_workers=4, mp_context=get_context("spawn")) as workers:
        claims = list(
            workers.map(claim_from_process, [(store.conninfo, store.limits)] * 8)
        )
    active = [row for row in claims if row]
    assert len(active) == 2
    assert {row["owner"] for row in active} == {"stack", "visitor"}
    assert visitor["job_id"] in {row["id"] for row in active}
    assert all(
        row["execution_memory_bytes"] == 0 and row["deadline_at"] is None
        for row in active
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


def test_prepared_job_keeps_its_attempt_without_disk_admission(
    store: PostgresJobStore,
) -> None:
    """Preparation keeps its worker slot and attempt regardless of old reservation metadata.

    Args:
        store: Disposable PostgreSQL queue with two worker slots.
    """
    store.limits = replace(store.limits, worker_count=2)
    for owner in ("first", "second"):
        store.submit(owner, "request", PreparedJobPlan({}, {}, 0), "hash")
    first, second = store.claim_next_job(), store.claim_next_job()
    saved = store.save_prepared_job(
        second["id"],
        second["attempt_id"],
        PreparedJobPlan({"prepared": True}, {}, 2**40),
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
    store.submit("one", "one", PreparedJobPlan({}, {}, 0), "one")
    active = store.claim_next_job()
    store.submit("two", "two", PreparedJobPlan({}, {}, 0), "two")

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
