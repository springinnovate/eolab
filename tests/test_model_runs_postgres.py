"""Real model HTTP, catalog, PostgreSQL and supervised aggregate boundaries."""

from dataclasses import replace
from datetime import datetime, timedelta, timezone
import asyncio
import hashlib
import numpy
import rasterio
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
from test_processing_jobs import (
    boundary,
    store,
    HEADERS,
    AREA,
    clip_inputs,
    _paused_clip,
)
from test_raster_clips import SOURCE
from test_processing_calculations import paused_calculation
from test_polygon_summary_areas import rectangle
from catalog_selection_support import register_selection, write_geopackage_layer
import eolab_app.processing.worker as worker_module
from eolab_app.raster.models import AuthorizedRaster


@pytest.fixture
def downstream_boundary(tmp_path: Path, store: Any) -> Iterator[Any]:
    """Compose downstream HTTP, real source readers, PostgreSQL and the native worker.

    Args:
        tmp_path: Isolated mounted inputs and private output storage.
        store: Disposable real Processing database.

    Yields:
        Client, worker, captured numerical request, catalog metadata and source paths.
    """
    import httpx2
    from app_support import mounted_geotiff_item
    from catalog_selection_support import FixtureCatalog
    from test_downstream_model import downstream_fixture
    from eolab_app.processing.artifacts import LocalJobArtifacts
    from eolab_app.processing.native_processes import create_native_process
    from eolab_app.processing.prepared_hydrology import PreparedHydrologyRegistry
    from eolab_app.raster.catalog import StacRasterCatalog
    from eolab_app.raster.source_authorization import CatalogRasterSourceAuthorizer
    from eolab_app.raster.sources import MountedRasterResolver
    from eolab_app.vector.models import ResolvedVectorSource
    from eolab_app.vector.sampling import VectorSamplingService

    pytest.importorskip("ecoshard.geoprocessing.routing")
    sources, request, _ = downstream_fixture(tmp_path / "sources")
    references = {
        "values": request.values,
        "dem": request.hydrology.definition.dem,
        "starting_mask": request.starting_mask.source,
    }
    items = {
        reference.item_id: {
            **mounted_geotiff_item(sources.rasters[name].as_uri()),
            "id": reference.item_id,
        }
        for name, reference in references.items()
    }

    def catalog_request(request: httpx2.Request) -> httpx2.Response:
        """Return authoritative fixture metadata at the ordinary STAC boundary.

        Args:
            request: Catalog Item read issued by source authorization.

        Returns:
            The selected signed source Item, without any renderer state.
        """
        return httpx2.Response(200, json=items[request.url.path.rsplit("/", 1)[-1]])

    catalog = httpx2.AsyncClient(transport=httpx2.MockTransport(catalog_request))
    authorizer = CatalogRasterSourceAuthorizer(
        StacRasterCatalog(catalog, "http://catalog"), MountedRasterResolver(tmp_path)
    )
    vectors = FixtureCatalog(
        ResolvedVectorSource(
            "mounted", "geopackage", sources.network.path, "data", "watersheds"
        )
    )
    reader = VectorSamplingService(vectors, vectors)
    artifacts = LocalJobArtifacts(tmp_path / "artifacts")
    artifacts.initialize()
    native = create_native_process(store.limits)
    worker = worker_module.ProcessingWorker(
        authorizer, store, artifacts, store.limits, areas=reader, native=native
    )
    service = ProcessingService(
        store,
        artifacts,
        model_authorizer=authorizer,
        hydrology_registry=PreparedHydrologyRegistry((request.hydrology,)),
        hydrology_selections=reader,
    )
    app = FastAPI()
    app.include_router(create_processing_router(service))
    with TestClient(app, base_url="https://testserver") as client:
        try:
            yield client, worker, request, items, sources
        finally:
            client.portal.call(native.close)
            client.portal.call(catalog.aclose)


