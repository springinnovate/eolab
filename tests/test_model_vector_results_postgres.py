"""Exercise vector result publication and retention through the real model lifecycle."""

from dataclasses import dataclass, field, replace
import hashlib
import json
from pathlib import Path
from typing import Annotated, Any

import fiona
from fastapi.testclient import TestClient
from pydantic import BaseModel, ConfigDict, Field
import psycopg
import pytest

from eolab_app.execution.bounded_process import ProcessResultWriter
import eolab_app.processing.model_definitions as definitions
import eolab_app.processing.model_operations as operations
from eolab_app.processing.job_store import PostgresJobStore
from eolab_app.processing.model_definitions import ModelDefinition, ModelRegistry
from eolab_app.processing.model_operations import OperationOutput
from eolab_app.processing.model_run_contracts import RunDocument
from eolab_app.processing.model_yaml import parse_yaml
from eolab_app.processing.models import Artifact
from eolab_app.processing.raster_clip import clip_process_target
from eolab_app.routes.processing import COOKIE
from test_model_runs_postgres import model_boundary, model_request, submit
from test_processing_jobs import boundary, store


class ObservationDetails(BaseModel):
    """Retain the fixture operation's measured mean independently of vector file metadata.

    Attributes:
        meanReading: Mean of the two observation values written to the result.
    """

    model_config = ConfigDict(extra="forbid")

    meanReading: Annotated[float, Field(allow_inf_nan=False)]


@dataclass(frozen=True)
class ObservationArtifact(Artifact):
    """Describe the native point fixture for ordinary file publication and outcome delivery.

    Attributes:
        layer_name: Exact native layer inside the produced GeoPackage.
        feature_count: Number of observation points written by the fixture.
        mean_reading: Operation-specific diagnostic retained after file expiry.
        result_name: Private staging filename consumed by the artifact publisher.
        media_type: Published GeoPackage format.
    """

    layer_name: str
    feature_count: int
    mean_reading: float
    result_name: str = "result.gpkg"
    media_type: str = field(default="application/geopackage+sqlite3", kw_only=True)


def observation_files_target(
    writer: ProcessResultWriter, action: str, arguments: tuple[Any, ...]
) -> None:
    """Keep ordinary raster preparation and write a neutral point result at execution.

    Args:
        writer: Native supervisor's result transport.
        action: Existing plan or clip stage selected by the registered operation.
        arguments: Source, prepared specification, attempt directory and limits.
    """
    if action != "clip":
        clip_process_target(writer, action, arguments)
        return
    directory = arguments[2]
    path = directory / "result.gpkg"
    readings = (12.5, 18.5)
    with fiona.open(
        path,
        "w",
        driver="GPKG",
        layer="observations",
        crs="EPSG:4326",
        schema={
            "geometry": "Point",
            "properties": {"station": "str", "reading": "float"},
        },
    ) as destination:
        for index, reading in enumerate(readings):
            destination.write(
                {
                    "geometry": {
                        "type": "Point",
                        "coordinates": (-120 - index, 40 + index),
                    },
                    "properties": {"station": f"site-{index + 1}", "reading": reading},
                }
            )
    (directory / "provenance.json").write_text(
        json.dumps({"fixture": "point-observations"}), encoding="utf-8"
    )
    data = path.read_bytes()
    writer.put(
        (
            "ok",
            ObservationArtifact(
                size=len(data),
                sha256=hashlib.sha256(data).hexdigest(),
                filename="observations.gpkg",
                layer_name="observations",
                feature_count=len(readings),
                mean_reading=sum(readings) / len(readings),
            ),
        )
    )


def describe_observation_result(
    summary: dict[str, Any],
    artifact: dict[str, Any],
    policy: dict[str, Any] | None,
) -> dict[str, Any]:
    """Supply generic vector presentation metadata from the published fixture artifact.

    Args:
        summary: Captured model declaration; no fixture-specific interpretation needed.
        artifact: Published point file facts returned by the native target.
        policy: Retained raster preparation settings, unused by vector presentation.

    Returns:
        Layer identity, feature count and optional initial numeric styling field.
    """
    return {
        "layerName": artifact["layer_name"],
        "featureCount": artifact["feature_count"],
        "defaultNumericField": "reading",
    }


def describe_observation_outcome(artifact: dict[str, Any]) -> dict[str, Any]:
    """Retain file integrity and typed observation diagnostics in ordinary Run YAML.

    Args:
        artifact: Completed vector file and operation-specific diagnostic facts.

    Returns:
        Generic vector outcome and details validated by ObservationDetails.
    """
    return {
        "statistics": None,
        "vector": {
            "filename": artifact["filename"],
            "bytes": artifact["size"],
            "sha256": artifact["sha256"],
            "layerName": artifact["layer_name"],
            "featureCount": artifact["feature_count"],
        },
        "details": {"meanReading": artifact["mean_reading"]},
    }


