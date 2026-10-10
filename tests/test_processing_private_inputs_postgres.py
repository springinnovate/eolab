"""Reuse private rasters through real HTTP, PostgreSQL, workers and native readers."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from decimal import Decimal
import hashlib
from pathlib import Path
import time
from typing import Any
from uuid import uuid4

import numpy
import psycopg
import pytest
import rasterio
from fastapi.testclient import TestClient

from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing.model_yaml import parse_yaml
from eolab_app.processing.models import ProcessingError, PreparedJobPlan
from eolab_app.processing.raster_clip import clip_process_target
from eolab_app.routes.processing import COOKIE
from test_model_runs_postgres import model_boundary, model_request, submit
from test_model_artifacts_postgres import multiple_boundary
from test_processing_jobs import boundary, store, HEADERS, AREA
from test_raster_clips import SOURCE
from catalog_selection_support import write_geopackage_layer, register_selection


def publish_input(
    model_boundary: Any, area: dict[str, Any] | None = None
) -> tuple[dict[str, Any], dict[str, str], Path]:
    """Publish a real clip including a valid zero for dependent-job tests.

    Args:
        model_boundary: Actual HTTP client, worker and Processing service.
        area: Optional filtered vector or box; defaults to the entire fixture extent.

    Returns:
        Parent status, public source reference and confined published raster path.
    """
    client, worker, service = model_boundary
    body = model_request(
        client,
        "raster-clip",
        inputs={
            "raster": SOURCE,
            "area": area
            or {
                "kind": "selectedArea",
                "selectedBounds": {
                    "west": 0.0,
                    "south": 9.0,
                    "east": 1.0,
                    "north": 10.0,
                },
            },
        },
    )
    parent = submit(client, body)
    assert client.portal.call(worker.run_once)
    parent = client.get(f"/api/processing/jobs/{parent['jobId']}").json()
    assert parent["status"] == "ready", parent
    file = next(
        file
        for file in parent["artifacts"]["files"]
        if file["mediaType"] == "image/tiff"
    )
    owner = hashlib.sha256(client.cookies.get(COOKIE).encode()).hexdigest()
    row = service.jobs.get(parent["jobId"], owner)
    path = worker.artifacts.artifact_path(row["attempt_id"], "result.tif")
    return (
        parent,
        {
            "kind": "runArtifact",
            "jobId": parent["jobId"],
            "artifactId": file["artifactId"],
        },
        path,
    )


def input_counts(store: Any) -> tuple[int, int]:
    """Read retained input and transfer counts from the disposable database.

    Args:
        store: Real Processing database adapter.

    Returns:
        Durable input-grant count and independent short download-lease count.
    """
    with psycopg.connect(store.conninfo) as connection:
        return connection.execute(
            "SELECT (SELECT count(*) FROM processing.input_files),(SELECT count(*) FROM processing.transfers)"
        ).fetchone()


@pytest.mark.parametrize("model_id", ["raster-summary", "raster-clip"])
@pytest.mark.parametrize("parent_action", ["expire", "delete"])
def test_native_result_input_survives_parent_expiry_or_deletion(
    model_boundary: Any, store: Any, model_id: str, parent_action: str
) -> None:
    """Queued input grants preserve original masked pixels and path-free lineage.

    Args:
        model_boundary: Real Models boundary with no renderer or preview service.
        store: Disposable PostgreSQL store.
        model_id: Existing YAML operation consuming the first result.
        parent_action: Ordinary expiry or explicit access revocation after admission.
    """
    client, worker, _ = model_boundary
    parent, source, path = publish_input(model_boundary)
    with rasterio.open(path) as raster:
        original = raster.read(1, masked=True)
        assert original[0, 0] == 0 and not original.mask[0, 0]
        expected = int(original.sum(dtype="int64"))
    body = model_request(
        client,
        model_id,
        inputs={
            "raster": source,
            "area": {
                "kind": "selectedArea",
                "selectedBounds": {
                    "west": 0.0,
                    "south": 9.0,
                    "east": 1.0,
                    "north": 10.0,
                },
            },
        },
    )
    child = submit(client, body)
    assert input_counts(store) == (1, 0)
    if parent_action == "delete":
        assert (
            client.delete(
                f"/api/processing/jobs/{parent['jobId']}", headers=HEADERS
            ).json()["status"]
            == "deleted"
        )
    else:
        with psycopg.connect(store.conninfo) as connection:
            connection.execute(
                "UPDATE processing.jobs SET expires_at=now()-interval '1 second' WHERE id=%s",
                (parent["jobId"],),
            )
    client.portal.call(worker.cleanup)
    assert path.exists() and input_counts(store) == (1, 0)
    assert submit(client, body)["jobId"] == child["jobId"]
    rejected = client.post(
        "/api/processing/model-runs",
        json={**body, "requestId": uuid4().hex},
        headers=HEADERS,
    )
    assert rejected.status_code == 409, rejected.text
    assert input_counts(store) == (1, 0)
    assert client.portal.call(worker.run_once)
    child = client.get(f"/api/processing/jobs/{child['jobId']}").json()
    assert child["status"] == "ready", child
    if model_id == "raster-summary":
        assert Decimal(child["result"]["rows"][0]["value"]) == expected
    else:
        file = next(
            file
            for file in child["artifacts"]["files"]
            if file["mediaType"] == "image/tiff"
        )
        with (
            rasterio.MemoryFile(client.get(file["url"]).content) as memory,
            memory.open() as raster,
        ):
            numpy.testing.assert_array_equal(raster.read(1, masked=True), original)
            numpy.testing.assert_array_equal(
                raster.read_masks(1), (~original.mask).astype("uint8") * 255
            )
    yaml = client.get(f"/api/processing/jobs/{child['jobId']}/run-yaml")
    document = parse_yaml(yaml.content, run=True)
    assert document["invocation"]["inputs"]["raster"] == source
    recorded = document["execution"]["sources"]["raster"]
    assert recorded["sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()
    assert recorded["bytes"] == path.stat().st_size
    assert str(worker.artifacts.root) not in yaml.text
    assert input_counts(store) == (0, 0)
    client.portal.call(worker.cleanup)
    assert not path.exists()
    with psycopg.connect(store.conninfo) as connection:
        assert (
            connection.execute(
                "SELECT reserved_bytes FROM processing.jobs WHERE id=%s",
                (parent["jobId"],),
            ).fetchone()[0]
            == 0
        )


@pytest.mark.parametrize("operation", ["raster-clips", "raster-calculations"])
def test_existing_calculations_accept_private_sources_with_cache_authorization(
    model_boundary: Any, store: Any, operation: str
) -> None:
    """Ordinary operations use the same retained input and cannot serve it to strangers.

    Args:
        model_boundary: Actual model/ordinary HTTP routes and native worker.
        store: Disposable PostgreSQL store.
        operation: Existing clip or scalar calculation endpoint.
    """
    client, worker, _ = model_boundary
    parent, source, path = publish_input(model_boundary)
    inputs = (
        {"source": source, "selectedBounds": AREA}
        if operation == "raster-clips"
        else {
            "sources": {"a": source},
            "wholeRaster": True,
            "calculations": [{"label": "Cells", "expression": "count(a)"}],
        }
    )
    body = {**inputs, "requestId": uuid4().hex}
    route = f"/api/processing/{operation}"
    response = client.post(route, json=body, headers=HEADERS)
    assert response.status_code == 202, response.text
    job = response.json()
    assert input_counts(store) == (1, 0)
    assert client.portal.call(worker.run_once)
    result = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert result["status"] == "ready", result
    if operation == "raster-calculations":
        assert (
            int(result["result"]["rows"][0]["value"]) == parent["result"]["validPixels"]
        )
        second = client.post(
            route, json={**body, "requestId": uuid4().hex}, headers=HEADERS
        ).json()
        assert client.portal.call(worker.run_once)
        reused = client.get(f"/api/processing/jobs/{second['jobId']}").json()
        assert reused["result"]["cacheHit"]
    with TestClient(client.app, base_url="https://testserver") as foreign:
        denied = foreign.post(
            route, json={**body, "requestId": uuid4().hex}, headers=HEADERS
        )
        assert denied.status_code == 404, denied.text
    assert input_counts(store) == (0, 0)
    assert (
        client.delete(
            f"/api/processing/jobs/{parent['jobId']}", headers=HEADERS
        ).status_code
        == 200
    )
    assert (
        client.post(route, json=body, headers=HEADERS).json()["jobId"] == job["jobId"]
    )
    assert (
        client.post(
            route, json={**body, "requestId": uuid4().hex}, headers=HEADERS
        ).status_code
        == 409
    )


@pytest.mark.parametrize(
    "finish", ["cancel", "failure", "deadline", "restart", "changed"]
)
def test_input_retention_releases_after_every_terminal_path(
    model_boundary: Any, store: Any, finish: str
) -> None:
    """Retained parent bytes remain bounded and are released after dependent work stops.

    Args:
        model_boundary: Actual model routes and native worker.
        store: Disposable PostgreSQL store.
        finish: Queued cancellation, worker failure/loss/restart, or altered input bytes.
    """
    client, worker, _ = model_boundary
    parent, source, path = publish_input(model_boundary)
    child = submit(
        client,
        model_request(
            client, inputs={"raster": source, "area": {"kind": "wholeRaster"}}
        ),
    )
    assert (
        client.delete(
            f"/api/processing/jobs/{parent['jobId']}", headers=HEADERS
        ).status_code
        == 200
    )
    assert input_counts(store) == (1, 0)
    if finish == "cancel":
        assert (
            client.post(
                f"/api/processing/jobs/{child['jobId']}/cancel", headers=HEADERS
            ).json()["status"]
            == "cancelled"
        )
    elif finish == "restart":
        assert store.interrupt_unfinished_jobs_on_restart() == 1
    elif finish == "changed":
        data = bytearray(path.read_bytes())
        data[-1] ^= 1
        path.write_bytes(data)
        assert client.portal.call(worker.run_once)
        assert (
            client.get(f"/api/processing/jobs/{child['jobId']}").json()["error"]["code"]
            == "source_changed"
        )
    else:
        claimed = store.claim_next_job()
        assert claimed["id"] == child["jobId"]
        if finish == "failure":
            assert store.finish(
                claimed["id"],
                claimed["attempt_id"],
                None,
                {"code": "test_failure", "detail": "Stopped"},
            )
        else:
            with psycopg.connect(store.conninfo) as connection:
                connection.execute(
                    "UPDATE processing.jobs SET lease_until=now()-interval '1 second' WHERE id=%s",
                    (child["jobId"],),
                )
            assert store.claim_next_job() is None
            assert input_counts(store) == (1, 0)
            client.portal.call(worker.cleanup)
            assert path.exists()
            with psycopg.connect(store.conninfo) as connection:
                connection.execute(
                    "UPDATE processing.jobs SET deadline_at=now()-interval '1 second' WHERE id=%s",
                    (child["jobId"],),
                )
            assert store.claim_next_job() is None
    assert input_counts(store) == (0, 0)
    client.portal.call(worker.cleanup)
    assert not path.exists()


def test_admission_rechecks_identity_and_excludes_unpublished_files(
    model_boundary: Any, store: Any
) -> None:
    """A prior inspection cannot grant expired data, provenance or scratch access.

    Args:
        model_boundary: Actual model HTTP and native worker.
        store: Disposable PostgreSQL store.
    """
    client, worker, service = model_boundary
    parent, source, path = publish_input(model_boundary)
    owner = hashlib.sha256(client.cookies.get(COOKIE).encode()).hexdigest()
    file = store.inspect_input_file(owner, source["jobId"], source["artifactId"])
    from eolab_app.processing.raster_operations import queue_summary
    from eolab_app.processing.aggregate_models import AggregateJobRequest

    plan = queue_summary(
        AggregateJobRequest(
            requestId=uuid4().hex,
            sources={"a": source},
            wholeRaster=True,
            calculations=[{"label": "Count", "expression": "count(a)"}],
        ),
        None,
    )
    for invalid in (
        {**source, "artifactId": "0" * 32},
        {
            **source,
            "artifactId": next(
                file["artifactId"]
                for file in parent["artifacts"]["files"]
                if file["role"] == "provenance"
            ),
        },
    ):
        response = client.post(
            "/api/processing/model-runs",
            json=model_request(
                client, inputs={"raster": invalid, "area": {"kind": "wholeRaster"}}
            ),
            headers=HEADERS,
        )
        assert response.status_code in {404, 422}, response.text
    with pytest.raises(ProcessingError, match="changed"):
        store.submit(
            owner,
            uuid4().hex,
            replace(plan, work_key=None, input_files=(replace(file, sha256="0" * 64),)),
            "a" * 64,
        )
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET expires_at=now()-interval '1 second' WHERE id=%s",
            (parent["jobId"],),
        )
    with pytest.raises(ProcessingError, match="expired"):
        store.submit(
            owner,
            uuid4().hex,
            replace(plan, work_key=None, input_files=(file,)),
            "b" * 64,
        )
    assert input_counts(store) == (0, 0)


def pause_with_open_input(
    writer: ProcessResultWriter, action: str, arguments: tuple[Any, ...]
) -> None:
    """Hold a real native input reader open until the worker stops this child.

    Args:
        writer: Supervised result pipe.
        action: Existing clip planning or execution action.
        arguments: Authorized source, specification, scratch directory and limits.
    """
    if action != "clip":
        clip_process_target(writer, action, arguments)
        return
    path, _, directory, _ = arguments
    with rasterio.open(path) as raster:
        raster.read(1)
        (directory / "input-open").touch()
        time.sleep(60)


def test_delete_and_cancel_never_unlink_an_active_native_input(
    model_boundary: Any, store: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Explicit deletion defers physical cleanup while a dependent reader is alive.

    Args:
        model_boundary: Actual HTTP, workers and local file storage.
        store: Disposable PostgreSQL store.
        monkeypatch: Substitute only the existing native clip target with a pause.
    """
    client, worker, _ = model_boundary
    parent, source, path = publish_input(model_boundary)
    child = submit(
        client,
        model_request(
            client,
            "raster-clip",
            inputs={
                "raster": source,
                "area": {"kind": "selectedArea", "selectedBounds": AREA},
            },
        ),
    )
    monkeypatch.setattr(
        "eolab_app.processing.raster_operations.clip_process_target",
        pause_with_open_input,
    )

    async def exercise() -> None:
        """Cancel the dependent job only after its native input is actually open."""
        task = asyncio.create_task(worker.run_once())
        try:
            async with asyncio.timeout(20):
                while not list(
                    (worker.artifacts.root / "attempts").glob("*/input-open")
                ):
                    if task.done():
                        await task
                        pytest.fail("Worker stopped before opening the input")
                    await asyncio.sleep(0.05)
            assert (
                client.delete(
                    f"/api/processing/jobs/{parent['jobId']}", headers=HEADERS
                ).status_code
                == 200
            )
            await worker.cleanup()
            assert path.exists() and input_counts(store) == (1, 0)
            assert (
                client.post(
                    f"/api/processing/jobs/{child['jobId']}/cancel", headers=HEADERS
                ).json()["status"]
                == "cancelling"
            )
            assert await task
            assert input_counts(store) == (0, 0)
            await worker.cleanup()
            assert not path.exists()
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(exercise())