@pytest.mark.parametrize(
    "change_source", [None, "dem", "starting_mask", "private_values"]
)
def test_downstream_http_captures_sources_and_publishes_owned_files(
    downstream_boundary: Any, change_source: str | None
) -> None:
    """A model run owns its output files and refuses sources changed after submission.

    Args:
        downstream_boundary: Real API, database, source and native worker composition.
        change_source: Changed catalog input, a private values raster, or unchanged inputs.
    """
    client, worker, request, items, sources = downstream_boundary
    values = request.values.model_dump(by_alias=True)
    if change_source == "private_values":
        parent = submit(
            client,
            model_request(
                client,
                "raster-clip",
                inputs={
                    "raster": values,
                    "area": {
                        "kind": "selectedArea",
                        "selectedBounds": {
                            "west": 0,
                            "south": 0,
                            "east": 6,
                            "north": 4,
                        },
                    },
                },
            ),
        )
        assert client.portal.call(worker.run_once)
        parent = client.get(f"/api/processing/jobs/{parent['jobId']}").json()
        assert parent["status"] == "ready", parent
        file = next(
            file
            for file in parent["artifacts"]["files"]
            if file["mediaType"] == "image/tiff"
        )
        values = {
            "kind": "runArtifact",
            "jobId": parent["jobId"],
            "artifactId": file["artifactId"],
        }
    body = model_request(
        client,
        "downstream-beneficiaries",
        inputs={
            "starting_mask": request.starting_mask.model_dump(
                mode="json", by_alias=True
            ),
            "hydrology": request.hydrology.reference.model_dump(),
            "values": values,
        },
        parameters={"buffer_m": 0},
    )
    job = submit(client, body)
    identifier = job["jobId"]
    pending = parse_yaml(
        client.get(f"/api/processing/jobs/{identifier}/run-yaml").content, run=True
    )
    assert set(pending["execution"]["additionalSources"]) == {"dem", "starting_mask"}
    if change_source in {"dem", "starting_mask"}:
        reference = (
            request.hydrology.definition.dem
            if change_source == "dem"
            else request.starting_mask.source
        )
        with rasterio.open(sources.rasters[change_source], "r+") as dataset:
            dataset.update_tags(changed="after submission")
        from app_support import mounted_geotiff_item

        items[reference.item_id] = {
            **mounted_geotiff_item(sources.rasters[change_source].as_uri()),
            "id": reference.item_id,
        }
    assert client.portal.call(worker.run_once)
    ready = client.get(f"/api/processing/jobs/{identifier}").json()
    if change_source in {"dem", "starting_mask"}:
        assert ready["status"] == "failed", ready
        assert ready["error"]["code"] == "source_changed", ready
        assert ready.get("result") is None
        return
    assert ready["status"] == "ready", ready
    assert float(ready["result"]["rows"][0]["value"]) == 24
    assert {item["name"] for item in ready["artifacts"]["files"]} == {
        "statistics",
        "coverage",
        "starting_mask",
        "provenance",
    }
    exported = client.get(f"/api/processing/jobs/{identifier}/run-yaml")
    RunDocument.model_validate(parse_yaml(exported.content, run=True))
    assert str(sources.rasters["dem"]) not in exported.text
    url = ready["result"]["url"]
    assert client.get(url).status_code == 200
    client.cookies.clear()
    assert client.get(url).status_code == 404


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