@pytest.fixture
def vector_result_boundary(model_boundary: Any, monkeypatch: pytest.MonkeyPatch) -> Any:
    """Register a test-only vector output while retaining actual model preparation.

    Args:
        model_boundary: Existing model HTTP, PostgreSQL and native worker composition.
        monkeypatch: Isolated operation registry and native-target replacements.

    Returns:
        Client, worker and a model submission with the fixture's vector output.
    """
    client, worker, service = model_boundary
    document = ModelRegistry.load_installed().get("raster-clip", "1.1.0").to_document()
    original = operations.get_model_operation("raster.clip.v1")
    registered = {
        **operations.OPERATIONS,
        original.id: replace(
            original,
            output=OperationOutput(
                "observations",
                "vector",
                "map",
                "application/geopackage+sqlite3",
                "Point observations",
            ),
            result=describe_observation_result,
            outcome=describe_observation_outcome,
            outcome_details_type=ObservationDetails,
        ),
    }
    monkeypatch.setattr(operations, "OPERATIONS", registered)
    monkeypatch.setattr(definitions, "OPERATIONS", registered)
    monkeypatch.setattr(
        "eolab_app.processing.raster_operations.clip_process_target",
        observation_files_target,
    )
    document["id"] = "vector-fixture"
    document["title"] = "Point observations"
    document["outputs"] = {
        "locations": {
            "source": document["steps"][0]["id"] + ".observations",
            "role": "result",
            "presentation": "map",
            "saveEligible": False,
            "type": "vector",
            "label": "Point observations",
        }
    }
    definition = ModelDefinition.model_validate(document)
    service.model_registry = ModelRegistry((definition,))
    return client, worker, model_request(client, definition.id)


def test_vector_model_output_download_and_retained_typed_details(
    vector_result_boundary: Any, store: PostgresJobStore, tmp_path: Path
) -> None:
    """Publish an owned GeoPackage and preserve typed Run YAML after file cleanup.

    Args:
        vector_result_boundary: Test-only registered operation with real lifecycle owners.
        store: Isolated PostgreSQL authority used to advance the result's expiry.
        tmp_path: Directory for reopening the actual downloaded vector bytes.
    """
    client, worker, body = vector_result_boundary
    job = submit(client, body)
    base = f"/api/processing/jobs/{job['jobId']}"
    assert client.portal.call(worker.run_once)
    ready = client.get(base).json()
    assert ready["status"] == "ready", ready
    result = ready["result"]
    assert result["kind"] == "vector"
    assert result["mediaType"] == "application/geopackage+sqlite3"
    assert result["presentation"] == "map" and result["name"] == "locations"
    assert result["layerName"] == "observations" and result["featureCount"] == 2
    assert result["defaultNumericField"] == "reading"
    download = client.get(result["url"])
    assert download.status_code == 200
    assert len(download.content) == result["bytes"]
    assert hashlib.sha256(download.content).hexdigest() == result["sha256"]
    assert "no-store" in download.headers["cache-control"]
    downloaded = tmp_path / "downloaded.gpkg"
    downloaded.write_bytes(download.content)
    with fiona.open(downloaded, layer="observations") as source:
        assert source.schema["geometry"] == "Point"
        assert [dict(feature.properties) for feature in source] == [
            {"station": "site-1", "reading": 12.5},
            {"station": "site-2", "reading": 18.5},
        ]
    with TestClient(client.app, base_url="https://testserver") as other:
        assert other.get(result["url"]).status_code == 404
        assert other.get(base + "/run-yaml").status_code == 404
    exported = parse_yaml(client.get(base + "/run-yaml").content, run=True)
    retained = RunDocument.model_validate(exported)
    assert isinstance(retained.execution.outcome.details, ObservationDetails)
    assert retained.execution.outcome.details.meanReading == 15.5
    assert retained.execution.outcome.vector.layerName == "observations"
    assert retained.execution.outcome.vector.featureCount == 2
    assert retained.execution.outcome.vector.sha256 == result["sha256"]
    owner = hashlib.sha256(client.cookies.get(COOKIE).encode()).hexdigest()
    row = store.get(job["jobId"], owner)
    published = worker.artifacts.root / "results" / row["attempt_id"] / "result.gpkg"
    assert published.exists()
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET expires_at=now()-interval '1 second' WHERE id=%s",
            (row["job_id"],),
        )
    client.portal.call(worker.cleanup)
    expired = client.get(base).json()
    assert expired["status"] == "expired" and expired["result"] is None
    assert client.get(result["url"]).status_code == 409
    assert not published.exists()
    after_expiry = parse_yaml(client.get(base + "/run-yaml").content, run=True)
    assert after_expiry["execution"]["outcome"] == exported["execution"]["outcome"]
    assert isinstance(
        RunDocument.model_validate(after_expiry).execution.outcome.details,
        ObservationDetails,
    )
