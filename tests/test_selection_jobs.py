"""Verify vector measurements across Catalog, Jobs, and browser HTTP boundaries."""

import asyncio
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx2
import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from eolab_app.catalog_selection import CatalogSelection
from eolab_app.main import create_app
from eolab_app.routes.vector_sampling import create_vector_sampling_router
from eolab_app.vector.catalog import StacVectorCatalog
from eolab_app.vector.filters import CatalogVectorFilterRequest, VectorFilter
from eolab_app.vector.outline_jobs import OutlineJobs
from eolab_app.vector.sampling import VectorSamplingService
from eolab_app.vector.selection_jobs import SelectionJobs
from eolab_app.vector.selection_operation import (
    SelectionMeasurementInput,
    SelectionMeasurementResult,
)
from eolab_app.vector.sources import MountedVectorResolver
from eolab_jobs.client import JobsClient
from job_service.app import create_app as create_jobs_app
from job_service.configuration import Settings
from job_service.executor import ExecutionResult

# Real HTTP Catalog and two polygon features, including a hole and a typed filter.
from test_outline_jobs import outline_case

TOKEN = "test-outline-" + "a" * 40
MEASUREMENTS = {
    "bbox": [0, 0, 4, 4],
    "matched": 1,
    "total": 2,
    "coordinates": 10,
    "rings": 2,
    "exactGeometryBytes": 259,
}


