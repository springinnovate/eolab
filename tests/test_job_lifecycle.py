"""Real API/process tests for the first standalone execution lifecycle."""

import asyncio
import hashlib
import json
import time
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from job_service.app import create_app
from job_service.configuration import Settings, load_settings
from job_service.executor import run_operation

BASE = "/api/jobs"
ALICE = {"Authorization": "Bearer " + "a" * 48}
BOB = {"Authorization": "Bearer " + "b" * 48}
CALLERS = {
    name: hashlib.sha256((letter * 48).encode()).hexdigest()
    for name, letter in (("alice", "a"), ("bob", "b"))
}


@pytest.fixture
def client() -> Iterator[TestClient]:
    """Provide an isolated running service with two authenticated callers.

    Yields:
        Test client whose shutdown also reaps running work.
    """
    with TestClient(create_app(Settings(callers=CALLERS))) as browser:
        yield browser


def submit(
    client: TestClient, key: str, mode: str = "normal", **options: object
) -> str:
    """Submit a diagnostic request and require successful admission.

    Args:
        client: Running service client.
        key: Unique idempotency identity.
        mode: Diagnostic mode.
        options: Submission overrides, including optional seconds for delay.

    Returns:
        Job identity.
    """
    inputs = {"mode": mode, "value": key}
    if mode == "delay":
        inputs["seconds"] = options.pop("seconds", 20)
    response = client.post(
        BASE,
        headers={**ALICE, "Idempotency-Key": key},
        json={"operation": "diagnostic.v1", "inputs": inputs, **options},
    )
    assert response.status_code == 202, response.text
    return response.json()["jobId"]


def wait(client: TestClient, job: str, status: str) -> dict:
    """Observe a state using bounded polling of the public API.

    Args:
        client: Running service client.
        job: Job identity.
        status: Desired state.

    Returns:
        Authoritative matching snapshot.

    Raises:
        AssertionError: If the state is not observed within ten seconds.
    """
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        response = client.get(f"{BASE}/{job}", headers=ALICE)
        assert response.status_code == 200, response.text
        snapshot = response.json()
        if snapshot["status"] == status:
            return snapshot
        time.sleep(0.02)
    raise AssertionError(snapshot)


def test_priority_fifo_updates_and_cancelled_queue(client: TestClient) -> None:
    """Cancel a blocker, then execute updated priorities/FIFO with one lane.

    Args:
        client: Isolated service.
    """
    blocker = submit(client, "blocker", "delay")
    wait(client, blocker, "running")
    low = submit(client, "low", priority=-10)
    first = submit(client, "first", priority=5)
    second = submit(client, "second", priority=5)
    removed = submit(client, "removed", priority=1000)
    assert (
        client.patch(f"{BASE}/{low}", headers=ALICE, json={"priority": 10}).status_code
        == 200
    )
    assert (
        client.patch(
            f"{BASE}/{blocker}", headers=ALICE, json={"priority": 10}
        ).status_code
        == 409
    )
    assert client.delete(f"{BASE}/{blocker}", headers=ALICE).status_code == 409
    assert (
        client.post(f"{BASE}/{removed}/cancel", headers=ALICE).json()["status"]
        == "cancelled"
    )
    assert client.get(f"{BASE}/{removed}", headers=ALICE).json()["startedAt"] is None
    assert (
        client.post(f"{BASE}/{blocker}/cancel", headers=ALICE).json()["status"]
        == "cancelling"
    )
    cancelled = wait(client, blocker, "cancelled")
    results = [wait(client, job, "succeeded") for job in (low, first, second)]
    assert cancelled["finishedAt"] <= results[0]["startedAt"]
    assert results[0]["finishedAt"] <= results[1]["startedAt"]
    assert results[1]["finishedAt"] <= results[2]["startedAt"]
    assert (
        client.post(f"{BASE}/{second}/cancel", headers=ALICE).json()["status"]
        == "succeeded"
    )


def test_execution_timeout_exception_and_recovery(client: TestClient) -> None:
    """A timed-out or failing child never poisons the next invocation.

    Args:
        client: Isolated service.
    """
    delayed = submit(client, "deadline", "delay", executionTimeoutSeconds=1)
    timed = wait(client, delayed, "timed_out")
    assert timed["error"]["code"] == "timed_out"
    failed = submit(client, "failure", "exception")
    failure = wait(client, failed, "failed")
    assert failure["error"] == {"code": "failed", "message": "Operation failed"}
    assert "Traceback" not in str(failure)
    assert client.get(f"{BASE}/{failed}/result", headers=ALICE).status_code == 409
    normal = submit(client, "recovery")
    wait(client, normal, "succeeded")
    delay_success = submit(client, "short-delay", "delay", seconds=0.05)
    wait(client, delay_success, "succeeded")


