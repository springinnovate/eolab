"""Retain uploaded GeoTIFF inputs across real Processing admission and native execution."""

import asyncio
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from eolab_app.processing.artifacts import LocalJobArtifacts
from eolab_app.processing.job_store import PostgresJobStore
from eolab_app.processing.native_processes import create_native_process
from eolab_app.processing.service import ProcessingService
from eolab_app.processing.worker import ProcessingWorker
from eolab_app.routes.browser_identity import COOKIE
from eolab_app.routes.processing import create_processing_router
from eolab_app.upload_storage import UploadStorage
from test_model_runs_postgres import model_request
from test_processing_jobs import HEADERS, store
from test_raster_source_access import CATALOG, CatalogAuthority, write_source
from test_uploaded_raster_sources import OWNER, TOKEN, store_raster


@pytest.fixture
def raster_upload_boundary(
    tmp_path: Path, store: PostgresJobStore
) -> Iterator[
    tuple[
        TestClient, ProcessingWorker, ProcessingService, UploadStorage, dict[str, str]
    ]
]:
    """Compose upload retention, HTTP, PostgreSQL and native workers without rendering.

    Args:
        tmp_path: Isolated source, upload and result storage.
        store: Explicit disposable PostgreSQL job store.

    Yields:
        Browser, worker, service, shared storage and opaque raster reference.
    """
    path = write_source(tmp_path / "original.tif")
    uploads = UploadStorage(tmp_path / "uploads")
    uploads.initialize()
    record = asyncio.run(store_raster(uploads, path))
    reference = {"kind": "uploadedRaster", "uploadId": str(record.id)}
    artifacts = LocalJobArtifacts(tmp_path / "results")
    artifacts.initialize()
    native = create_native_process(store.limits)
    authorizer = CatalogAuthority(path)
    worker = ProcessingWorker(
        authorizer,
        store,
        artifacts,
        store.limits,
        native=native,
        upload_storage=uploads,
    )
    service = ProcessingService(
        store, artifacts, model_authorizer=authorizer, upload_storage=uploads
    )
    app = FastAPI()
    app.include_router(create_processing_router(service))
    with TestClient(app, base_url="https://testserver") as client:
        client.cookies.set(COOKIE, TOKEN)
        try:
            yield client, worker, service, uploads, reference
        finally:
            client.portal.call(native.close)


@pytest.mark.parametrize(
    "operation", ["clip", "summary", "model-clip", "model-summary"]
)
def test_uploaded_raster_calculations_survive_deletion_and_restart(
    raster_upload_boundary: Any, store: PostgresJobStore, operation: str
) -> None:
    """Use retained originals through ordinary clip, summary and model execution.

    Args:
        raster_upload_boundary: Real source, API, storage and native composition.
        store: Disposable database containing accepted input-retention tokens.
        operation: Public operation path exercised by this case.
    """
    client, worker, service, uploads, reference = raster_upload_boundary
    bounds = {"west": -2, "south": -2, "east": 2, "north": 2}
    if operation.startswith("model-"):
        endpoint = "/api/processing/model-runs"
        body = model_request(
            client,
            "raster-" + operation.removeprefix("model-"),
            inputs={
                "raster": reference,
                "area": {"kind": "selectedArea", "selectedBounds": bounds},
            },
            parameters=({"summary": "mean(a)"} if operation == "model-summary" else {}),
        )
    elif operation == "clip":
        endpoint = "/api/processing/raster-clips"
        body = {"source": reference, "selectedBounds": bounds, "requestId": uuid4().hex}
    else:
        endpoint = "/api/processing/raster-calculations"
        body = {
            "sources": {"a": reference},
            "wholeRaster": True,
            "calculations": [{"label": "Mean", "expression": "mean(a)"}],
            "requestId": uuid4().hex,
        }
    response = client.post(endpoint, json=body, headers=HEADERS)
    assert response.status_code == 202, response.text
    identifier = response.json()["jobId"]
    assert len(store.active_input_uploads()) == 1
    record = uploads.summary(OWNER).uploads[0]
    uploads.delete(OWNER, record.id)
    uploads.initialize()
    client.portal.call(service.reconcile_upload_inputs)
    assert uploads.summary(OWNER).retained_files == 1
    retry = client.post(endpoint, json=body, headers=HEADERS)
    assert retry.status_code == 202 and retry.json()["jobId"] == identifier
    assert client.portal.call(worker.run_once)
    ready = client.get(f"/api/processing/jobs/{identifier}").json()
    assert ready["status"] == "ready", ready
    if operation == "summary":
        assert ready["result"]["rows"][0]["value"] == "7.5"
    if operation.startswith("model-"):
        document = client.get(f"/api/processing/jobs/{identifier}/run-yaml")
        assert document.status_code == 200, document.text
        assert "uploadedRaster" in document.text and "sourceSignature:" in document.text
        assert (
            "source.tif" not in document.text and str(uploads.root) not in document.text
        )
    client.portal.call(service.reconcile_upload_inputs)
    assert uploads.summary(OWNER).used_files == 0


