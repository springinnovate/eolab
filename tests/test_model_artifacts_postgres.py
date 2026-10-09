"""Multiple real model files across HTTP, PostgreSQL, native execution and cleanup."""

from dataclasses import replace
import hashlib
import json
from pathlib import Path
from typing import Any

import numpy
import psycopg
import pytest
import rasterio
from fastapi.testclient import TestClient

from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing.artifact_manifest import ProducedFile
from eolab_app.processing.artifact_manifest import read_artifact_manifest
from eolab_app.processing.models import Artifact, PreparedJobPlan, ProcessingError
from eolab_app.processing.model_definitions import ModelRegistry
from eolab_app.processing.model_yaml import parse_yaml
from eolab_app.processing.raster_clip import create_clip, clip_process_target
from eolab_app.routes.processing import COOKIE
from model_recipe_support import multiple_output_recipe
from test_model_runs_postgres import model_boundary, model_request, submit
from test_processing_jobs import boundary, store, HEADERS, AREA
from test_raster_clips import SOURCE
from uuid import uuid4


def multiple_files_target(
    queue: ProcessResultWriter, action: str, arguments: tuple[Any, ...]
) -> None:
    """Run a real clip and write a coverage GeoTIFF plus a totals CSV.

    Args:
        queue: Native result transport.
        action: Trusted clip operation stage.
        arguments: Source, prepared clip specification, workspace and limits.
    """
    if action != "clip":
        clip_process_target(queue, action, arguments)
        return
    artifact = create_clip(*arguments)
    directory = arguments[2]
    with rasterio.open(directory / "result.tif") as source:
        mask = source.read_masks(1) > 0
        profile = {**source.profile, "dtype": "uint8", "nodata": 0}
        with rasterio.open(directory / "coverage.tif", "w", **profile) as destination:
            destination.write(mask.astype("uint8"), 1)
        total = numpy.sum(source.read(1)[mask])
    (directory / "totals.csv").write_text(f"sum\n{total}\n", encoding="utf-8")
    (directory / "scratch.bin").write_bytes(b"working-only")
    outputs = []
    for name, filename, media_type in (
        ("coverage", "coverage.tif", "image/tiff"),
        ("totals", "totals.csv", "text/csv"),
    ):
        data = (directory / filename).read_bytes()
        outputs.append(
            ProducedFile(
                name=name,
                storage_name=filename,
                filename=filename,
                media_type=media_type,
                size=len(data),
                sha256=hashlib.sha256(data).hexdigest(),
            )
        )
    queue.put(("ok", replace(artifact, additional_outputs=tuple(outputs))))


@pytest.fixture
def multiple_boundary(model_boundary: Any, monkeypatch: pytest.MonkeyPatch) -> Any:
    """Install a test-only multi-output recipe using the actual operation boundary.

    Args:
        model_boundary: Real HTTP, PostgreSQL and worker composition.
        monkeypatch: Scoped native target and registered operation replacement.

    Returns:
        Client, worker, service and submitted model request.
    """
    client, worker, service = model_boundary
    definition = multiple_output_recipe(monkeypatch)
    service.model_registry = ModelRegistry((definition,))
    monkeypatch.setattr(
        "eolab_app.processing.raster_operations.clip_process_target",
        multiple_files_target,
    )
    body = model_request(
        client,
        definition.id,
        inputs={
            "habitat": SOURCE,
            "region": {"kind": "selectedArea", "selectedBounds": AREA},
        },
    )
    return client, worker, service, body