def test_filtered_clip_reuse_preserves_internal_mask(
    model_boundary: Any, boundary: Any, store: Any, tmp_path: Path
) -> None:
    """A filtered polygon's excluded cells stay excluded in subsequent models.

    Args:
        model_boundary: Actual Models route and native worker.
        boundary: Existing catalog-vector fixture used to register original polygons.
        store: Disposable PostgreSQL store.
        tmp_path: Confined fixture source directory.
    """
    client, worker, _ = model_boundary
    vector = tmp_path / "triangle.gpkg"
    write_geopackage_layer(
        vector,
        "triangle",
        crs="EPSG:4326",
        geometry={
            "type": "Polygon",
            "coordinates": [[[0, 10], [1, 10], [0, 9], [0, 10]]],
        },
    )
    selection = register_selection(boundary[0], vector)
    parent, source, path = publish_input(
        model_boundary, {"kind": "catalogSelection", "selection": selection}
    )
    with rasterio.open(path) as raster:
        values = raster.read(1, masked=True)
        assert 0 < values.count() < values.size
    child = submit(
        client,
        model_request(
            client, inputs={"raster": source, "area": {"kind": "wholeRaster"}}
        ),
    )
    assert client.portal.call(worker.run_once)
    child = client.get(f"/api/processing/jobs/{child['jobId']}").json()
    assert child["status"] == "ready", child
    assert Decimal(child["result"]["rows"][0]["value"]) == Decimal(
        str(values.sum(dtype="float64"))
    )
    clipped = submit(
        client,
        model_request(
            client,
            "raster-clip",
            inputs={
                "raster": source,
                "area": {
                    "kind": "selectedArea",
                    "selectedBounds": {
                        "west": 0.0,
                        "south": 9.0,
                        "east": 1.0,
                        "north": 10.0,
                    },
                },
            },
        ),
    )
    assert client.portal.call(worker.run_once)
    clipped = client.get(f"/api/processing/jobs/{clipped['jobId']}").json()
    assert clipped["status"] == "ready", clipped
    file = next(
        file
        for file in clipped["artifacts"]["files"]
        if file["mediaType"] == "image/tiff"
    )
    with (
        rasterio.MemoryFile(client.get(file["url"]).content) as memory,
        memory.open() as raster,
    ):
        numpy.testing.assert_array_equal(
            raster.read_masks(1), (~values.mask).astype("uint8") * 255
        )
        numpy.testing.assert_array_equal(
            raster.read(1, masked=True).compressed(), values.compressed()
        )


