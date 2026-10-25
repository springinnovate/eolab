"""Keep admitted upload files until the computations using them have stopped."""

from dataclasses import replace
import hashlib
import os
from pathlib import Path
from uuid import UUID, uuid4

import fiona
import pytest

from eolab_app.processing.job_store import PostgresJobStore
from eolab_app.processing.models import Artifact, PreparedJobPlan
from eolab_app.routes.browser_identity import COOKIE
from eolab_app.vector_uploads import VectorUploadError, VectorUploadStore
from test_processing_jobs import store
from test_vector_uploads import BASE, HEADERS, client_for, write_layer


def test_retained_original_survives_upload_deletion_and_restart(tmp_path: Path) -> None:
    """Retain original geometry without copying bytes, then remove unused links.

    Args:
        tmp_path: Disposable upload storage and GeoPackage fixture.
    """
    uploads = VectorUploadStore(tmp_path / "uploads", None)
    body = write_layer(tmp_path / "original.gpkg", "MultiPolygon")
    with client_for(uploads) as client:
        response = client.post(
            BASE, params={"name": "Wetlands"}, headers=HEADERS, content=body
        )
        assert response.status_code == 201, response.text
        identifier = UUID(response.json()["id"])
        owner = hashlib.sha256(client.cookies[COOKIE].encode()).hexdigest()
        _, original = uploads.get_upload_source(owner, identifier)
        token = uploads.retain_source(original)
        retained = uploads.get_retained_source(token)
        assert retained.samefile(original)
        if os.name != "nt":
            assert retained.stat().st_mode & 0o444 == 0o444
            assert retained.parent.stat().st_mode & 0o111 == 0o111
            assert uploads.root.stat().st_mode & 0o111 == 0o111
        assert client.delete(f"{BASE}/{identifier}", headers=HEADERS).status_code == 204
        assert client.get(BASE).json() == []
        assert not original.exists()
        assert retained.read_bytes() == body
        with fiona.open(retained) as dataset:
            feature = next(iter(dataset))
            assert len(feature.geometry.coordinates) == 2
            assert len(feature.geometry.coordinates[0]) == 2

    restarted = VectorUploadStore(uploads.root, None)
    restarted.initialize()
    restarted.remove_unretained_sources({token})
    assert restarted.get_retained_source(token) == retained
    outside = uploads.root / "outside.gpkg"
    outside.write_bytes(b"outside retained storage")
    with pytest.raises(VectorUploadError, match="unavailable"):
        restarted.get_retained_source("../outside")
    restarted.remove_unretained_sources(set())
    assert not retained.exists()
    assert outside.exists()
    with pytest.raises(VectorUploadError, match="unavailable"):
        restarted.get_retained_source(token)


@pytest.mark.parametrize("outcome", ["ready", "failed", "cancelled", "restart"])
def test_job_retains_upload_until_execution_stops(
    store: PostgresJobStore, outcome: str
) -> None:
    """Keep tokens through preparation and cancellation, but outside public rows.

    Args:
        store: Real disposable PostgreSQL adapter.
        outcome: Terminal lifecycle transition that releases the input.
    """
    retained = {str(uuid4()): uuid4().hex for _ in range(2)}
    tokens = set(retained.values())
    plan = PreparedJobPlan(
        specification={"operation": "retention-test"},
        summary={},
        reserved_bytes=0,
        operation="retention-test",
        input_uploads=retained,
    )
    owner = "a" * 64
    submitted = store.submit(owner, uuid4().hex, plan, "b" * 64)
    assert "input_uploads" not in submitted
    assert store.active_input_uploads() == tokens
    row = store.claim_next_job()
    assert row["input_uploads"] == retained
    prepared = store.save_prepared_job(
        row["id"], row["attempt_id"], replace(plan, input_uploads={})
    )
    assert prepared["input_uploads"] == retained
    assert store.active_input_uploads() == tokens
    if outcome == "restart":
        assert store.interrupt_unfinished_jobs_on_restart() == 1
    else:
        if outcome == "cancelled":
            assert store.cancel(submitted["id"], owner)["status"] == "cancelling"
            assert store.active_input_uploads() == tokens
        artifact = Artifact(1, "c" * 64, "result.tif") if outcome == "ready" else None
        assert store.finish(row["id"], row["attempt_id"], artifact)
    assert store.active_input_uploads() == set()
    assert "input_uploads" not in store.get(submitted["id"], owner)