@pytest.mark.parametrize("case", ["valid", "empty", "stale"])
def test_registered_measurement_reads_original_filtered_polygons(
    outline_case: tuple,
    tmp_path: Path,
    case: str,
) -> None:
    """Execute the actual registered operation in the actual Jobs native runner.

    Args:
        outline_case: HTTP Catalog and mounted polygons used by outline tests too.
        tmp_path: Readable fixture mount, injected only as deployment configuration.
        case: Valid selection, empty predicate, or obsolete source signature.
    """
    selection, _, url = outline_case
    if case == "empty":
        selection = selection.model_copy(
            update={
                "filter": VectorFilter(
                    rules=[{"field": "selected", "operator": "eq", "value": 99}]
                )
            }
        )
    if case == "stale":
        selection = selection.model_copy(update={"sourceSignature": "f" * 64})
    command = (
        "from pathlib import Path; from eolab_app.vector import selection_operation as op; "
        f"op.CATALOG_URL={url!r}; op.SCAN_MOUNT=Path({str(tmp_path)!r}); "
        "from job_service.runner import main; main()"
    )
    result = subprocess.run(
        [sys.executable, "-c", command],
        cwd=Path(__file__).parents[1] / "services/jobs",
        input=json.dumps(
            {
                "operation": "vector.selection-measurement.v1",
                "inputs": {
                    "selection": selection.model_dump(mode="json", by_alias=True),
                },
            }
        ).encode(),
        capture_output=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr.decode()
    reply = json.loads(result.stdout)
    if case == "stale":
        assert reply["ok"]
        assert reply["value"]["measurements"] is None
        assert "identity changed" in reply["value"]["error"]
    elif case == "empty":
        assert reply["ok"]
        assert reply["value"]["measurements"] is None
        assert "No matching polygon" in reply["value"]["error"]
    else:
        measured = SelectionMeasurementResult.model_validate(reply["value"])
        assert measured.error is None
        assert measured.measurements.bbox == (0, 0, 4, 4)
        assert measured.measurements.matched == 1
        assert measured.measurements.total == 2
        assert measured.measurements.coordinates == 10
        assert measured.measurements.rings == 2
        assert measured.measurements.exactGeometryBytes > 0
        assert "geometry" not in reply["value"]


def test_measurement_contract_rejects_paths_and_inconsistent_results(
    outline_case: tuple,
) -> None:
    """Reject source substitutions and malformed native/HTTP measurement results.

    Args:
        outline_case: Authorized fixture descriptor.
    """
    selection, _, _ = outline_case
    for extra in ({"path": "/private"}, {"url": "http://elsewhere"}, {"geometry": {}}):
        with pytest.raises(ValueError):
            SelectionMeasurementInput(selection=selection, **extra)
    for result in (
        {},
        {"measurements": MEASUREMENTS, "error": "bad"},
        {"measurements": {**MEASUREMENTS, "matched": 3}},
        {"measurements": {**MEASUREMENTS, "bbox": [4, 0, 0, 4]}},
        {"measurements": {**MEASUREMENTS, "rings": -1}},
    ):
        with pytest.raises(ValueError):
            SelectionMeasurementResult.model_validate(result)


@pytest.mark.parametrize(
    "outcome",
    [
        "success",
        "empty",
        "full",
        "unauthorized",
        "restart",
        "expired",
        "timed_out",
        "failed",
        "stale",
    ],
)
def test_application_selects_only_through_jobs(
    outline_case: tuple,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    configured_environment: None,
    version_file_path: Path,
    outcome: str,
) -> None:
    """Preserve public selection results and errors through real app composition.

    Args:
        outline_case: Real authorized source and HTTP Catalog.
        tmp_path: Mounted fixture root.
        monkeypatch: Isolated app deployment settings.
        configured_environment: Complete application environment.
        version_file_path: Application version fixture.
        outcome: Jobs completion, rejection, source change, or lifecycle failure.
    """
    selection, _, catalog_url = outline_case
    monkeypatch.setenv("CATALOG_INTERNAL_URL", catalog_url)
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(tmp_path))
    job_id = str(uuid4())
    calls: list[httpx2.Request] = []

    def respond(request: httpx2.Request) -> httpx2.Response:
        """Return Jobs protocol responses without replacing application logic.

        Args:
            request: Authenticated request to the internal Jobs host.

        Returns:
            Controlled lifecycle state or operation result.
        """
        calls.append(request)
        assert request.url.host == "jobs"
        assert request.headers["authorization"] == f"Bearer {TOKEN}"
        if outcome in {"full", "unauthorized"}:
            return httpx2.Response(503 if outcome == "full" else 401)
        if request.method == "DELETE":
            return httpx2.Response(204)
        if outcome == "restart" and request.method == "GET":
            return httpx2.Response(404)
        if request.url.path.endswith("/result"):
            if outcome == "stale":
                with (tmp_path / "polygons.gpkg").open("ab") as stream:
                    stream.write(b"changed")
            value = (
                {"error": "No matching polygon features; change the filter"}
                if outcome == "empty"
                else {"measurements": MEASUREMENTS}
            )
            return httpx2.Response(200, json={"jobId": job_id, "value": value})
        status = (
            outcome if outcome in {"expired", "timed_out", "failed"} else "succeeded"
        )
        return httpx2.Response(202, json={"jobId": job_id, "status": status})

    app = create_app(version_file_path, jobs_transport=httpx2.MockTransport(respond))
    with TestClient(app) as browser:
        response = browser.post(
            "/api/vector-sampling/areas",
            json={
                "collectionId": selection.collection_id,
                "itemId": selection.item_id,
                "filter": selection.filter.model_dump(mode="json"),
            },
        )
    payload = json.loads(calls[0].content)
    assert payload["operation"] == "vector.selection-measurement.v1"
    assert payload["inputs"] == {
        "selection": selection.model_dump(mode="json", by_alias=True)
    }
    assert payload["priority"] > -10
    assert payload["executionTimeoutSeconds"] == 15
    assert payload["queueTimeoutSeconds"] == 30
    assert TOKEN not in response.text and str(tmp_path) not in response.text
    if outcome == "success":
        assert response.status_code == 200, response.text
        assert response.json() == {
            **MEASUREMENTS,
            "selection": selection.model_dump(mode="json", by_alias=True),
            "filter": selection.filter.model_dump(mode="json"),
            "label": selection.item_id,
        }
        assert calls[-1].method == "DELETE"
    else:
        assert response.status_code == 409, response.text
        expected = {
            "empty": "No matching",
            "full": "busy or unavailable",
            "unauthorized": "unavailable",
            "restart": "unavailable",
            "expired": "waited too long",
            "timed_out": "time budget",
            "failed": "could not be measured",
            "stale": "changed",
        }[outcome]
        assert expected in response.text


