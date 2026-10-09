"""Real model HTTP, catalog, PostgreSQL and supervised aggregate boundaries."""

from dataclasses import replace
import asyncio
import hashlib
from pathlib import Path
from typing import Any, Iterator
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
import psycopg
import pytest

from eolab_app.processing.model_definitions import ModelDefinition, ModelRegistry
from eolab_app.processing.model_run_contracts import RunDocument
from eolab_app.processing.model_yaml import parse_yaml
from eolab_app.processing.models import PreparedJobPlan, ProcessingError
from eolab_app.processing.service import ProcessingService
from eolab_app.routes.processing import COOKIE, create_processing_router
from test_processing_jobs import boundary, store, HEADERS, AREA, clip_inputs
from test_raster_clips import SOURCE
from test_processing_calculations import paused_calculation
from test_polygon_summary_areas import rectangle
from catalog_selection_support import register_selection, write_geopackage_layer
import eolab_app.processing.worker as worker_module
from eolab_app.raster.models import AuthorizedRaster


@pytest.fixture
def model_boundary(boundary: Any, store: Any) -> Iterator[Any]:
    """Compose model routes over the real existing raster and worker fixture.

    Args:
        boundary: Catalog-authorized raster, native worker and artifact storage.
        store: Disposable real PostgreSQL adapter.

    Yields:
        HTTP client, worker and application service for lifecycle tests.
    """
    _, worker, _, artifacts, _ = boundary
    service = ProcessingService(store, artifacts, model_authorizer=worker.authorizer)
    app = FastAPI()
    app.include_router(create_processing_router(service))
    with TestClient(app, base_url="https://testserver") as client:
        yield client, worker, service


def model_request(client: TestClient, **changes: Any) -> dict[str, Any]:
    """Bind discovery metadata to the existing mounted-raster fixture.

    Args:
        client: Current browser-session client.
        changes: Explicit request replacements for a test case.

    Returns:
        Ready-to-submit path-free model request.
    """
    response = client.get("/api/processing/models")
    assert response.status_code == 200, response.text
    definition = response.json()["models"][0]
    return {
        "requestId": uuid4().hex,
        "model": {
            key: definition[key] for key in ("id", "version", "definitionSha256")
        },
        "inputs": {
            "raster": SOURCE,
            "area": {"kind": "selectedArea", "selectedBounds": AREA},
        },
        "parameters": {},
        "label": "My model run",
        **changes,
    }


def submit(client: TestClient, body: dict[str, Any]) -> dict[str, Any]:
    """Submit through the actual same-origin HTTP boundary.

    Args:
        client: Authorized browser-session client.
        body: Model submission.

    Returns:
        Accepted Processing job response.
    """
    response = client.post("/api/processing/model-runs", json=body, headers=HEADERS)
    assert response.status_code == 202, response.text
    job = response.json()
    assert response.headers["location"] == f"/api/processing/jobs/{job['jobId']}"
    return job


