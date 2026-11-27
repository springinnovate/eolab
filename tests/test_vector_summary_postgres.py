"""Run vector summaries through real source, HTTP, PostgreSQL and native worker boundaries."""

from datetime import datetime, timedelta, timezone
import hashlib
from pathlib import Path
from typing import Any

import fiona
from fastapi.testclient import TestClient
import numpy
import rasterio
from rasterio.features import geometry_mask
import psycopg
import pytest

from eolab_app.processing.job_store import PostgresJobStore
from eolab_app.processing.model_run_contracts import RunDocument
from eolab_app.processing.model_yaml import parse_yaml
from eolab_app.processing.vector_summary_models import VectorSummaryDetails
from eolab_app.routes.processing import COOKIE
from test_model_runs_postgres import (
    capture_drawing,
    model_boundary,
    model_request,
    submit,
)
from catalog_selection_support import register_selection
from eolab_app.vector.sampling import VectorSamplingService
from eolab_app.vector_uploads import VectorUploadStore
from eolab_app.routes.vector_uploads import create_vector_uploads_router
from test_polygon_summary_areas import rectangle
from raster_source_support import SOURCE
from test_processing_jobs import HEADERS, boundary, store
from test_processing_uploaded_vectors import UploadBoundary, upload_boundary
from test_vector_uploads import HEADERS as UPLOAD_HEADERS, write_layer