def test_multiple_children_account_parent_storage_once_and_release_last(
    model_boundary: Any, store: Any
) -> None:
    """Two accepted jobs retain one physical parent reservation until both stop.

    Args:
        model_boundary: Actual model routes and worker.
        store: Disposable PostgreSQL store.
    """
    client, worker, _ = model_boundary
    parent, source, path = publish_input(model_boundary)
    with psycopg.connect(store.conninfo) as connection:
        retained_bytes = connection.execute(
            "SELECT sum(reserved_bytes) FROM processing.jobs"
        ).fetchone()[0]
    children = [
        submit(
            client,
            model_request(
                client, inputs={"raster": source, "area": {"kind": "wholeRaster"}}
            ),
        )
        for _ in range(2)
    ]
    with psycopg.connect(store.conninfo) as connection:
        assert (
            connection.execute(
                "SELECT sum(reserved_bytes) FROM processing.jobs"
            ).fetchone()[0]
            == retained_bytes
        )
    assert input_counts(store) == (2, 0)
    client.delete(f"/api/processing/jobs/{parent['jobId']}", headers=HEADERS)
    client.post(f"/api/processing/jobs/{children[0]['jobId']}/cancel", headers=HEADERS)
    client.portal.call(worker.cleanup)
    assert input_counts(store) == (1, 0) and path.exists()
    client.post(f"/api/processing/jobs/{children[1]['jobId']}/cancel", headers=HEADERS)
    client.portal.call(worker.cleanup)
    assert input_counts(store) == (0, 0) and not path.exists()