def test_model_executes_real_summary_and_exports_without_installed_definition(
    model_boundary: Any, store: Any
) -> None:
    """Produce the same scalar values as the existing aggregate and retain YAML.

    Args:
        model_boundary: Composed Models API and native worker.
        store: Real job store used for lifecycle assertions.
    """
    client, worker, service = model_boundary
    body = model_request(client)
    job = submit(client, body)
    identifier = job["jobId"]
    assert job["operation"] == "model.run.v1" and job["metadataExpiresAt"] is None
    recipe = client.get(f"/api/processing/jobs/{identifier}/model-yaml")
    assert recipe.status_code == 200
    definition = ModelDefinition.model_validate(parse_yaml(recipe.content))
    assert definition.digest == body["model"]["definitionSha256"]
    pending = client.get(f"/api/processing/jobs/{identifier}/run-yaml")
    captured = parse_yaml(pending.content, run=True)
    assert captured["invocation"]["parameters"] == {"summary": "sum(a)"}
    assert captured["execution"]["state"] == "pending"
    assert "source_path" not in pending.text and "://" not in pending.text
    service.model_registry = ModelRegistry(())
    assert submit(client, body)["jobId"] == identifier
    assert (
        client.get(
            "/api/processing/models/raster-summary/versions/1.0.0/yaml"
        ).status_code
        == 404
    )
    assert (
        client.get(f"/api/processing/jobs/{identifier}/model-yaml").content
        == recipe.content
    )
    assert client.portal.call(worker.run_once)
    ready = client.get(f"/api/processing/jobs/{identifier}").json()
    assert ready["status"] == "ready", ready
    assert ready["metadataExpiresAt"] is not None
    result = client.get(ready["result"]["url"])
    assert result.status_code == 200 and "My model run" in result.text
    assert client.get(ready["result"]["provenanceUrl"]).status_code == 200
    assert hashlib.sha256(result.content).hexdigest() == ready["result"]["sha256"]
    exported = parse_yaml(
        client.get(f"/api/processing/jobs/{identifier}/run-yaml").content, run=True
    )
    RunDocument.model_validate(exported)
    assert exported["invocation"] == captured["invocation"]
    assert exported["execution"]["state"] == "prepared"
    assert exported["execution"]["outcome"]["status"] == "ready"
    assert exported["execution"]["outcome"]["statistics"] == ready["result"]["rows"]
    aggregate = client.post(
        "/api/processing/raster-calculations",
        headers=HEADERS,
        json={
            "requestId": uuid4().hex,
            "sources": {"a": SOURCE},
            "selectedBounds": AREA,
            "calculations": [{"label": "My model run", "expression": "sum(a)"}],
        },
    )
    assert aggregate.status_code == 202, aggregate.text
    assert client.portal.call(worker.run_once)
    legacy = client.get(f"/api/processing/jobs/{aggregate.json()['jobId']}").json()
    assert legacy["result"]["rows"] == ready["result"]["rows"]
    assert [
        item["operation"] for item in client.get("/api/processing/jobs").json()["jobs"]
    ] == ["raster.aggregate.v1"]
    mixed = client.post(
        "/api/processing/jobs/status",
        headers=HEADERS,
        json={"jobIds": [identifier, legacy["jobId"]]},
    )
    assert mixed.status_code == 200, mixed.text
    assert [item["operation"] for item in mixed.json()["jobs"]] == [
        "model.run.v1",
        "raster.aggregate.v1",
    ]


def test_model_owner_idempotency_pagination_and_cancel(
    model_boundary: Any, store: Any
) -> None:
    """Model history remains owned and independent of more than 50 later jobs.

    Args:
        model_boundary: HTTP and native worker fixture.
        store: Real storage for opaque unrelated-job fixtures.
    """
    client, worker, _ = model_boundary
    first_body = model_request(client)
    first = submit(client, first_body)
    assert submit(client, first_body)["jobId"] == first["jobId"]
    conflict = client.post(
        "/api/processing/model-runs",
        headers=HEADERS,
        json={**first_body, "label": "Changed"},
    )
    assert conflict.status_code == 409
    second = submit(client, model_request(client, label="Second"))
    owner = hashlib.sha256(client.cookies.get(COOKIE).encode()).hexdigest()
    for index in range(55):
        unrelated = store.submit(
            owner,
            uuid4().hex,
            PreparedJobPlan({}, {}, 0, operation="test.unrelated.v1"),
            str(index),
        )
        store.cancel(unrelated["id"], owner)
    page = client.get("/api/processing/model-runs?limit=1").json()
    assert [job["jobId"] for job in page["jobs"]] == [second["jobId"]]
    last = client.get(
        "/api/processing/model-runs", params={"limit": 1, "cursor": page["nextCursor"]}
    ).json()
    assert [job["jobId"] for job in last["jobs"]] == [first["jobId"]]
    assert last["nextCursor"] is None
    assert client.get("/api/processing/model-runs?cursor=bad!").status_code == 422
    assert client.get("/api/processing/model-runs?limit=101").status_code == 422
    with TestClient(client.app, base_url="https://testserver") as stranger:
        assert (
            stranger.get(f"/api/processing/jobs/{first['jobId']}/run-yaml").status_code
            == 404
        )
        assert stranger.get("/api/processing/model-runs").json()["jobs"] == []
        assert (
            stranger.get(
                "/api/processing/model-runs", params={"cursor": page["nextCursor"]}
            ).json()["jobs"]
            == []
        )
    cancelled = client.post(
        f"/api/processing/jobs/{first['jobId']}/cancel", headers=HEADERS
    )
    assert cancelled.status_code == 202 and cancelled.json()["status"] == "cancelled"
    assert (
        client.get(f"/api/processing/jobs/{first['jobId']}/run-yaml").status_code == 200
    )
    assert client.portal.call(worker.run_once)
    assert (
        client.get(f"/api/processing/jobs/{second['jobId']}").json()["status"]
        == "ready"
    )