def model_request(
    client: TestClient, model_id: str = "raster-summary", **changes: Any
) -> dict[str, Any]:
    """Bind discovery metadata to the existing mounted-raster fixture.

    Args:
        client: Current browser-session client.
        model_id: Installed recipe to bind; defaults to the original summary model.
        changes: Explicit request replacements for a test case.

    Returns:
        Ready-to-submit path-free model request.
    """
    response = client.get("/api/processing/models")
    assert response.status_code == 200, response.text
    definition = next(
        item for item in response.json()["models"] if item["id"] == model_id
    )
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
    invocation_response = client.get(f"/api/processing/jobs/{identifier}/invocation")
    assert invocation_response.status_code == 200
    assert invocation_response.json() == captured["invocation"]
    assert "no-store" in invocation_response.headers["cache-control"]
    assert "source_path" not in invocation_response.text
    assert captured["invocation"]["parameters"] == {"summary": "sum(a)"}
    assert captured["execution"]["state"] == "pending"
    assert "source_path" not in pending.text and "://" not in pending.text
    service.model_registry = ModelRegistry(())
    assert submit(client, body)["jobId"] == identifier
    assert (
        client.get(
            "/api/processing/models/raster-summary/versions/1.1.0/yaml"
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


@pytest.mark.parametrize("model_id", ["raster-summary", "raster-clip"])
def test_model_owner_idempotency_pagination_and_cancel(
    model_boundary: Any, store: Any, model_id: str
) -> None:
    """Model history remains owned and independent of more than 50 later jobs.

    Args:
        model_id: Summary or clip recipe under the same lifecycle contract.
        model_boundary: HTTP and native worker fixture.
        store: Real storage for opaque unrelated-job fixtures.
    """
    client, worker, _ = model_boundary
    first_body = model_request(client, model_id)
    first = submit(client, first_body)
    assert submit(client, first_body)["jobId"] == first["jobId"]
    conflict = client.post(
        "/api/processing/model-runs",
        headers=HEADERS,
        json={**first_body, "label": "Changed"},
    )
    assert conflict.status_code == 409
    second = submit(client, model_request(client, model_id, label="Second"))
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
        assert (
            stranger.get(
                f"/api/processing/jobs/{first['jobId']}/invocation"
            ).status_code
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


def test_model_history_pages_through_more_than_fifty_runs(model_boundary: Any) -> None:
    """Retrieve every retained model run when the session has more than 50.

    Args:
        model_boundary: Model HTTP service and its real PostgreSQL store.
    """
    client, _, _ = model_boundary
    template = model_request(client)
    submitted = []
    for index in range(55):
        job = submit(
            client,
            {**template, "requestId": uuid4().hex, "label": f"Run {index}"},
        )
        submitted.append(job["jobId"])
        # Keep the queue allowance available without deleting history.
        response = client.post(
            f"/api/processing/jobs/{job['jobId']}/cancel", headers=HEADERS
        )
        assert response.status_code == 202, response.text

    collected = []
    cursor = None
    for expected_size in (20, 20, 15):
        params = {"limit": 20}
        if cursor is not None:
            params["cursor"] = cursor
        response = client.get("/api/processing/model-runs", params=params)
        assert response.status_code == 200, response.text
        page = response.json()
        assert len(page["jobs"]) == expected_size
        collected.extend(job["jobId"] for job in page["jobs"])
        cursor = page["nextCursor"]
    assert cursor is None
    assert collected == list(reversed(submitted))


@pytest.mark.parametrize("terminal", ["ready", "interrupted", "cancelled", "failed"])
@pytest.mark.parametrize("model_id", ["raster-summary", "raster-clip"])
def test_model_capture_survives_cleanup_then_expires(
    model_boundary: Any, store: Any, terminal: str, model_id: str
) -> None:
    """Retention starts at the first terminal transition, independent of cleanup.

    Args:
        model_id: Summary or clip recipe under the same lifecycle contract.
        model_boundary: Model application and worker.
        store: Real PostgreSQL adapter.
        terminal: Completion or termination path under test.
    """
    client, worker, _ = model_boundary
    job = submit(client, model_request(client, model_id))
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
    assert (
        client.get(f"/api/processing/jobs/{identifier}/invocation").status_code == 200
    )
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
    assert (
        client.get(f"/api/processing/jobs/{identifier}/invocation").status_code == 410
    )
    store.cleanup_candidates()
    with psycopg.connect(store.conninfo) as connection:
        assert connection.execute(
            "SELECT retained_metadata,retained_outcome FROM processing.jobs WHERE id=%s",
            (identifier,),
        ).fetchone() == (None, None)


@pytest.mark.parametrize("retention_seconds", [3600, 14 * 86_400])
def test_model_metadata_keeps_the_retention_chosen_at_submission(
    model_boundary: Any, store: Any, retention_seconds: int
) -> None:
    """Honor a configured lifetime without shortening it during later cleanup.

    Args:
        model_boundary: Model HTTP service and its worker.
        store: Real job storage with replaceable deployment limits.
        retention_seconds: A shorter or longer lifetime than the seven-day default.
    """
    client, _, _ = model_boundary
    store.limits = replace(store.limits, metadata_ttl_seconds=retention_seconds)
    job = submit(client, model_request(client))
    identifier = job["jobId"]
    # A deployment setting changed while this job waits must not alter its promise.
    store.limits = replace(store.limits, metadata_ttl_seconds=2 * 86_400)
    before = datetime.now(timezone.utc)
    cancelled = client.post(
        f"/api/processing/jobs/{identifier}/cancel", headers=HEADERS
    )
    assert cancelled.status_code == 202, cancelled.text
    after = datetime.now(timezone.utc)
    deadline = datetime.fromisoformat(cancelled.json()["metadataExpiresAt"])
    assert before + timedelta(seconds=retention_seconds) <= deadline
    assert deadline <= after + timedelta(seconds=retention_seconds)
    store.cleaned(identifier)
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET updated_at=now()-interval '8 days' WHERE id=%s",
            (identifier,),
        )
    store.cleanup_candidates()
    assert client.get(f"/api/processing/jobs/{identifier}/run-yaml").status_code == 200
    assert (
        client.get(f"/api/processing/jobs/{identifier}").json()["metadataExpiresAt"]
        == cancelled.json()["metadataExpiresAt"]
    )
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET metadata_expires_at=now()-interval '1 second' WHERE id=%s",
            (identifier,),
        )
    store.cleanup_candidates()
    assert client.get(f"/api/processing/jobs/{identifier}").status_code == 404


@pytest.mark.parametrize("model_id", ["raster-summary", "raster-clip"])
def test_model_delete_revokes_exports_and_retry_recovers_after_input_loss(
    model_boundary: Any, store: Any, model_id: str
) -> None:
    """Deleting a terminal run revokes its exports while preserving retry tombstones.

    Args:
        model_id: Summary or clip recipe under the same lifecycle contract.
        model_boundary: Composed HTTP and native worker.
        store: Real owned job storage.
    """
    client, worker, service = model_boundary
    body = model_request(client, model_id)
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


@pytest.mark.parametrize("model_id", ["raster-summary", "raster-clip"])
def test_model_vector_filter_and_changed_signature(
    model_boundary: Any, boundary: Any, tmp_path: Path, model_id: str
) -> None:
    """Capture the actual filtered catalog descriptor and revalidate it in the worker.

    Args:
        model_id: Summary or clip recipe under the same lifecycle contract.
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
        model_id,
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
    stale = submit(client, model_request(client, model_id, inputs=body["inputs"]))
    assert client.portal.call(worker.run_once)
    failed = client.get(f"/api/processing/jobs/{stale['jobId']}").json()
    assert (
        failed["status"] == "failed" and failed["error"]["code"] == "source_unavailable"
    )


@pytest.mark.parametrize("model_id", ["raster-summary", "raster-clip"])
def test_model_raster_identity_rechecked_before_execution(
    model_boundary: Any, model_id: str
) -> None:
    """A changed authorized catalog signature cannot silently replace accepted input.

    Args:
        model_id: Summary or clip recipe under the same lifecycle contract.
        model_boundary: HTTP/worker boundary with replaceable catalog provider.
    """
    client, worker, _ = model_boundary
    job = submit(client, model_request(client, model_id))
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


@pytest.mark.parametrize("model_id", ["raster-summary", "raster-clip"])
def test_model_navigation_progress_and_running_cancel(
    model_boundary: Any, monkeypatch: pytest.MonkeyPatch, model_id: str
) -> None:
    """Recover through a new client and cancel after the real native result is written.

    Args:
        model_id: Summary or clip recipe under the same lifecycle contract.
        model_boundary: Model API, native worker and private result storage.
        monkeypatch: Pause the native process after actual numerical execution.
    """
    client, worker, _ = model_boundary
    job = submit(client, model_request(client, model_id))
    identifier = job["jobId"]
    with TestClient(client.app, base_url="https://testserver") as reloaded:
        reloaded.cookies.update(client.cookies)
        assert (
            reloaded.get(f"/api/processing/jobs/{identifier}").json()["status"]
            == "queued"
        )
    if model_id == "raster-clip":
        (worker.artifacts.root / "pause-after-output").touch()
        monkeypatch.setattr(
            "eolab_app.processing.raster_operations.clip_process_target", _paused_clip
        )
    else:
        monkeypatch.setattr(
            "eolab_app.processing.raster_operations.aggregate_process_target",
            paused_calculation,
        )

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


def test_duplicate_saved_model_inputs_creates_an_independent_run(
    model_boundary: Any,
) -> None:
    """Run an edited copy without changing its original inputs or summary result.

    Args:
        model_boundary: Real model HTTP, storage and native worker fixture.
    """
    client, worker, _ = model_boundary
    original = submit(client, model_request(client))
    assert client.portal.call(worker.run_once)
    identifier = original["jobId"]
    saved = client.get(f"/api/processing/jobs/{identifier}/invocation").json()
    copied = submit(
        client,
        {
            "requestId": uuid4().hex,
            "model": {
                key: saved["model"][key]
                for key in ("id", "version", "definitionSha256")
            },
            "inputs": saved["inputs"],
            "parameters": {"summary": "mean(a)"},
            "label": "Edited copy",
        },
    )
    assert copied["jobId"] != identifier
    assert client.portal.call(worker.run_once)
    assert (
        client.get(f"/api/processing/jobs/{copied['jobId']}").json()["status"]
        == "ready"
    )
    assert client.get(f"/api/processing/jobs/{identifier}/invocation").json() == saved
    assert (
        client.get(f"/api/processing/jobs/{identifier}").json()["result"]["rows"][0][
            "expression"
        ]
        == "sum(a)"
    )


def test_clip_model_download_matches_existing_clip_and_keeps_ownership(
    model_boundary: Any, boundary: Any, store: Any
) -> None:
    """Download a real COG through Models with native values and owned transfer rules.

    Args:
        model_boundary: Real model HTTP, worker and storage composition.
        boundary: Original clip API and mounted raster fixture.
        store: PostgreSQL lifecycle storage for metadata-expiry checks.
    """
    client, worker, _ = model_boundary
    body = model_request(client, "raster-clip")
    job = submit(client, body)
    assert submit(client, body)["jobId"] == job["jobId"]
    ordinary = client.post(
        "/api/processing/raster-clips",
        json={**clip_inputs(client), "requestId": uuid4().hex},
        headers=HEADERS,
    )
    assert ordinary.status_code == 202
    assert ordinary.json()["jobId"] != job["jobId"]
    assert client.portal.call(worker.run_once)
    assert client.portal.call(worker.run_once)
    ready = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert ready["status"] == "ready", ready
    result = ready["result"]
    assert (
        result["kind"] == "raster"
        and result["mediaType"] == "image/tiff"
        and "rows" not in result
    )
    download = client.get(result["url"])
    assert (
        download.status_code == 200 and download.headers["content-type"] == "image/tiff"
    )
    assert hashlib.sha256(download.content).hexdigest() == result["sha256"]
    partial = client.get(result["url"], headers={"Range": "bytes=0-15"})
    assert partial.status_code == 206 and partial.content == download.content[:16]
    legacy = client.get(f"/api/processing/jobs/{ordinary.json()['jobId']}").json()
    assert legacy["status"] == "ready", legacy
    with (
        rasterio.MemoryFile(download.content) as file,
        file.open() as clipped,
        rasterio.MemoryFile(
            client.get(legacy["result"]["url"]).content
        ) as original_file,
        original_file.open() as original,
    ):
        assert clipped.tags(ns="IMAGE_STRUCTURE")["LAYOUT"] == "COG"
        assert clipped.transform == original.transform and clipped.crs == original.crs
        assert (
            clipped.dtypes == original.dtypes
            and clipped.scales == (2,)
            and clipped.offsets == (-1,)
        )
        numpy.testing.assert_array_equal(clipped.read(1), original.read(1))
        numpy.testing.assert_array_equal(clipped.read_masks(1), original.read_masks(1))
        assert int(numpy.count_nonzero(clipped.read_masks(1))) == result["validPixels"]
    with TestClient(client.app, base_url="https://testserver") as stranger:
        for suffix in ("", "/result", "/provenance", "/run-yaml"):
            assert (
                stranger.get(f"/api/processing/jobs/{job['jobId']}{suffix}").status_code
                == 404
            )
    run = parse_yaml(
        client.get(f"/api/processing/jobs/{job['jobId']}/run-yaml").content, run=True
    )
    RunDocument.model_validate(run)
    assert run["execution"]["numericalPolicy"]["numericInclusion"] == "all_touched"
    assert run["execution"]["outcome"]["raster"]["sha256"] == result["sha256"]
    assert client.get(result["provenanceUrl"]).json()["operation"] == "raster.clip.v1"
    # A shorter metadata lifetime must not break an otherwise available TIFF.
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET metadata_expires_at=now()-interval '1 second' WHERE id=%s",
            (job["jobId"],),
        )
    store.cleanup_candidates()
    assert (
        client.get(f"/api/processing/jobs/{job['jobId']}/run-yaml").status_code == 410
    )
    assert (
        client.get(f"/api/processing/jobs/{job['jobId']}").json()["result"]["kind"]
        == "raster"
    )
    assert client.get(result["url"]).status_code == 200


@pytest.mark.parametrize("model_id", ["raster-summary", "raster-clip"])
def test_new_yaml_recipe_runs_through_http_storage_and_downloads(
    model_boundary: Any, model_id: str
) -> None:
    """New recipe names and bindings require no API, worker or serializer changes.

    Args:
        model_boundary: Real catalog, HTTP, PostgreSQL and native worker composition.
        model_id: Registered operation to reuse in an unfamiliar recipe.
    """
    from model_recipe_support import custom_recipe

    client, worker, service = model_boundary
    definition = custom_recipe(model_id)
    service.model_registry = ModelRegistry((definition,))
    body = model_request(
        client,
        definition.id,
        inputs={
            "habitat": SOURCE,
            "region": {"kind": "selectedArea", "selectedBounds": AREA},
        },
    )
    job = submit(client, body)
    service.model_registry = ModelRegistry(())
    assert client.portal.call(worker.run_once)
    ready = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert ready["status"] == "ready", ready
    result = ready["result"]
    assert result["name"] == "habitat_result" and result["label"] == "Habitat output"
    downloaded = client.get(result["url"])
    assert downloaded.status_code == 200
    assert hashlib.sha256(downloaded.content).hexdigest() == result["sha256"]
    exported = client.get(f"/api/processing/jobs/{job['jobId']}/run-yaml")
    document = RunDocument.model_validate(parse_yaml(exported.content, run=True))
    assert document.invocation.model.definition == definition
    assert document.invocation.inputs == body["inputs"]
    if model_id == "raster-summary":
        assert result["rows"][0]["expression"] == "mean(a)"