def test_new_yaml_recipe_reuses_private_raster_contract(
    model_boundary: Any, store: Any
) -> None:
    """A renamed recipe/input runs private data without route or adapter branches.

    Args:
        model_boundary: Actual Models registry, routes and worker.
        store: Disposable PostgreSQL store.
    """
    from eolab_app.processing.model_definitions import ModelDefinition, ModelRegistry

    client, worker, service = model_boundary
    _, source, _ = publish_input(model_boundary)
    definition = (
        ModelRegistry.load_installed().get("raster-summary", "1.1.0").to_document()
    )
    definition["id"] = "habitat-total"
    definition["inputs"]["habitat"] = definition["inputs"].pop("raster")
    definition["steps"][0]["inputs"]["raster"]["input"] = "habitat"
    service.model_registry = ModelRegistry(
        (ModelDefinition.model_validate(definition),)
    )
    service.model_authorizer = None
    child = submit(
        client,
        model_request(
            client,
            "habitat-total",
            inputs={"habitat": source, "area": {"kind": "wholeRaster"}},
        ),
    )
    assert client.portal.call(worker.run_once)
    result = client.get(f"/api/processing/jobs/{child['jobId']}").json()
    assert result["status"] == "ready", result
    assert input_counts(store) == (0, 0)


def test_retained_parent_cannot_make_child_wait_forever_for_its_own_disk(
    model_boundary: Any, store: Any
) -> None:
    """Reject a reservation that fits alone but cannot fit beside its retained input.

    Args:
        model_boundary: Actual Models service and native worker.
        store: Disposable PostgreSQL store.
    """
    client, _, _ = model_boundary
    _, source, _ = publish_input(model_boundary)
    child = submit(
        client,
        model_request(
            client, inputs={"raster": source, "area": {"kind": "wholeRaster"}}
        ),
    )
    claimed = store.claim_next_job()
    prepared = PreparedJobPlan(
        specification=claimed["spec"],
        summary=claimed["summary"],
        operation=claimed["operation"],
        reserved_bytes=store.limits.max_stored_bytes,
    )
    with pytest.raises(ProcessingError) as denied:
        store.save_prepared_job(child["jobId"], claimed["attempt_id"], prepared)
    assert denied.value.code == "storage_full"
    assert store.finish(
        child["jobId"],
        claimed["attempt_id"],
        None,
        {"code": "storage_full", "detail": "Storage unavailable"},
    )
    assert input_counts(store) == (0, 0)