@pytest.mark.parametrize("terminal", ["ready", "interrupted", "cancelled", "failed"])
def test_model_capture_survives_cleanup_then_expires(
    model_boundary: Any, store: Any, terminal: str
) -> None:
    """Retention starts at the first terminal transition, independent of cleanup.

    Args:
        model_boundary: Model application and worker.
        store: Real PostgreSQL adapter.
        terminal: Completion or termination path under test.
    """
    client, worker, _ = model_boundary
    job = submit(client, model_request(client))
    identifier = job["jobId"]
    if terminal == "ready":
        assert client.portal.call(worker.run_once)
    elif terminal == "interrupted":
        assert store.interrupt_unfinished_jobs_on_restart() == 1
    elif terminal == "cancelled":
        client.post(f"/api/processing/jobs/{identifier}/cancel", headers=HEADERS)
    else:
        claimed = store.claim_next_job()
        assert store.finish(
            claimed["id"],
            claimed["attempt_id"],
            None,
            {"code": "fixture_failure", "detail": "Sanitized fixture failure."},
        )
    initial = client.get(f"/api/processing/jobs/{identifier}").json()
    deadline = initial["metadataExpiresAt"]
    assert initial["status"] == terminal and deadline is not None
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET expires_at=now()-interval '1 second' WHERE id=%s",
            (identifier,),
        )
    for candidate in store.cleanup_candidates():
        if candidate["attempt_id"]:
            worker.artifacts.remove(candidate["attempt_id"])
        store.cleaned(candidate["id"])
    exported = client.get(f"/api/processing/jobs/{identifier}/run-yaml")
    assert exported.status_code == 200, exported.text
    document = parse_yaml(exported.content, run=True)
    assert document["execution"]["outcome"]["status"] == terminal
    assert (
        client.get(f"/api/processing/jobs/{identifier}").json()["metadataExpiresAt"]
        == deadline
    )
    with psycopg.connect(store.conninfo) as connection:
        assert (
            connection.execute(
                "SELECT spec,retained_metadata FROM processing.jobs WHERE id=%s",
                (identifier,),
            ).fetchone()[0]
            is None
        )
        connection.execute(
            "UPDATE processing.jobs SET metadata_expires_at=now()-interval '1 second' WHERE id=%s",
            (identifier,),
        )
    assert client.get(f"/api/processing/jobs/{identifier}/run-yaml").status_code == 410
    store.cleanup_candidates()
    with psycopg.connect(store.conninfo) as connection:
        assert connection.execute(
            "SELECT retained_metadata,retained_outcome FROM processing.jobs WHERE id=%s",
            (identifier,),
        ).fetchone() == (None, None)


def test_model_delete_revokes_exports_and_retry_recovers_after_input_loss(
    model_boundary: Any, store: Any
) -> None:
    """Deleting a terminal run revokes its exports while preserving retry tombstones.

    Args:
        model_boundary: Composed HTTP and native worker.
        store: Real owned job storage.
    """
    client, worker, service = model_boundary
    body = model_request(client)
    job = submit(client, body)
    identifier = job["jobId"]
    service.model_authorizer = None
    assert submit(client, body)["jobId"] == identifier
    assert client.portal.call(worker.run_once)
    response = client.delete(f"/api/processing/jobs/{identifier}", headers=HEADERS)
    assert response.status_code == 200, response.text
    assert (
        client.get(f"/api/processing/jobs/{identifier}/model-yaml").status_code == 410
    )
    assert client.get(f"/api/processing/jobs/{identifier}/run-yaml").status_code == 410
    assert submit(client, body)["status"] == "deleted"