def test_queue_expiry_and_capacity() -> None:
    """Bound waiting requests and expire them while another job is running."""
    with TestClient(
        create_app(Settings(callers=CALLERS, queue_capacity=1, record_capacity=4))
    ) as client:
        blocker = submit(client, "blocker", "delay")
        wait(client, blocker, "running")
        pending = submit(client, "pending", queueTimeoutSeconds=1)
        full = client.post(
            BASE,
            headers={**ALICE, "Idempotency-Key": "overflow"},
            json={"operation": "diagnostic.v1", "inputs": {}},
        )
        assert full.status_code == 503 and full.headers["retry-after"] == "1"
        expired = wait(client, pending, "expired")
        assert expired["startedAt"] is None
        assert client.post(f"{BASE}/{blocker}/cancel", headers=ALICE).status_code == 200
        recovery = submit(client, "after-expiry")
        wait(client, recovery, "succeeded")


@pytest.mark.parametrize(
    "method,suffix,body",
    [
        ("GET", "", None),
        ("PATCH", "", {"priority": 1}),
        ("POST", "/cancel", None),
        ("GET", "/result", None),
        ("GET", "/events", None),
        ("GET", "/artifacts/00000000-0000-4000-8000-000000000001", None),
        ("DELETE", "", None),
    ],
)
def test_owner_isolation(
    client: TestClient, method: str, suffix: str, body: dict | None
) -> None:
    """Every ID-based hook hides other callers' records.

    Args:
        client: Isolated service.
        method: HTTP operation.
        suffix: Job-relative URL.
        body: Optional request body.
    """
    job = submit(client, "private", "delay")
    response = client.request(method, f"{BASE}/{job}{suffix}", headers=BOB, json=body)
    assert response.status_code == 404
    assert client.get(BASE, headers=BOB).json()["jobs"] == []
    assert client.get(BASE, headers=BOB, params={"cursor": job}).status_code == 422


def test_authentication_and_fail_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    """Missing/unknown credentials cannot admit or observe work.

    Args:
        monkeypatch: Isolated deployment environment.
    """
    with TestClient(create_app(Settings(callers=CALLERS))) as client:
        for headers in (
            {},
            {"Authorization": "Bearer invalid"},
            {"X-Owner": "alice"},
            {"Authorization": "Basic abc"},
        ):
            response = client.get(BASE, headers=headers)
            assert response.status_code == 401
            assert response.headers["www-authenticate"] == "Bearer"
        assert client.get(f"{BASE}/health").json()["acceptsJobs"]
    monkeypatch.delenv("JOBS_CALLERS", raising=False)
    with TestClient(create_app()) as client:
        assert not client.get(f"{BASE}/health").json()["acceptsJobs"]
        assert client.get(BASE, headers=ALICE).status_code == 503


@pytest.mark.parametrize(
    "raw",
    ["not-json", "[]", '{"owner":"short"}', json.dumps({"a": "x" * 32, "b": "x" * 32})],
)
def test_configuration_errors_hide_tokens(
    monkeypatch: pytest.MonkeyPatch, raw: str
) -> None:
    """Reject malformed credential configuration without echoing it.

    Args:
        monkeypatch: Environment isolation.
        raw: Invalid credential map.
    """
    monkeypatch.setenv("JOBS_CALLERS", raw)
    with pytest.raises(ValueError, match="Invalid JOBS_CALLERS") as error:
        load_settings()
    assert raw not in str(error.value)