@pytest.mark.parametrize("status", ["queued", "running"])
def test_route_disconnect_cancels_only_its_measurement(
    outline_case: tuple, tmp_path: Path, status: str
) -> None:
    """Propagate the route's disconnect to the exact admitted Jobs identity.

    Args:
        outline_case: Real catalog descriptor and source.
        tmp_path: Fixture source mount.
        status: State when the browser connection is lost.
    """
    selection, _, url = outline_case

    async def scenario() -> None:
        """Disconnect during admission, then verify cancellation and deletion."""
        admitted, disconnected, release = (
            asyncio.Event(),
            asyncio.Event(),
            asyncio.Event(),
        )
        job_id = str(uuid4())
        calls: list[tuple[str, str]] = []

        async def respond(request: httpx2.Request) -> httpx2.Response:
            """Keep the admission response in flight until the browser leaves.

            Args:
                request: Jobs lifecycle request.

            Returns:
                The admitted job or its cancellation acknowledgement.
            """
            calls.append((request.method, request.url.path))
            if request.url.path == "/api/jobs":
                admitted.set()
                await release.wait()
                return httpx2.Response(202, json={"jobId": job_id, "status": status})
            if request.url.path.endswith("/cancel"):
                return httpx2.Response(
                    200, json={"jobId": job_id, "status": "cancelled"}
                )
            return httpx2.Response(204)

        async def receive() -> dict[str, Any]:
            """Wait for the browser disconnect message.

            Returns:
                The ASGI disconnect event.
            """
            await disconnected.wait()
            return {"type": "http.disconnect"}

        async with (
            httpx2.AsyncClient() as catalog_http,
            httpx2.AsyncClient(transport=httpx2.MockTransport(respond)) as job_http,
        ):
            service = VectorSamplingService(
                StacVectorCatalog(catalog_http, url),
                MountedVectorResolver(tmp_path),
                selection_executor=SelectionJobs(JobsClient(job_http, TOKEN)),
            )
            router = create_vector_sampling_router(service)
            endpoint = next(
                route.endpoint
                for route in router.routes
                if route.path.endswith("/areas")
            )
            task = asyncio.create_task(
                endpoint(
                    CatalogVectorFilterRequest(
                        collectionId=selection.collection_id,
                        itemId=selection.item_id,
                        filter=selection.filter,
                    ),
                    Request({"type": "http"}, receive),
                )
            )
            await asyncio.wait_for(admitted.wait(), 5)
            disconnected.set()
            release.set()
            from fastapi import HTTPException

            with pytest.raises(HTTPException) as failure:
                await asyncio.wait_for(task, 5)
            assert failure.value.status_code == 499
        assert calls[-2:] == [
            ("POST", f"/api/jobs/{job_id}/cancel"),
            ("DELETE", f"/api/jobs/{job_id}"),
        ]

    asyncio.run(scenario())


def test_users_queue_selections_ahead_of_waiting_outlines(
    outline_case: tuple, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Use the real Jobs HTTP manager to queue users, cancel one, and order work.

    Args:
        outline_case: Valid path-free selection and expected outline.
        monkeypatch: Replaces only native execution with a controlled slow worker.
    """
    selection, outline, _ = outline_case

    async def scenario() -> None:
        """Hold one execution while several independent callers submit work."""
        entered, release = asyncio.Event(), asyncio.Event()
        executed: list[str] = []

        async def execute(
            payload: bytes, cancel: asyncio.Event, timeout: float
        ) -> ExecutionResult:
            """Model one bounded native call while leaving scheduling to Jobs.

            Args:
                payload: Registered operation validated by Jobs admission.
                cancel: Execution cancellation signal.
                timeout: Applied execution deadline.

            Returns:
                A small valid operation result after the controlled wait.
            """
            operation = json.loads(payload)["operation"]
            executed.append(operation)
            if len(executed) == 1:
                entered.set()
                await release.wait()
            if operation == "vector.outline.v1":
                return ExecutionResult("succeeded", json.loads(json.dumps(outline)))
            return ExecutionResult("succeeded", {"measurements": MEASUREMENTS})

        monkeypatch.setattr("job_service.manager.run_job", execute)
        jobs_app = create_jobs_app(
            Settings(callers={"eolab": hashlib.sha256(TOKEN.encode()).hexdigest()})
        )
        async with (
            jobs_app.router.lifespan_context(jobs_app),
            httpx2.AsyncClient(transport=httpx2.ASGITransport(app=jobs_app)) as http,
        ):
            adapter = SelectionJobs(JobsClient(http, TOKEN))
            display = OutlineJobs(JobsClient(http, TOKEN))
            first = asyncio.create_task(adapter(selection))
            await asyncio.wait_for(entered.wait(), 5)
            pending_outline = asyncio.create_task(display(selection))
            requests = [asyncio.create_task(adapter(selection)) for _ in range(4)]
            try:
                async with asyncio.timeout(5):
                    while True:
                        response = await http.get(
                            "http://jobs/api/jobs",
                            headers={"Authorization": f"Bearer {TOKEN}"},
                        )
                        records = response.json()["jobs"]
                        if len(records) == 6:
                            break
                        await asyncio.sleep(0.01)
                assert sum(record["status"] == "queued" for record in records) == 5
                requests[0].cancel()
                with pytest.raises(asyncio.CancelledError):
                    await requests[0]
                release.set()
                results = await asyncio.wait_for(
                    asyncio.gather(first, *requests[1:]), 5
                )
                assert results == [MEASUREMENTS] * 4
                assert await pending_outline == json.loads(json.dumps(outline))
                assert executed == ["vector.selection-measurement.v1"] * 4 + [
                    "vector.outline.v1"
                ]
                response = await http.get(
                    "http://jobs/api/jobs", headers={"Authorization": f"Bearer {TOKEN}"}
                )
                assert response.json()["jobs"] == []
            finally:
                release.set()
                for task in [first, pending_outline, *requests]:
                    task.cancel()
                await asyncio.gather(
                    first, pending_outline, *requests, return_exceptions=True
                )

    asyncio.run(scenario())