def test_model_origin_size_and_metadata_limits(model_boundary: Any, store: Any) -> None:
    """Keep HTTP and retained-record limits at their owning boundaries.

    Args:
        model_boundary: Real model HTTP boundary.
        store: Real generic metadata storage boundary.
    """
    client, _, _ = model_boundary
    body = model_request(client)
    assert client.post("/api/processing/model-runs", json=body).status_code == 403
    assert (
        client.post(
            "/api/processing/model-runs",
            json=body,
            headers={**HEADERS, "Origin": "https://foreign.example"},
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/processing/model-runs",
            content=b" " * 16385,
            headers={**HEADERS, "Content-Type": "application/json"},
        ).status_code
        == 413
    )
    with pytest.raises(ProcessingError, match="retained metadata"):
        store.submit(
            "fixture-owner",
            uuid4().hex,
            PreparedJobPlan(
                {}, {}, 0, retained_metadata={"oversized": "x" * (192 * 1024)}
            ),
            "fixture-request",
        )


def test_model_vector_filter_and_changed_signature(
    model_boundary: Any,
    boundary: Any,
    tmp_path: Path,
) -> None:
    """Capture the actual filtered catalog descriptor and revalidate it in the worker.

    Args:
        model_boundary: Model API and worker with the neutral selection reader.
        boundary: Existing vector-selection/catalog API fixture.
        tmp_path: Mounted fixture root.
    """
    client, worker, _ = model_boundary
    source_client = boundary[0]
    path = tmp_path / "selection.gpkg"
    write_geopackage_layer(
        path,
        "mask",
        crs="EPSG:4326",
        geometry={
            "type": "Polygon",
            "coordinates": [
                [[0.1, 9.1], [0.9, 9.1], [0.9, 9.9], [0.1, 9.9], [0.1, 9.1]]
            ],
        },
    )
    selection = register_selection(source_client, path)
    selection["filter"] = {
        "enabled": True,
        "match": "all",
        "rules": [
            {"field": "secret", "operator": "eq", "value": "must not reach browser"},
        ],
    }
    body = model_request(
        client,
        inputs={
            "raster": SOURCE,
            "area": {"kind": "catalogSelection", "selection": selection},
        },
    )
    job = submit(client, body)
    assert client.portal.call(worker.run_once)
    status = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert status["status"] == "ready", status
    capture = parse_yaml(
        client.get(f"/api/processing/jobs/{job['jobId']}/run-yaml").content, run=True
    )
    assert capture["invocation"]["inputs"]["area"]["selection"] == selection
    selection["sourceSignature"] = "0" * 64
    stale = submit(client, model_request(client, inputs=body["inputs"]))
    assert client.portal.call(worker.run_once)
    failed = client.get(f"/api/processing/jobs/{stale['jobId']}").json()
    assert (
        failed["status"] == "failed" and failed["error"]["code"] == "source_unavailable"
    )


def test_model_raster_identity_rechecked_before_execution(model_boundary: Any) -> None:
    """A changed authorized catalog signature cannot silently replace accepted input.

    Args:
        model_boundary: HTTP/worker boundary with replaceable catalog provider.
    """
    client, worker, _ = model_boundary
    job = submit(client, model_request(client))
    original = worker.authorizer

    class ChangedCatalog:
        """Represent an authoritative catalog refresh after admission."""

        async def authorize(self, source: Any) -> AuthorizedRaster:
            """Return the same authorized source with a new catalog identity.

            Args:
                source: Current catalog request.

            Returns:
                Changed catalog signature, without altering the mounted fixture.
            """
            authorized = await original.authorize(source)
            changed = replace(
                authorized.source_signature,
                size_bytes=authorized.source_signature.size_bytes + 1,
            )
            return AuthorizedRaster(authorized.source_path, changed)

    worker.authorizer = ChangedCatalog()
    assert client.portal.call(worker.run_once)
    failed = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert failed["status"] == "failed" and failed["error"]["code"] == "source_changed"