def test_concurrent_retries_retain_one_input_and_failed_admission_retains_none(
    model_boundary: Any, store: Any
) -> None:
    """Retry serialization and rollback apply to dependent-file admission as one unit.

    Args:
        model_boundary: Actual Models service and native worker.
        store: Disposable PostgreSQL store.
    """
    from eolab_app.processing.aggregate_models import AggregateJobRequest
    from eolab_app.processing.raster_operations import queue_summary

    client, _, _ = model_boundary
    _, source, _ = publish_input(model_boundary)
    owner = hashlib.sha256(client.cookies.get(COOKIE).encode()).hexdigest()
    file = store.inspect_input_file(owner, source["jobId"], source["artifactId"])
    request = AggregateJobRequest(
        requestId=uuid4().hex,
        sources={"a": source},
        wholeRaster=True,
        calculations=[{"label": "Count", "expression": "count(a)"}],
    )
    prepared = replace(queue_summary(request, None), work_key=None, input_files=(file,))
    with ThreadPoolExecutor(max_workers=2) as pool:
        calls = [
            pool.submit(store.submit, owner, request.requestId, prepared, "a" * 64)
            for _ in range(2)
        ]
        rows = [call.result() for call in calls]
    assert rows[0]["id"] == rows[1]["id"]
    assert input_counts(store) == (1, 0)
    store.limits = replace(store.limits, max_owner_waiting_jobs=1)
    with pytest.raises(ProcessingError) as denied:
        store.submit(owner, uuid4().hex, prepared, "b" * 64)
    assert denied.value.code == "owner_queue_full"
    assert input_counts(store) == (1, 0)
    store.cancel(rows[0]["id"], owner)
    assert input_counts(store) == (0, 0)


