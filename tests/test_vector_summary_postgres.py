"""Run vector summaries through real source, HTTP, PostgreSQL and native worker boundaries."""

from datetime import datetime, timedelta, timezone
import hashlib
from pathlib import Path
from typing import Any

import fiona
from fastapi.testclient import TestClient
import psycopg
import pytest

from eolab_app.processing.job_store import PostgresJobStore
from eolab_app.processing.model_run_contracts import RunDocument
from eolab_app.processing.model_yaml import parse_yaml
from eolab_app.processing.vector_summary_models import VectorSummaryDetails
from eolab_app.routes.processing import COOKIE
from test_model_runs_postgres import model_request, submit
from test_processing_jobs import HEADERS, store
from test_processing_uploaded_vectors import UploadBoundary, upload_boundary
from test_vector_uploads import HEADERS as UPLOAD_HEADERS


@pytest.mark.parametrize("source_kind", ["upload", "catalog"])
def test_summary_uses_original_source_and_ordinary_result_lifetime(
    upload_boundary: UploadBoundary,
    store: PostgresJobStore,
    tmp_path: Path,
    source_kind: str,
) -> None:
    """Publish a grouped GeoPackage and retain its typed diagnostics after file expiry.

    Args:
        upload_boundary: Existing upload, source, HTTP and native worker composition.
        store: Explicit disposable PostgreSQL lifecycle database.
        tmp_path: Directory used to inspect the downloaded result.
        source_kind: Original Catalog dataset or retained private upload.
    """
    client, worker, _, _, selection = upload_boundary
    if source_kind == "catalog":
        item = client.app.state.vector_item
        selection = {
            "collectionId": item["collection"],
            "itemId": item["id"],
            "assetKey": "data",
            "layerName": "areas",
            "filter": selection["filter"],
        }
    request = model_request(
        client,
        "vector-summary",
        inputs={
            "vector": {
                "selection": selection,
                "fields": {"group": "label", "value": "count"},
            }
        },
        parameters={"boundary_tolerance_m": 0},
    )
    run = submit(client, request)
    if source_kind == "upload":
        response = client.delete(
            f"/api/vector-uploads/{selection['uploadId']}", headers=UPLOAD_HEADERS
        )
        assert response.status_code == 204, response.text
    assert client.portal.call(worker.run_once)
    base = f"/api/processing/jobs/{run['jobId']}"
    response = client.get(base)
    assert response.status_code == 200, response.text
    completed = response.json()
    assert completed["status"] == "ready", completed
    result = completed["result"]
    assert result["kind"] == "vector" and result["defaultNumericField"] == "sum_count"
    assert result["featureCount"] == 1 and result["layerName"] == "summary"
    assert datetime.fromisoformat(
        completed["expiresAt"].replace("Z", "+00:00")
    ) > datetime.now(timezone.utc) + timedelta(days=6, hours=23)
    download = client.get(result["url"])
    assert download.status_code == 200
    path = tmp_path / "download.gpkg"
    path.write_bytes(download.content)
    with fiona.open(path, layer="summary") as dataset:
        features = list(dataset)
        assert len(features) == 1
        assert features[0].properties["sum_count"] == 7
        assert features[0].properties["label"] == "Café wetlands"
        assert features[0].geometry.type == "MultiPolygon"
    document = parse_yaml(client.get(base + "/run-yaml").content, run=True)
    assert "grid" not in document["execution"]
    assert document["execution"]["outcome"]["vector"]["featureCount"] == 1
    assert document["execution"]["outcome"]["vector"]["layerName"] == "summary"
    assert document["execution"]["outcome"]["details"] == {
        "summaryField": "sum_count",
        "inputFeatureCount": 1,
        "missingValueCount": 0,
    }
    assert isinstance(
        RunDocument.model_validate(document).execution.outcome.details,
        VectorSummaryDetails,
    )
    assert document["invocation"]["inputs"]["vector"] == request["inputs"]["vector"]
    assert document["execution"]["numericalPolicy"]["boundaryToleranceMeters"] == 0
    with TestClient(client.app, base_url="https://testserver") as stranger:
        assert stranger.get(result["url"]).status_code == 404
    original_files = completed["artifacts"]["files"]
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET expires_at=now()+interval '1 hour', metadata_expires_at=now()+interval '1 hour' WHERE id=%s",
            (run["jobId"],),
        )
    renewed = client.post(base + "/renew", headers=HEADERS)
    assert renewed.status_code == 200, renewed.text
    assert renewed.json()["artifacts"]["files"] == original_files
    owner = hashlib.sha256(client.cookies[COOKIE].encode()).hexdigest()
    row = store.get(run["jobId"], owner)
    published = worker.artifacts.root / "results" / row["attempt_id"] / "result.gpkg"
    assert published.exists()
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET expires_at=now()-interval '1 second' WHERE id=%s",
            (run["jobId"],),
        )
    client.portal.call(worker.cleanup)
    assert not published.exists()
    assert client.get(base).json()["status"] == "expired"
    assert client.get(result["url"]).status_code == 409
    after_expiry = parse_yaml(client.get(base + "/run-yaml").content, run=True)
    assert after_expiry["execution"]["outcome"] == document["execution"]["outcome"]
    assert isinstance(
        RunDocument.model_validate(after_expiry).execution.outcome.details,
        VectorSummaryDetails,
    )
    assert client.delete(base, headers=HEADERS).status_code == 200
    assert client.get(result["url"]).status_code == 409
    client.portal.call(worker.cleanup)


def test_summary_rejects_another_browsers_upload_before_queueing(
    upload_boundary: UploadBoundary, store: PostgresJobStore
) -> None:
    """Do not admit an uploaded summary source belonging to a different browser.

    Args:
        upload_boundary: Existing original upload and Processing composition.
        store: Explicit disposable PostgreSQL database.
    """
    client, worker, _, _, selection = upload_boundary
    with TestClient(client.app, base_url="https://testserver") as stranger:
        request = model_request(
            stranger,
            "vector-summary",
            inputs={
                "vector": {
                    "selection": selection,
                    "fields": {"group": "label", "value": "count"},
                }
            },
            parameters={"boundary_tolerance_m": 0},
        )
        response = stranger.post(
            "/api/processing/model-runs", json=request, headers=HEADERS
        )
        assert response.status_code == 404, response.text
    assert not client.portal.call(worker.run_once)