def test_idempotency_pagination_deletion_and_retention() -> None:
    """Bound records, isolate retry keys and release capacity on delete/TTL."""
    settings = Settings(
        callers=CALLERS, queue_capacity=1, record_capacity=2, retention_seconds=2
    )
    with TestClient(create_app(settings)) as client:
        body = {
            "operation": "diagnostic.v1",
            "inputs": {"value": {"a": 1, "b": 2}, "mode": "normal"},
        }
        headers = {**ALICE, "Idempotency-Key": "same"}
        first = client.post(BASE, headers=headers, json=body).json()["jobId"]
        wait(client, first, "succeeded")
        reordered = {
            "inputs": {"mode": "normal", "value": {"b": 2, "a": 1}},
            "operation": "diagnostic.v1",
        }
        assert (
            client.post(BASE, headers=headers, json=reordered).json()["jobId"] == first
        )
        assert (
            client.post(BASE, headers=headers, json={**body, "priority": 1}).status_code
            == 409
        )
        second = submit(client, "second")
        wait(client, second, "succeeded")
        assert (
            client.post(
                BASE, headers={**BOB, "Idempotency-Key": "same"}, json=body
            ).status_code
            == 503
        )
        page = client.get(BASE, headers=ALICE, params={"limit": 1}).json()
        assert page["jobs"][0]["jobId"] == first
        assert (
            client.get(
                BASE, headers=ALICE, params={"cursor": page["nextCursor"]}
            ).json()["jobs"][0]["jobId"]
            == second
        )
        assert client.delete(f"{BASE}/{first}", headers=ALICE).status_code == 204
        other = client.post(BASE, headers={**BOB, "Idempotency-Key": "same"}, json=body)
        assert other.status_code == 202 and other.json()["jobId"] != first
        deadline = time.monotonic() + 5
        while (
            time.monotonic() < deadline
            and client.get(f"{BASE}/{second}", headers=ALICE).status_code != 404
        ):
            time.sleep(0.05)
        assert client.get(f"{BASE}/{second}", headers=ALICE).status_code == 404


@pytest.mark.parametrize(
    "inputs",
    [
        {"mode": "unknown"},
        {"mode": "delay"},
        {"mode": "delay", "seconds": -1},
        {"mode": "normal", "seconds": 1},
        {"mode": "delay", "seconds": True},
        {"mode": "exception", "filename": "/etc/passwd"},
        {"value": "x" * 8193},
    ],
)
def test_operation_input_boundary(client: TestClient, inputs: dict) -> None:
    """Operation validation rejects malformed work before queue admission.

    Args:
        client: Isolated service.
        inputs: Invalid diagnostic arguments.
    """
    response = client.post(
        BASE,
        headers={**ALICE, "Idempotency-Key": "invalid"},
        json={"operation": "diagnostic.v1", "inputs": inputs},
    )
    assert response.status_code == 422
    assert client.get(BASE, headers=ALICE).json()["jobs"] == []


@pytest.mark.parametrize("during_startup", [False, True])
def test_process_cancellation_reaps_before_return(
    monkeypatch: pytest.MonkeyPatch,
    during_startup: bool,
) -> None:
    """Observe actual OS process exit, not just a cancelled status flag.

    Args:
        monkeypatch: Wrap the real subprocess boundary for observing process exit.
        during_startup: Expire the deadline before process creation returns.
    """
    original = asyncio.create_subprocess_exec
    children = []

    async def capture(*args: object, **kwargs: object) -> asyncio.subprocess.Process:
        """Capture the real process handle.

        Args:
            args: Executable arguments.
            kwargs: Subprocess options.

        Returns:
            Real child process.
        """
        child = await original(*args, **kwargs)
        children.append(child)
        if during_startup:
            await asyncio.sleep(0.1)
        return child

    monkeypatch.setattr(asyncio, "create_subprocess_exec", capture)

    async def scenario() -> None:
        """Cancel an actually spawned long delay and verify it is reaped."""
        cancellation = asyncio.Event()
        task = asyncio.create_task(
            run_operation(
                json.dumps(
                    {
                        "operation": "diagnostic.v1",
                        "inputs": {"mode": "delay", "seconds": 20},
                    }
                ).encode(),
                cancellation,
                0.001 if during_startup else 30,
            )
        )
        while not children:
            await asyncio.sleep(0.01)
        if not during_startup:
            cancellation.set()
        outcome = await asyncio.wait_for(task, 5)
        assert outcome.status == ("timed_out" if during_startup else "cancelled")
        assert children[0].returncode is not None

    asyncio.run(scenario())


def test_lifespan_shutdown_and_restart() -> None:
    """Shutdown cancels a long delay promptly; a new app has no retained state."""
    start = time.monotonic()
    with TestClient(create_app(Settings(callers=CALLERS))) as client:
        job = submit(client, "shutdown", "delay", seconds=30)
        wait(client, job, "running")
        submit(client, "queued-at-shutdown")
    assert time.monotonic() - start < 10
    with TestClient(create_app(Settings(callers=CALLERS))) as restarted:
        assert restarted.get(f"{BASE}/{job}", headers=ALICE).status_code == 404
        assert restarted.get(BASE, headers=ALICE).json()["jobs"] == []