@pytest.mark.parametrize("area_kind", ["wholeRaster", "polygonArea"])
def test_model_whole_raster_and_owned_polygon_inputs(
    model_boundary: Any,
    area_kind: str,
) -> None:
    """Use existing area contracts and preserve accepted private polygon inputs.

    Args:
        model_boundary: Real model API and worker.
        area_kind: Supported non-catalog area variant.
    """
    client, worker, _ = model_boundary
    area = {"kind": area_kind}
    if area_kind == "polygonArea":
        uploaded = client.post(
            "/api/processing/polygon-areas",
            headers=HEADERS,
            json={"polygons": [rectangle(0.1, 9.1, 0.5, 9.5)]},
        )
        assert uploaded.status_code == 200, uploaded.text
        area["reference"] = uploaded.json()["polygonArea"]
        with TestClient(client.app, base_url="https://testserver") as other:
            foreign = model_request(other, inputs={"raster": SOURCE, "area": area})
            assert (
                other.post(
                    "/api/processing/model-runs", headers=HEADERS, json=foreign
                ).status_code
                == 409
            )
    body = model_request(client, inputs={"raster": SOURCE, "area": area})
    job = submit(client, body)
    if area_kind == "polygonArea":
        assert (
            client.delete(
                f"/api/processing/polygon-areas/{area['reference']['id']}",
                headers=HEADERS,
            ).status_code
            == 200
        )
        assert submit(client, body)["jobId"] == job["jobId"]
    assert client.portal.call(worker.run_once)
    ready = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert ready["status"] == "ready", ready
    export = client.get(f"/api/processing/jobs/{job['jobId']}/run-yaml")
    assert export.status_code == 200 and "coordinates:" not in export.text


def test_model_navigation_progress_and_running_cancel(
    model_boundary: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Recover through a new client and cancel after the real native result is written.

    Args:
        model_boundary: Model API, native worker and private result storage.
        monkeypatch: Pause the native process after actual numerical execution.
    """
    client, worker, _ = model_boundary
    job = submit(client, model_request(client))
    identifier = job["jobId"]
    with TestClient(client.app, base_url="https://testserver") as reloaded:
        reloaded.cookies.update(client.cookies)
        assert (
            reloaded.get(f"/api/processing/jobs/{identifier}").json()["status"]
            == "queued"
        )
    monkeypatch.setattr(worker_module, "aggregate_process_target", paused_calculation)

    async def exercise() -> None:
        """Wait for the bounded child, observe its counters and explicitly cancel."""
        task = asyncio.create_task(worker.run_once())
        try:
            async with asyncio.timeout(15):
                while not list(
                    (worker.artifacts.root / "attempts").glob("*/checkpoint")
                ):
                    await asyncio.sleep(0.05)
            async with asyncio.timeout(4):
                while True:
                    state = client.get(f"/api/processing/jobs/{identifier}").json()
                    if state["progress"]["total"] is not None:
                        break
                    await asyncio.sleep(0.05)
            assert state["status"] == "running"
            assert 0 <= state["progress"]["completed"] <= state["progress"]["total"]
            assert state["progress"]["unit"] == "blocks"
            stopped = client.post(
                f"/api/processing/jobs/{identifier}/cancel", headers=HEADERS
            )
            assert stopped.json()["status"] == "cancelling"
            await task
            state = client.get(f"/api/processing/jobs/{identifier}").json()
            assert state["status"] == "cancelled" and state["result"] is None
            await worker.cleanup()
            assert not list((worker.artifacts.root / "results").iterdir())
            assert not list((worker.artifacts.root / "attempts").iterdir())
            assert (
                client.get(f"/api/processing/jobs/{identifier}/run-yaml").status_code
                == 200
            )
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(exercise())