@pytest.mark.parametrize(
    "source_kind,statistic,expected",
    [
        ("upload", None, 21),
        ("catalog", "sum", 7),
        ("upload", "mean", 10.5),
        ("upload", "max", 14),
        ("upload", "min", 7),
        ("upload", "stdev", 3.5),
    ],
    ids=["default-sum", "catalog-sum", "mean", "max", "min", "stdev"],
)
def test_summary_uses_original_source_and_ordinary_result_lifetime(
    upload_boundary: UploadBoundary,
    store: PostgresJobStore,
    tmp_path: Path,
    source_kind: str,
    statistic: str | None,
    expected: int | float,
) -> None:
    """Publish two field/statistic pairs and retain their diagnostics after file expiry.

    Args:
        upload_boundary: Existing upload, source, HTTP and native worker composition.
        store: Explicit disposable PostgreSQL lifecycle database.
        tmp_path: Directory used to inspect the downloaded result.
        source_kind: Original Catalog dataset or retained private upload.
        statistic: First reduction, or None to use the form's default sum choice.
        expected: Independently calculated result for the selected source features.
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
    else:
        source = tmp_path / "statistic-input.gpkg"
        write_layer(source, geometry="MultiPolygon")
        with fiona.open(source, "a", layer="areas") as dataset:
            dataset.write(
                {
                    "geometry": {
                        "type": "MultiPolygon",
                        "coordinates": [
                            [
                                [
                                    (6000, 0),
                                    (7000, 0),
                                    (7000, 1000),
                                    (6000, 1000),
                                    (6000, 0),
                                ]
                            ]
                        ],
                    },
                    "properties": {
                        "label": "Café wetlands",
                        "count": 14,
                        "weight": 5.5,
                    },
                }
            )
        response = client.post(
            "/api/vector-uploads",
            params={"name": "Grouped statistic inputs"},
            headers=UPLOAD_HEADERS,
            content=source.read_bytes(),
        )
        assert response.status_code == 201, response.text
        selection = {
            "uploadId": response.json()["id"],
            "layerName": "areas",
            "filter": {"enabled": False, "match": "all", "rules": []},
        }
    parameters: dict[str, Any] = {"boundary_tolerance_m": 0}
    effective_statistic = statistic or "sum"
    summary_field = f"{effective_statistic}_count"
    request = model_request(
        client,
        "vector-summary",
        inputs={
            "vector": {
                "selection": selection,
                "fields": {"group": "label"},
                "rows": [
                    {
                        "fields": {"value": "count"},
                        "parameters": {"statistic": effective_statistic},
                    },
                    {
                        "fields": {"value": "weight"},
                        "parameters": {"statistic": "mean"},
                    },
                ],
            }
        },
        parameters=parameters,
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
    assert result["kind"] == "vector"
    assert result["defaultNumericField"] == summary_field
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
        assert features[0].properties[summary_field] == pytest.approx(expected)
        assert features[0].properties["mean_weight"] == (
            2.5 if source_kind == "catalog" else 4
        )
        assert features[0].properties["label"] == "Café wetlands"
        assert features[0].geometry.type == "MultiPolygon"
    document = parse_yaml(client.get(base + "/run-yaml").content, run=True)
    assert "grid" not in document["execution"]
    assert document["execution"]["outcome"]["vector"]["featureCount"] == 1
    assert document["execution"]["outcome"]["vector"]["layerName"] == "summary"
    assert document["execution"]["outcome"]["details"] == {
        "summaryField": summary_field,
        "inputFeatureCount": 1 if source_kind == "catalog" else 2,
        "missingValueCount": 0,
    }
    assert isinstance(
        RunDocument.model_validate(document).execution.outcome.details,
        VectorSummaryDetails,
    )
    assert document["invocation"]["inputs"]["vector"] == request["inputs"]["vector"]
    assert document["invocation"]["parameters"] == {
        "boundary_tolerance_m": 0,
    }
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
    assert after_expiry["invocation"] == document["invocation"]
    assert after_expiry["execution"]["outcome"] == document["execution"]["outcome"]
    assert isinstance(
        RunDocument.model_validate(after_expiry).execution.outcome.details,
        VectorSummaryDetails,
    )
    assert client.delete(base, headers=HEADERS).status_code == 200
    assert client.get(result["url"]).status_code == 409
    client.portal.call(worker.cleanup)


def test_clip_pixels_match_for_all_four_vector_sources(
    model_boundary: Any, boundary: Any, tmp_path: Path
) -> None:
    """Clip the same raster with identical WGS84 features from four independent origins.

    Args:
        model_boundary: Processing API and native worker with private result storage.
        boundary: Original raster and catalog admission fixture.
        tmp_path: Isolated vector dataset and private upload directory.
    """
    client, worker, service = model_boundary
    uploads = VectorUploadStore(tmp_path / "uploads", None)
    service.uploads = worker.uploads = uploads
    service.areas = worker.areas = VectorSamplingService(
        worker.areas.catalog, worker.areas.resolver, uploads=uploads
    )
    client.app.include_router(create_vector_uploads_router(uploads))
    geometry = {
        "type": "Polygon",
        "coordinates": [
            [[0.121, 9.173], [0.433, 9.173], [0.121, 9.427], [0.121, 9.173]]
        ],
    }
    drawing = capture_drawing(client, geometry)
    original = tmp_path / "sites.gpkg"
    with fiona.open(
        original,
        "w",
        driver="GPKG",
        layer="sites",
        crs="EPSG:4326",
        schema={"geometry": "Polygon", "properties": {"note": "str", "count": "int"}},
    ) as dataset:
        for shape, note in ((geometry, "include"), (rectangle(0, 0, 1, 1), "omit")):
            dataset.write({"geometry": shape, "properties": {"note": note, "count": 1}})
    predicate = drawing["filter"]
    catalog = {**register_selection(boundary[0], original), "filter": predicate}
    response = client.post(
        "/api/vector-uploads",
        params={"name": "Study sites"},
        headers=UPLOAD_HEADERS,
        content=original.read_bytes(),
    )
    assert response.status_code == 201, response.text
    upload = {
        "uploadId": response.json()["id"],
        "layerName": "sites",
        "filter": predicate,
    }
    # This one-feature group preserves the original polygon in a real model output.
    parent = submit(
        client,
        model_request(
            client,
            "vector-summary",
            inputs={
                "vector": {
                    "selection": catalog,
                    "fields": {"group": "note"},
                    "rows": [
                        {
                            "fields": {"value": "count"},
                            "parameters": {"statistic": "sum"},
                        }
                    ],
                }
            },
            parameters={"boundary_tolerance_m": 0},
        ),
    )
    assert client.portal.call(worker.run_once)
    parent_url = f"/api/processing/jobs/{parent['jobId']}"
    ready = client.get(parent_url).json()
    assert ready["status"] == "ready", ready
    file = next(
        file for file in ready["artifacts"]["files"] if file["name"] == "summary"
    )
    artifact = {
        "kind": "runArtifact",
        "jobId": parent["jobId"],
        "artifactId": file["artifactId"],
        "layerName": ready["result"]["layerName"],
        "filter": predicate,
    }
    runs = []
    for source in (catalog, upload, artifact, drawing):
        body = model_request(
            client,
            "raster-clip",
            inputs={
                "raster": SOURCE,
                "area": {"kind": "catalogSelection", "selection": source},
            },
        )
        runs.append(submit(client, body))
    with TestClient(client.app, base_url="https://testserver") as stranger:
        assert (
            stranger.post(
                "/api/processing/model-runs", headers=HEADERS, json=body
            ).status_code
            == 409
        )
    assert (
        client.delete(
            "/api/processing/vector-inputs/" + drawing["reference"]["id"],
            headers=HEADERS,
        ).status_code
        == 200
    )
    assert (
        client.delete(
            f"/api/vector-uploads/{upload['uploadId']}", headers=UPLOAD_HEADERS
        ).status_code
        == 204
    )
    assert client.delete(parent_url, headers=HEADERS).status_code == 200
    client.portal.call(worker.cleanup)
    outputs = []
    for run in runs:
        assert client.portal.call(worker.run_once)
        ready = client.get(f"/api/processing/jobs/{run['jobId']}").json()
        assert ready["status"] == "ready", ready
        with (
            rasterio.MemoryFile(client.get(ready["result"]["url"]).content) as memory,
            memory.open() as raster,
        ):
            expected_mask = geometry_mask(
                [geometry],
                out_shape=raster.shape,
                transform=raster.transform,
                all_touched=True,
                invert=True,
            )
            numpy.testing.assert_array_equal(raster.read_masks(1) > 0, expected_mask)
            assert expected_mask.any() and not expected_mask.all()
            outputs.append(
                (raster.transform, raster.crs, raster.read(1), raster.read_masks(1))
            )
    for transform, crs, pixels, mask in outputs[1:]:
        assert (transform, crs) == outputs[0][:2]
        numpy.testing.assert_array_equal(pixels, outputs[0][2])
        numpy.testing.assert_array_equal(mask, outputs[0][3])


def test_calculated_result_fields_survive_parent_deletion_in_processing(
    upload_boundary: UploadBoundary, store: PostgresJobStore, tmp_path: Path
) -> None:
    """Read calculated upload and result fields through durable input retention.

    Args:
        upload_boundary: Existing HTTP, original-source, database and native composition.
        store: Explicit disposable PostgreSQL lifecycle database.
        tmp_path: Directory for inspecting the final published result.
    """
    client, worker, _, _, upload = upload_boundary
    upload = {
        **upload,
        "calculatedFields": [
            {
                "version": 1,
                "name": "doubled",
                "expression": "'count' * 2",
                "numericText": False,
            }
        ],
    }

    def summary_request(selection: dict[str, Any], value: str) -> dict[str, Any]:
        """Capture one calculated field in an ordinary vector-summary invocation.

        Args:
            selection: Path-free upload or result selection with its definitions.
            value: Calculated numeric field to reduce.

        Returns:
            Public model request using the existing label grouping field.
        """
        return model_request(
            client,
            "vector-summary",
            inputs={
                "vector": {
                    "selection": selection,
                    "fields": {"group": "label"},
                    "rows": [
                        {"fields": {"value": value}, "parameters": {"statistic": "sum"}}
                    ],
                }
            },
            parameters={"boundary_tolerance_m": 0},
        )

    parent = submit(client, summary_request(upload, "doubled"))
    assert client.portal.call(worker.run_once)
    parent_url = f"/api/processing/jobs/{parent['jobId']}"
    parent = client.get(parent_url).json()
    assert parent["status"] == "ready", parent
    artifact = next(
        file
        for file in parent["artifacts"]["files"]
        if file["mediaType"] == "application/geopackage+sqlite3"
    )
    selection = {
        "kind": "runArtifact",
        "jobId": parent["jobId"],
        "artifactId": artifact["artifactId"],
        "layerName": "summary",
        "filter": {
            "enabled": True,
            "match": "all",
            "rules": [{"field": "scaled", "operator": "eq", "value": 7}],
        },
        "calculatedFields": [
            {
                "version": 1,
                "name": "scaled",
                "expression": "'sum_doubled' / 2",
                "numericText": False,
            }
        ],
    }
    request = summary_request(selection, "scaled")
    request["requestId"] = "retained-calculated-vector"
    with TestClient(client.app, base_url="https://testserver") as stranger:
        denied = stranger.post(
            "/api/processing/model-runs", json=request, headers=HEADERS
        )
        assert denied.status_code == 404, denied.text
    child = submit(client, request)
    owner = hashlib.sha256(client.cookies[COOKIE].encode()).hexdigest()
    parent_row = store.get(parent["jobId"], owner)
    original = (
        worker.artifacts.root / "results" / parent_row["attempt_id"] / "result.gpkg"
    )
    assert client.delete(parent_url, headers=HEADERS).status_code == 200
    client.portal.call(worker.cleanup)
    assert original.is_file()
    assert client.portal.call(worker.run_once)
    completed = client.get(f"/api/processing/jobs/{child['jobId']}").json()
    assert completed["status"] == "ready", completed
    output = tmp_path / "calculated-summary.gpkg"
    output.write_bytes(client.get(completed["result"]["url"]).content)
    with fiona.open(output, layer="summary") as dataset:
        (feature,) = dataset
        assert feature.properties["sum_scaled"] == 7
    document = parse_yaml(
        client.get(f"/api/processing/jobs/{child['jobId']}/run-yaml").content, run=True
    )
    assert document["invocation"]["inputs"]["vector"]["selection"] == selection
    client.portal.call(worker.cleanup)
    assert not original.exists()


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
                    "fields": {"group": "label"},
                    "rows": [
                        {
                            "fields": {"value": "count"},
                            "parameters": {"statistic": "sum"},
                        }
                    ],
                }
            },
            parameters={"boundary_tolerance_m": 0},
        )
        response = stranger.post(
            "/api/processing/model-runs", json=request, headers=HEADERS
        )
        assert response.status_code == 404, response.text
    assert not client.portal.call(worker.run_once)


def test_summary_rejects_unknown_statistic_before_queueing(
    upload_boundary: UploadBoundary, store: PostgresJobStore
) -> None:
    """Reject an undeclared statistic before retaining inputs or admitting native work.

    Args:
        upload_boundary: Existing original upload and Processing composition.
        store: Explicit disposable PostgreSQL database.
    """
    client, worker, _, _, selection = upload_boundary
    request = model_request(
        client,
        "vector-summary",
        inputs={
            "vector": {
                "selection": selection,
                "fields": {"group": "label"},
                "rows": [
                    {
                        "fields": {"value": "count"},
                        "parameters": {"statistic": "median"},
                    }
                ],
            }
        },
        parameters={"boundary_tolerance_m": 0},
    )
    response = client.post("/api/processing/model-runs", json=request, headers=HEADERS)
    assert response.status_code == 422, response.text
    assert not client.portal.call(worker.run_once)