def test_multiple_files_owned_downloads_and_exact_accounting(
    multiple_boundary: Any, store: Any
) -> None:
    """Publish real rasters and a table with immutable identities and private leases.

    Args:
        multiple_boundary: Real multi-output recipe composition.
        store: PostgreSQL lifecycle and accounting authority.
    """
    client, worker, _, body = multiple_boundary
    job = submit(client, body)
    base = f"/api/processing/jobs/{job['jobId']}"
    pending = client.get(base + "/artifacts").json()
    assert pending["availability"] == "pending" and pending["files"] == []
    assert client.portal.call(worker.run_once)
    ready = client.get(base).json()
    assert ready["status"] == "ready", ready
    manifest = client.get(base + "/artifacts").json()
    assert manifest == ready["artifacts"]
    assert manifest["availability"] == "available"
    assert {file["name"] for file in manifest["files"]} == {
        "habitat_result",
        "inspected_coverage",
        "habitat_totals",
        "provenance",
    }
    assert submit(client, body)["artifacts"] == manifest
    assert "storage_name" not in json.dumps(manifest) and str(
        worker.artifacts.root
    ) not in json.dumps(manifest)
    for file in manifest["files"]:
        download = client.get(file["url"])
        assert download.status_code == 200
        assert len(download.content) == file["bytes"]
        assert hashlib.sha256(download.content).hexdigest() == file["sha256"]
        assert "no-store" in download.headers["cache-control"]
        partial = client.get(file["url"], headers={"Range": "bytes=0-3"})
        assert partial.status_code == 206 and partial.content == download.content[:4]
        assert client.head(file["url"]).headers["content-length"] == str(file["bytes"])
        if file["mediaType"] == "image/tiff":
            with (
                rasterio.MemoryFile(download.content) as memory,
                memory.open() as raster,
            ):
                assert raster.width > 0 and raster.height > 0
        with TestClient(client.app, base_url="https://testserver") as other:
            assert other.get(file["url"]).status_code == 404
            assert other.get(base + "/artifacts").status_code == 404
            assert other.delete(base, headers=HEADERS).status_code == 404
    owner = hashlib.sha256(client.cookies.get(COOKIE).encode()).hexdigest()
    row = store.get(job["jobId"], owner)
    directory = worker.artifacts.root / "results" / row["attempt_id"]
    assert {file.name for file in directory.iterdir()} == {
        "result.tif",
        "coverage.tif",
        "totals.csv",
        "provenance.json",
        "manifest.json",
    }
    disk_bytes = sum(file.stat().st_size for file in directory.iterdir())
    assert row["reserved_bytes"] == disk_bytes == manifest["totalBytes"]
    assert client.get(ready["result"]["url"]).status_code == 200
    assert client.get(ready["result"]["provenanceUrl"]).status_code == 200
    exported = parse_yaml(client.get(base + "/run-yaml").content, run=True)
    assert len(exported["execution"]["outcome"]["artifacts"]) == 4
    assert "storage_name" not in json.dumps(exported)
    unknown = client.get(base + "/artifacts/" + "0" * 32)
    assert unknown.status_code == 404
    with psycopg.connect(store.conninfo) as connection:
        assert (
            connection.execute("SELECT count(*) FROM processing.transfers").fetchone()[
                0
            ]
            == 0
        )


@pytest.mark.parametrize("terminal", ["delete", "expire"])
def test_transfer_retains_all_files_until_cleanup(
    multiple_boundary: Any, store: Any, terminal: str
) -> None:
    """Deletion/expiry blocks new downloads while an existing lease protects every file.

    Args:
        multiple_boundary: Completed native multi-output run fixture.
        store: Real ownership, transfer and cleanup records.
        terminal: Explicit deletion or retention expiry.
    """
    client, worker, service, body = multiple_boundary
    job = submit(client, body)
    assert client.portal.call(worker.run_once)
    base = f"/api/processing/jobs/{job['jobId']}"
    files = client.get(base + "/artifacts").json()["files"]
    owner = hashlib.sha256(client.cookies.get(COOKIE).encode()).hexdigest()
    active = client.portal.call(
        service.download_model_artifact, owner, job["jobId"], files[1]["artifactId"]
    )
    row = store.get(job["jobId"], owner)
    directory = active.path.parent
    if terminal == "delete":
        assert client.delete(base, headers=HEADERS).status_code == 200
    else:
        with psycopg.connect(store.conninfo) as connection:
            connection.execute(
                "UPDATE processing.jobs SET expires_at=now()-interval '1 second' WHERE id=%s",
                (row["job_id"],),
            )
    for file in files:
        assert client.get(file["url"]).status_code == 409
    assert client.get(base + "/artifacts").json()["files"] == []
    client.portal.call(worker.cleanup)
    assert len(list(directory.iterdir())) == 5 and active.path.exists()
    assert client.portal.call(service.transfer_heartbeat, active.lease_id, True)
    client.portal.call(worker.cleanup)
    assert not directory.exists()


