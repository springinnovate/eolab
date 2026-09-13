"""Client lifecycle tests against the real Jobs HTTP app and diagnostic runner."""

import asyncio
import hashlib
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from uuid import uuid4

import httpx2
import pytest

from eolab_jobs.client import JobsClient, JobFailed, MAX_RESPONSE_BYTES, TERMINAL
from job_service.app import create_app
from job_service.configuration import Settings

TOKEN = "client-test-" + "a" * 40
OTHER_TOKEN = "client-test-" + "b" * 40
PAYLOAD = {"operation": "diagnostic.v1", "inputs": {"value": "hello"}}


def test_client_rejects_invalid_requests_before_transport() -> None:
    """Invalid resource paths, keys and oversized inputs never reach HTTP."""

    async def scenario() -> None:
        """Exercise public input boundaries while keeping transport idle."""
        calls = []
        async with httpx2.AsyncClient(
            transport=httpx2.MockTransport(lambda r: calls.append(r))
        ) as http:
            jobs = JobsClient(http, TOKEN)
            for action in (jobs.status, jobs.result, jobs.cancel, jobs.delete):
                with pytest.raises(ValueError):
                    await action("../health")
            with pytest.raises(ValueError):
                await jobs.submit(PAYLOAD, idempotency_key="bad key")
            with pytest.raises(ValueError, match="Oversized"):
                await jobs.submit(
                    {"operation": "diagnostic.v1", "inputs": {"value": "x" * 65536}},
                    idempotency_key="large",
                )
            with pytest.raises(ValueError, match="finite"):
                await jobs.run(
                    PAYLOAD, timeout_seconds=float("inf"), delete_on_completion=True
                )
            assert not calls

    asyncio.run(scenario())