def test_retained_inputs_cannot_make_queued_jobs_wait_for_each_other(
    model_boundary: Any, store: Any
) -> None:
    """Reject dependent work when collectively retained inputs would block its space.

    Args:
        model_boundary: Actual Models routes, publication and cleanup worker.
        store: Disposable PostgreSQL store used for reservation admission.
    """
    client, worker, _ = model_boundary
    parents = [publish_input(model_boundary) for _ in range(2)]
    with psycopg.connect(store.conninfo) as connection:
        largest_parent = connection.execute(
            "SELECT max(reserved_bytes) FROM processing.jobs"
        ).fetchone()[0]
    children = [
        submit(
            client,
            model_request(
                client, inputs={"raster": source, "area": {"kind": "wholeRaster"}}
            ),
        )
        for _, source, _ in parents
    ]
    required = store.limits.max_stored_bytes - largest_parent
    claimed = store.claim_next_job()
    prepared = PreparedJobPlan(
        specification=claimed["spec"],
        summary=claimed["summary"],
        operation=claimed["operation"],
        reserved_bytes=required,
    )
    assert claimed["id"] == children[0]["jobId"]
    with pytest.raises(ProcessingError) as denied:
        store.save_prepared_job(claimed["id"], claimed["attempt_id"], prepared)
    assert denied.value.code == "storage_full"
    assert store.finish(
        claimed["id"],
        claimed["attempt_id"],
        None,
        {"code": "storage_full", "detail": "Storage unavailable"},
    )
    client.delete(f"/api/processing/jobs/{parents[0][0]['jobId']}", headers=HEADERS)
    client.portal.call(worker.cleanup)
    assert not parents[0][2].exists() and parents[1][2].exists()
    assert input_counts(store) == (1, 0)
    claimed = store.claim_next_job()
    assert claimed["id"] == children[1]["jobId"]
    prepared = replace(
        prepared, specification=claimed["spec"], summary=claimed["summary"]
    )
    admitted = store.save_prepared_job(claimed["id"], claimed["attempt_id"], prepared)
    assert admitted["status"] == "running"
    assert admitted["reserved_bytes"] == required
    assert store.finish(
        claimed["id"],
        claimed["attempt_id"],
        None,
        {"code": "test_complete", "detail": "Reservation verified"},
    )
    assert input_counts(store) == (0, 0)