def test_missing_declared_intermediate_never_publishes(
    multiple_boundary: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A native primary result alone cannot satisfy a multi-output recipe.

    Args:
        multiple_boundary: Recipe requesting primary, coverage and totals files.
        monkeypatch: Restore the ordinary clip target which lacks the extra outputs.
    """
    client, worker, _, body = multiple_boundary
    monkeypatch.setattr(
        "eolab_app.processing.raster_operations.clip_process_target",
        clip_process_target,
    )
    job = submit(client, body)
    assert client.portal.call(worker.run_once)
    status = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert (
        status["status"] == "failed"
        and status["error"]["code"] == "invalid_model_result"
    )
    assert status["artifacts"]["files"] == [] and status["result"] is None
    client.portal.call(worker.cleanup)
    assert not list((worker.artifacts.root / "results").iterdir())
    assert not list((worker.artifacts.root / "attempts").iterdir())


def test_file_ids_cannot_cross_runs_and_finish_preserves_reservation(
    multiple_boundary: Any, store: Any
) -> None:
    """Scope IDs to their run and reject oversized or late manifest publication.

    Args:
        multiple_boundary: Actual model execution producing several retained files.
        store: Durable reservation and attempt-fencing authority.
    """
    client, worker, _, body = multiple_boundary
    first = submit(client, body)
    assert client.portal.call(worker.run_once)
    first_base = f"/api/processing/jobs/{first['jobId']}"
    manifest = client.get(first_base + "/artifacts").json()
    second = submit(client, {**body, "requestId": uuid4().hex})
    assert client.portal.call(worker.run_once)
    other_base = f"/api/processing/jobs/{second['jobId']}"
    for file in manifest["files"]:
        assert (
            client.get(other_base + "/artifacts/" + file["artifactId"]).status_code
            == 404
        )
    owner = hashlib.sha256(client.cookies.get(COOKIE).encode()).hexdigest()
    row = store.get(first["jobId"], owner)
    stored = row["artifact"]
    artifact = Artifact(
        stored["size"],
        stored["sha256"],
        stored["filename"],
        media_type=stored["media_type"],
        manifest=read_artifact_manifest(stored["manifest"]),
    )
    identifier = store.submit(
        "fixture-owner",
        uuid4().hex,
        PreparedJobPlan(
            {}, {}, artifact.manifest.total_bytes - 1, operation="fixture.files.v1"
        ),
        uuid4().hex,
    )["id"]
    claimed = store.claim_next_job()
    assert claimed["id"] == identifier
    with pytest.raises(ProcessingError) as error:
        store.finish(identifier, claimed["attempt_id"], artifact)
    assert error.value.code == "output_too_large"
    unchanged = store.get(identifier, "fixture-owner")
    assert unchanged["status"] == "running" and unchanged["artifact"] is None
    assert unchanged["reserved_bytes"] == artifact.manifest.total_bytes - 1
    assert not store.finish(identifier, "0" * 32, artifact)
    assert store.finish(
        identifier,
        claimed["attempt_id"],
        None,
        {"code": "fixture_failure", "detail": "Stopped"},
    )
    assert not store.finish(identifier, claimed["attempt_id"], artifact)
    assert store.get(identifier, "fixture-owner")["artifact"] is None