def test_cleanup_outage_is_bounded(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An unavailable cancellation cannot hide the original client deadline.

    Args:
        caplog: Captures the safe cleanup warning.
        monkeypatch: Shortens the module's cleanup deadline for this outage test.
    """
    monkeypatch.setattr("eolab_jobs.client.CLEANUP_SECONDS", 0.05)

    async def scenario() -> None:
        """Simulate hung cleanup through HTTP and assert no cleanup survives."""
        job_id = str(uuid4())
        cleanup_exited = asyncio.Event()

        async def respond(request: httpx2.Request) -> httpx2.Response:
            """Return running state but leave cancellation unresponsive.

            Args:
                request: Outbound lifecycle request.

            Returns:
                Running snapshot for non-cancellation requests.
            """
            if request.url.path.endswith("/cancel"):
                try:
                    await asyncio.Event().wait()
                finally:
                    cleanup_exited.set()
            return httpx2.Response(200, json={"jobId": job_id, "status": "running"})

        async with httpx2.AsyncClient(transport=httpx2.MockTransport(respond)) as http:
            jobs = JobsClient(http, TOKEN)
            async with asyncio.timeout(1):
                with pytest.raises(TimeoutError):
                    await jobs.run(
                        PAYLOAD, timeout_seconds=0.05, delete_on_completion=True
                    )
            assert cleanup_exited.is_set()

    asyncio.run(scenario())
    assert "server deadlines/retention remain active" in caplog.text
    assert TOKEN not in caplog.text


@asynccontextmanager
async def diagnostic_client() -> AsyncIterator[tuple[JobsClient, httpx2.AsyncClient]]:
    """Run the actual HTTP lifecycle and native executor with isolated callers.

    Yields:
        Authenticated reusable client and its transport for public API assertions.
    """
    service = create_app(
        Settings(
            callers={
                "alice": hashlib.sha256(TOKEN.encode()).hexdigest(),
                "bob": hashlib.sha256(OTHER_TOKEN.encode()).hexdigest(),
            }
        )
    )
    async with service.router.lifespan_context(service):
        async with httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=service),
            timeout=5,
        ) as http:
            yield JobsClient(http, TOKEN), http


async def retained_jobs(http: httpx2.AsyncClient) -> list[dict[str, Any]]:
    """Read caller-owned records through the public API.

    Args:
        http: Transport connected to the running service.

    Returns:
        Current retained jobs for the test caller.
    """
    response = await http.get(
        "http://jobs:8080/api/jobs", headers={"Authorization": f"Bearer {TOKEN}"}
    )
    response.raise_for_status()
    return response.json()["jobs"]


@pytest.mark.parametrize("mode", ["normal", "delay"])
@pytest.mark.parametrize("delete", [False, True])
def test_diagnostic_results_and_explicit_retention(mode: str, delete: bool) -> None:
    """The client supports non-outline results with explicit retention policy.

    Args:
        mode: Real diagnostic operation mode.
        delete: Whether the run owns terminal deletion.
    """

    async def scenario() -> None:
        """Execute and verify retention exclusively through HTTP."""
        async with diagnostic_client() as (jobs, http):
            result = await jobs.run(
                {
                    "operation": "diagnostic.v1",
                    "inputs": {
                        "mode": mode,
                        "seconds": 0.01 if mode == "delay" else 0,
                        "value": [1, 2],
                    },
                },
                timeout_seconds=10,
                delete_on_completion=delete,
            )
            assert result.value == {"value": [1, 2]}
            if delete:
                assert await retained_jobs(http) == []
            else:
                assert (await jobs.status(result.jobId)).status == "succeeded"
                assert await jobs.result(result.jobId) == result
                await jobs.delete(result.jobId)
                assert await retained_jobs(http) == []

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "mode,timeout,expected", [("exception", 10, "failed"), ("delay", 1, "timed_out")]
)
def test_terminal_failures_are_not_results(
    mode: str, timeout: int, expected: str
) -> None:
    """Expose failed terminal snapshots and retain them when requested.

    Args:
        mode: Diagnostic failure or delay.
        timeout: Server execution budget.
        expected: Expected authoritative terminal status.
    """

    async def scenario() -> None:
        """Run real failing processes without substituting executor behavior."""
        async with diagnostic_client() as (jobs, http):
            with pytest.raises(JobFailed) as failure:
                await jobs.run(
                    {
                        "operation": "diagnostic.v1",
                        "inputs": {
                            "mode": mode,
                            "seconds": 5 if mode == "delay" else 0,
                        },
                        "executionTimeoutSeconds": timeout,
                    },
                    timeout_seconds=10,
                    delete_on_completion=False,
                )
            assert failure.value.snapshot.status == expected
            assert (await jobs.status(failure.value.snapshot.jobId)).status == expected
            await jobs.delete(failure.value.snapshot.jobId)
            assert await retained_jobs(http) == []

    asyncio.run(scenario())


def test_low_level_ownership_idempotency_and_cancellation() -> None:
    """Detached submissions retain ownership, retry identity and explicit cleanup."""

    async def scenario() -> None:
        """Verify each public client method against the real service boundary."""
        async with diagnostic_client() as (alice, http):
            bob = JobsClient(http, OTHER_TOKEN)
            payload = {
                "operation": "diagnostic.v1",
                "inputs": {"mode": "delay", "seconds": 5},
            }
            first = await alice.submit(payload, idempotency_key="stable")
            assert (
                await alice.submit(payload, idempotency_key="stable")
            ).jobId == first.jobId
            for action in (bob.status, bob.result, bob.cancel, bob.delete):
                with pytest.raises(httpx2.HTTPStatusError) as failure:
                    await action(first.jobId)
                assert failure.value.response.status_code == 404
            with pytest.raises(httpx2.HTTPStatusError) as conflict:
                await alice.submit(PAYLOAD, idempotency_key="stable")
            assert conflict.value.response.status_code == 409
            snapshot = await alice.cancel(first.jobId)
            async with asyncio.timeout(5):
                while snapshot.status not in TERMINAL:
                    await asyncio.sleep(0.02)
                    snapshot = await alice.status(first.jobId)
            assert snapshot.status == "cancelled"
            await alice.delete(first.jobId)
            assert await retained_jobs(http) == []

    asyncio.run(scenario())


@pytest.mark.parametrize("cancel", [False, True])
def test_abandoned_runs_cancel_and_delete(cancel: bool) -> None:
    """Caller cancellation and client deadline both settle admitted work.

    Args:
        cancel: Explicit task cancellation instead of client timeout.
    """

    async def scenario() -> None:
        """Wait for public admission before abandoning the real job."""
        async with diagnostic_client() as (jobs, http):
            task = asyncio.create_task(
                jobs.run(
                    {
                        "operation": "diagnostic.v1",
                        "inputs": {"mode": "delay", "seconds": 5},
                    },
                    timeout_seconds=10 if cancel else 0.3,
                    delete_on_completion=True,
                )
            )
            async with asyncio.timeout(5):
                while not await retained_jobs(http):
                    await asyncio.sleep(0.01)
            if cancel:
                task.cancel()
            with pytest.raises(asyncio.CancelledError if cancel else TimeoutError):
                await task
            assert await retained_jobs(http) == []

    asyncio.run(scenario())


@pytest.mark.parametrize("disconnect", [False, True])
def test_uncertain_submission_recovery_uses_frozen_inputs(disconnect: bool) -> None:
    """A lost or delayed admission response cannot orphan the real accepted job.

    Args:
        disconnect: Cancel while admission response is delayed; otherwise lose it.
    """

    async def scenario() -> None:
        """Inject only a transport fault, preserving actual service admission."""
        async with diagnostic_client() as (_, http):
            accepted, release = asyncio.Event(), asyncio.Event()
            submissions = []

            async def forward(request: httpx2.Request) -> httpx2.Response:
                """Forward real HTTP requests, interrupting just the first reply.

                Args:
                    request: Client request, including frozen body and retry key.

                Returns:
                    Real server response after the transport fault.

                Raises:
                    httpx2.ReadError: To simulate a lost successful admission reply.
                """
                response = await http.send(request)
                await response.aread()
                if request.method == "POST" and request.url.path == "/api/jobs":
                    submissions.append(
                        (request.content, request.headers["Idempotency-Key"])
                    )
                    if len(submissions) == 1:
                        accepted.set()
                        await release.wait()
                        if not disconnect:
                            raise httpx2.ReadError(
                                "lost admission reply", request=request
                            )
                return response

            async with httpx2.AsyncClient(
                transport=httpx2.MockTransport(forward)
            ) as faulty:
                jobs = JobsClient(faulty, TOKEN)
                payload = {
                    "operation": "diagnostic.v1",
                    "inputs": {"mode": "delay", "seconds": 5, "value": "original"},
                }
                task = asyncio.create_task(
                    jobs.run(payload, timeout_seconds=10, delete_on_completion=True)
                )
                await asyncio.wait_for(accepted.wait(), 5)
                payload["inputs"]["value"] = "mutated"
                if disconnect:
                    task.cancel()
                release.set()
                with pytest.raises(
                    asyncio.CancelledError if disconnect else httpx2.ReadError
                ):
                    await task
            assert len(submissions) == (1 if disconnect else 2)
            assert len(set(submissions)) == 1
            assert json.loads(submissions[0][0])["inputs"]["value"] == "original"
            assert await retained_jobs(http) == []

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "body",
    [
        b"[]",
        b"broken",
        b"{}",
        b'{"jobId":null,"status":"running"}',
        b"x" * (MAX_RESPONSE_BYTES + 1),
    ],
    ids=["array", "invalid-json", "missing-fields", "invalid-id", "oversized"],
)
def test_malformed_and_oversized_responses(body: bytes) -> None:
    """Reject invalid service replies at the reusable transport/schema boundary.

    Args:
        body: Malformed or oversized wire response.
    """

    async def scenario() -> None:
        """Validate without involving operation-specific code."""
        async with httpx2.AsyncClient(
            transport=httpx2.MockTransport(lambda _: httpx2.Response(200, content=body))
        ) as http:
            with pytest.raises(ValueError):
                await JobsClient(http, TOKEN).status(uuid4())

    asyncio.run(scenario())


def test_mismatched_identity_and_redirects() -> None:
    """Never accept another job's output or send credentials through a redirect."""

    async def scenario() -> None:
        """Exercise all resource-returning methods and a redirecting endpoint."""
        calls = []

        def respond(request: httpx2.Request) -> httpx2.Response:
            """Return mismatched identities or attempt an external redirect.

            Args:
                request: Outbound request.

            Returns:
                Deliberately invalid service reply.
            """
            calls.append(request)
            if request.method == "DELETE":
                return httpx2.Response(
                    307, headers={"Location": "http://other.invalid/"}
                )
            return httpx2.Response(
                200, json={"jobId": str(uuid4()), "status": "succeeded", "value": 1}
            )

        async with httpx2.AsyncClient(
            transport=httpx2.MockTransport(respond), follow_redirects=True
        ) as http:
            jobs = JobsClient(http, TOKEN)
            for action in (jobs.status, jobs.result, jobs.cancel):
                with pytest.raises(ValueError, match="Mismatched"):
                    await action(uuid4())
            with pytest.raises(httpx2.HTTPStatusError):
                await jobs.delete(uuid4())
        assert len(calls) == 4
        assert all(r.url.host == "jobs" for r in calls)

    asyncio.run(scenario())