def test_published_scientific_intermediate_is_a_reusable_raster(
    multiple_boundary: Any, store: Any
) -> None:
    """Published coverage can be reused while calculation scratch remains private.

    Args:
        multiple_boundary: Existing registered multi-output operation fixture.
        store: Disposable PostgreSQL store.
    """
    from eolab_app.processing.model_definitions import ModelRegistry

    client, worker, service, body = multiple_boundary
    parent = submit(client, body)
    assert client.portal.call(worker.run_once)
    parent = client.get(f"/api/processing/jobs/{parent['jobId']}").json()
    coverage = next(
        file
        for file in parent["artifacts"]["files"]
        if file["role"] == "intermediate" and file["mediaType"] == "image/tiff"
    )
    assert coverage["role"] == "intermediate"
    assert all(
        file["filename"] != "scratch.bin" for file in parent["artifacts"]["files"]
    )
    service.model_registry = ModelRegistry.load_installed()
    source = {
        "kind": "runArtifact",
        "jobId": parent["jobId"],
        "artifactId": coverage["artifactId"],
    }
    child = submit(
        client,
        model_request(
            client, inputs={"raster": source, "area": {"kind": "wholeRaster"}}
        ),
    )
    assert client.portal.call(worker.run_once)
    result = client.get(f"/api/processing/jobs/{child['jobId']}").json()
    assert result["status"] == "ready", result
    assert (
        Decimal(result["result"]["rows"][0]["value"]) == parent["result"]["validPixels"]
    )
    assert input_counts(store) == (0, 0)


def test_prepared_checksum_must_match_the_accepted_input(
    model_boundary: Any, store: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A mismatched persisted checksum fails without publishing a misleading result.

    Args:
        model_boundary: Actual model HTTP and native worker.
        store: Disposable PostgreSQL store.
        monkeypatch: Alter the prepared specification at its persistence boundary.
    """
    client, worker, _ = model_boundary
    _, source, _ = publish_input(model_boundary)
    child = submit(
        client,
        model_request(
            client, inputs={"raster": source, "area": {"kind": "wholeRaster"}}
        ),
    )
    save_prepared_job = store.save_prepared_job

    def save_changed_checksum(
        identifier: str, attempt: str, prepared: PreparedJobPlan
    ) -> dict[str, Any]:
        """Persist a specification whose input checksum differs from its grant.

        Args:
            identifier: Claimed computation ID.
            attempt: Current execution fencing token.
            prepared: Validated calculation and reservation to persist.

        Returns:
            Updated job row containing the altered specification.
        """
        specification = {
            **prepared.specification,
            "calculation": {
                **prepared.specification["calculation"],
                "sourceChecksum": "0" * 64,
            },
        }
        return save_prepared_job(
            identifier, attempt, replace(prepared, specification=specification)
        )

    monkeypatch.setattr(store, "save_prepared_job", save_changed_checksum)
    assert client.portal.call(worker.run_once)
    result = client.get(f"/api/processing/jobs/{child['jobId']}").json()
    assert result["status"] == "failed", result
    assert result["error"]["code"] == "source_changed"
    assert result["result"] is None
    assert input_counts(store) == (0, 0)