def test_uploaded_raster_batch_authorizes_each_browser(
    raster_upload_boundary: Any, store: PostgresJobStore
) -> None:
    """Batch calculations retain one source per job and reject a foreign browser.

    Args:
        raster_upload_boundary: Real upload and Processing composition.
        store: Disposable database used to inspect active retention.
    """
    client, worker, service, uploads, reference = raster_upload_boundary
    from eolab_app.processing.aggregate_models import AggregateJobRequest
    from eolab_app.processing.models import ProcessingError

    requests = [
        AggregateJobRequest(
            sources={"a": reference},
            wholeRaster=True,
            calculations=[{"label": name, "expression": f"{name}(a)"}],
            requestId=uuid4().hex,
        )
        for name in ("min", "max")
    ]

    async def exercise() -> None:
        """Submit through the service's existing batch ownership boundary."""
        denied = await service.submit_calculation_batch("run-owner", requests, "b" * 64)
        assert all(isinstance(result, ProcessingError) for result in denied)
        accepted = await service.submit_calculation_batch("run-owner", requests, OWNER)
        assert len(accepted) == 2 and all(
            isinstance(result, dict) for result in accepted
        )
        assert len(store.active_input_uploads()) == 2
        for _ in requests:
            assert await worker.run_once()
        await service.reconcile_upload_inputs()
        assert not store.active_input_uploads()

    client.portal.call(exercise)


def test_habitat_reference_upload_is_retained_with_its_opaque_identity(
    raster_upload_boundary: Any, store: PostgresJobStore
) -> None:
    """Capture Habitat's additional reference raster without coupling to rendering.

    Args:
        raster_upload_boundary: Real source, API and upload retention composition.
        store: Disposable database holding the accepted model inputs.
    """
    client, _, service, uploads, reference = raster_upload_boundary
    body = model_request(
        client,
        "habitat-condition",
        inputs={
            "stack": {
                "predictors": [{"name": "land_cover", "source": CATALOG}],
                "responses": [{"name": "cover", "source": CATALOG}],
                "categoricalPredictor": "land_cover",
            },
            "area": {
                "kind": "selectedArea",
                "selectedBounds": {"west": -2, "south": -2, "east": 2, "north": 2},
            },
            "references": {"kind": "raster", "source": reference},
            "habitat_mask": None,
            "preparation": {
                "resampling": {
                    "predictor_0": "nearest",
                    "response_0": "nearest",
                    "reference_mask": "nearest",
                },
            },
        },
    )
    response = client.post("/api/processing/model-runs", json=body, headers=HEADERS)
    assert response.status_code == 202, response.text
    assert len(store.active_input_uploads()) == 1
    identifier = response.json()["jobId"]
    document = client.get(f"/api/processing/jobs/{identifier}/run-yaml")
    assert document.status_code == 200, document.text
    assert reference["uploadId"] in document.text and "reference_mask:" in document.text
    assert (
        client.post(
            f"/api/processing/jobs/{identifier}/cancel", headers=HEADERS
        ).status_code
        == 202
    )
    client.portal.call(service.reconcile_upload_inputs)
    assert not store.active_input_uploads()
