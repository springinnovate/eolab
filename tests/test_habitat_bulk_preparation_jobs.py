"""Exercise durable bulk preparation through real PostgreSQL, workers and admin APIs."""

import asyncio
from typing import Any
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

from fastapi.testclient import TestClient
import psycopg
import pytest

from eolab_app.catalog_selection import ResolvedCatalogSelection
from eolab_app.processing.artifacts import LocalJobArtifacts
from eolab_app.processing.habitat_earth_engine import (
    HabitatCacheCoverage,
    HabitatEarthEngineRuntime,
    HabitatEarthEngineSettings,
)
from eolab_app.processing.habitat_preparation import (
    build_habitat_input_preparation_submission,
)
from eolab_app.processing.habitat_preparation_models import (
    BULK_OPERATION,
    HABITAT_PREPARATION_OWNER,
    HabitatInputPreparationRequest,
)
from eolab_app.processing.job_store import PostgresJobStore
from eolab_app.processing.service import ProcessingService
from eolab_app.processing.worker import ProcessingWorker
from eolab_app.routes.processing import COOKIE
from test_habitat_preparation_jobs import (
    BASE,
    HEADERS,
    PASSWORD,
    preparation_boundary,
    store,
)

PreparationBoundary = tuple[
    TestClient, ProcessingService, ResolvedCatalogSelection, LocalJobArtifacts
]


def _save_preparation(
    store: PostgresJobStore,
    source: ResolvedCatalogSelection,
    *,
    item_id: str | None = None,
    year: int = 2018,
    name: str = "Saved area",
    owner: str = HABITAT_PREPARATION_OWNER,
    predicate: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Persist an ordinary preparation as historical input for bulk admission.

    Args:
        store: Real Processing persistence adapter.
        source: Fixture Catalog descriptor supplying the source shape.
        item_id: Alternate fixture Catalog item identity, if needed.
        year: Scientific assessment year.
        name: Saved administrator label.
        owner: Administrator scope or a deliberately foreign browser scope.
        predicate: Alternate validated feature filter, if needed.

    Returns:
        Admitted ordinary preparation row, still queued.
    """
    selection = source.selection.model_dump(mode="json", by_alias=True)
    if item_id is not None:
        selection["itemId"] = item_id
    if predicate is not None:
        selection["filter"] = predicate
    request = HabitatInputPreparationRequest(
        requestId=uuid4().hex, name=name, selection=selection, year=year
    )
    return store.submit(
        owner,
        request.requestId,
        build_habitat_input_preparation_submission(request),
        request.requestId,
    )


def _retry_all(client: TestClient, request_id: str) -> dict[str, Any]:
    """Submit or recover one protected bulk command through HTTP.

    Args:
        client: Authenticated administrator client.
        request_id: Stable command identifier reused after response loss.

    Returns:
        Accepted bulk job snapshot.
    """
    response = client.post(
        BASE + "/retry-all", json={"requestId": request_id}, headers=HEADERS
    )
    assert response.status_code == 202, response.text
    assert response.headers["cache-control"] == "private, no-store"
    assert response.json()["operation"] == BULK_OPERATION
    return response.json()


def _read_captured_spec(store: PostgresJobStore, identifier: str) -> dict[str, Any]:
    """Read persisted worker inputs without confusing them with the public job summary.

    Args:
        store: Disposable PostgreSQL fixture containing the accepted job.
        identifier: Public administrator handle whose captured scope is under test.

    Returns:
        The full specification retained for the worker.
    """
    with psycopg.connect(store.conninfo) as connection:
        return connection.execute(
            "SELECT j.spec FROM processing.jobs j JOIN processing.job_subscribers s "
            "ON s.job_id=j.id WHERE s.id=%s AND s.owner=%s",
            (identifier, HABITAT_PREPARATION_OWNER),
        ).fetchone()[0]


def test_bulk_admission_survives_browser_close_and_recovers_its_saved_scope(
    preparation_boundary: PreparationBoundary,
    store: PostgresJobStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep an accepted command independent of browsers and later history changes.

    Args:
        preparation_boundary: Real Catalog, PostgreSQL and protected HTTP boundary.
        store: Durable owner of the accepted parent and its captured descriptors.
        monkeypatch: Reject source access during admission and recovery.
    """
    client, service, source, _ = preparation_boundary
    original = _save_preparation(store, source)
    unavailable = AsyncMock(
        side_effect=AssertionError("Admission must not read sources")
    )
    monkeypatch.setattr(service.areas, "resolve_for_sampling", unavailable)
    monkeypatch.setattr(
        "eolab_app.processing.service.build_habitat_input_preparation_submission",
        Mock(side_effect=AssertionError("Admission must not load scientific inputs")),
    )
    request_id = uuid4().hex
    with TestClient(client.app, base_url="https://testserver") as first_browser:
        first_browser.auth = ("admin", PASSWORD)
        accepted = _retry_all(first_browser, request_id)
    saved = store.get(accepted["jobId"], HABITAT_PREPARATION_OWNER)
    saved_spec = _read_captured_spec(store, accepted["jobId"])
    assert saved["status"] == "queued"
    assert accepted["inputs"] == {"areaCount": 1}
    assert len(saved_spec["request"]["areas"]) == 1
    _save_preparation(store, source, year=2019, name="Added after the click")
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET metadata_expires_at=now()-interval '1 second' "
            "WHERE id=%s",
            (original["id"],),
        )
    monkeypatch.setattr(
        store,
        "list_session_jobs_page",
        Mock(side_effect=AssertionError("Recovery must not take a new snapshot")),
    )
    with TestClient(client.app, base_url="https://testserver") as reopened:
        reopened.auth = ("admin", PASSWORD)
        recovered = _retry_all(reopened, request_id)
        assert recovered["jobId"] == accepted["jobId"]
        assert recovered["inputs"] == {"areaCount": 1}
        assert reopened.get(f"{BASE}/{accepted['jobId']}").status_code == 200
    assert _read_captured_spec(store, accepted["jobId"]) == saved_spec
    unavailable.assert_not_awaited()


def test_bulk_snapshot_reads_all_history_and_deduplicates_exact_area_years(
    preparation_boundary: PreparationBoundary, store: PostgresJobStore
) -> None:
    """Capture more than one history page without the calculation batch's fifty-job limit.

    Args:
        preparation_boundary: Real source descriptor and authenticated bulk endpoint.
        store: PostgreSQL history containing duplicates, expired and foreign entries.
    """
    client, _, source, _ = preparation_boundary
    originals = [
        _save_preparation(store, source, item_id=f"area-{index}")
        for index in range(105)
    ]
    _save_preparation(store, source, item_id="area-0", name="Latest label")
    _save_preparation(store, source, item_id="area-0", year=2019)
    _save_preparation(
        store,
        source,
        item_id="area-0",
        predicate={
            "match": "all",
            "rules": [{"field": "selected", "operator": "eq", "value": 1}],
        },
    )
    _save_preparation(store, source, item_id="foreign", owner="b" * 64)
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET metadata_expires_at=now()-interval '1 second' "
            "WHERE id=%s",
            (originals[-1]["id"],),
        )
        for index, status in enumerate(
            ("ready", "failed", "cancelled", "interrupted", "expired")
        ):
            connection.execute(
                "UPDATE processing.jobs SET status=%s WHERE id=%s",
                (status, originals[index]["id"]),
            )
    store.cancel(originals[-2]["id"], HABITAT_PREPARATION_OWNER)
    store.cancel(originals[-2]["id"], HABITAT_PREPARATION_OWNER, delete=True)
    accepted = _retry_all(client, uuid4().hex)
    assert accepted["inputs"] == {"areaCount": 105}
    areas = _read_captured_spec(store, accepted["jobId"])["request"]["areas"]
    assert len(areas) == 105
    assert len({area["requestId"] for area in areas}) == 105
    assert {area["selection"]["itemId"] for area in areas} == {
        f"area-{index}" for index in range(103)
    }
    same_source = [area for area in areas if area["selection"]["itemId"] == "area-0"]
    assert len(same_source) == 3
    assert any(area["name"] == "Latest label" for area in same_source)
    assert all("configurationSha256" not in area for area in areas)
    second = _retry_all(client, uuid4().hex)
    assert second["inputs"] == {"areaCount": 105}


def test_empty_bulk_snapshot_remains_empty_on_recovery(
    preparation_boundary: PreparationBoundary, store: PostgresJobStore
) -> None:
    """Recover an empty accepted command without adding subsequently saved areas.

    Args:
        preparation_boundary: Protected endpoint and real Catalog source.
        store: Durable empty parent plus subsequently admitted ordinary history.
    """
    client, _, source, _ = preparation_boundary
    request_id = uuid4().hex
    accepted = _retry_all(client, request_id)
    assert accepted["inputs"] == {"areaCount": 0}
    _save_preparation(store, source)
    assert _retry_all(client, request_id)["jobId"] == accepted["jobId"]
    assert _read_captured_spec(store, accepted["jobId"])["request"]["areas"] == []


def test_bulk_commands_preserve_admin_authorization_and_request_identity(
    preparation_boundary: PreparationBoundary, store: PostgresJobStore
) -> None:
    """Reject anonymous, cross-origin and conflicting commands without browser ownership.

    Args:
        preparation_boundary: Shared admin and ordinary browser HTTP application.
        store: Job store holding a conflicting ordinary submission identifier.
    """
    client, _, source, _ = preparation_boundary
    existing = _save_preparation(store, source)
    body = {"requestId": uuid4().hex}
    with TestClient(client.app, base_url="https://testserver") as foreign:
        assert (
            foreign.post(BASE + "/retry-all", json=body, headers=HEADERS).status_code
            == 401
        )
        foreign.auth = ("admin", PASSWORD)
        assert foreign.post(BASE + "/retry-all", json=body).status_code == 403
        assert (
            foreign.post(
                BASE + "/retry-all",
                json=body,
                headers={**HEADERS, "Origin": "https://foreign.example"},
            ).status_code
            == 403
        )
        foreign.cookies.set(COOKIE, HABITAT_PREPARATION_OWNER, path="/")
        accepted = _retry_all(foreign, body["requestId"])
        assert (
            foreign.get(f"/api/processing/jobs/{accepted['jobId']}").status_code == 404
        )
    conflict = client.post(
        BASE + "/retry-all",
        json={"requestId": existing["request_key"]},
        headers=HEADERS,
    )
    assert conflict.status_code == 409
    assert (
        client.post(
            BASE + "/retry-all", json={**body, "areas": []}, headers=HEADERS
        ).status_code
        == 422
    )


def test_bulk_worker_finishes_after_browser_close_and_publishes_child_receipts(
    preparation_boundary: PreparationBoundary,
    store: PostgresJobStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Run the real parent after its browser closes and retain its independent child/report.

    Args:
        preparation_boundary: Real admin HTTP, Catalog source and artifact publication.
        store: PostgreSQL queue consumed by an ordinary Processing worker.
        monkeypatch: Supply measured missing coverage without contacting Earth Engine.
    """
    client, service, source, artifacts = preparation_boundary
    original = _save_preparation(store, source)
    store.cancel(original["id"], HABITAT_PREPARATION_OWNER)
    with TestClient(client.app, base_url="https://testserver") as browser:
        browser.auth = ("admin", PASSWORD)
        parent = _retry_all(browser, uuid4().hex)
    coverage = AsyncMock(return_value=HabitatCacheCoverage("a" * 64, 2018, 2, 0, 2))
    monkeypatch.setattr(
        "eolab_app.processing.habitat_bulk_preparation.get_habitat_cache_coverage",
        coverage,
    )
    runtime = HabitatEarthEngineRuntime(
        HabitatEarthEngineSettings(
            "unused-project", artifacts.root / "unused-key.json"
        ),
        artifacts.root / "habitat-cache",
    )
    worker = ProcessingWorker(
        Mock(),
        store,
        artifacts,
        store.limits,
        areas=service.areas,
        operation_settings={BULK_OPERATION: runtime},
    )
    assert asyncio.run(worker.run_once())
    coverage.assert_awaited_once()
    with TestClient(client.app, base_url="https://testserver") as reopened:
        reopened.auth = ("admin", PASSWORD)
        base = f"{BASE}/{parent['jobId']}"
        completed = reopened.get(base).json()
        assert completed["status"] == "ready", completed
        assert completed["result"]["areaCount"] == 1
        assert completed["result"]["queuedCount"] == 1
        report = reopened.get(base + "/report")
        assert report.status_code == 200, report.text
        outcome = report.json()["outcomes"][0]
        assert outcome["status"] == "queued"
        child = reopened.get(f"{BASE}/{outcome['jobId']}").json()
        assert child["operation"] == "habitat.prepare-inputs.v1"
        assert child["status"] == "queued"
        assert reopened.head(base + "/report").headers["content-length"] == str(
            len(report.content)
        )
        assert (
            reopened.get(base + "/report", headers={"Range": "bytes=0-4"}).content
            == report.content[:5]
        )
        assert reopened.get(base + "/provenance").json()["operation"] == BULK_OPERATION
        assert {job["jobId"] for job in reopened.get(BASE).json()["jobs"]} == {
            original["id"],
            parent["jobId"],
            child["jobId"],
        }
        with psycopg.connect(store.conninfo) as connection:
            connection.execute(
                "UPDATE processing.jobs SET expires_at=now()-interval '1 second' WHERE id=%s",
                (parent["jobId"],),
            )
        asyncio.run(worker.cleanup())
        expired = reopened.get(base).json()
        assert expired["status"] == "expired"
        assert expired["inputs"] == {"areaCount": 1}
        assert expired["result"] is None
        assert reopened.get(base + "/report").status_code == 409
        assert reopened.get(f"{BASE}/{child['jobId']}").json()["status"] == "queued"


@pytest.mark.parametrize("terminal_status", ["cancelled", "interrupted"])
def test_stopped_bulk_parent_does_not_cancel_an_accepted_child(
    preparation_boundary: PreparationBoundary,
    store: PostgresJobStore,
    terminal_status: str,
) -> None:
    """Stop the bulk check without transferring cancellation to independently queued work.

    Args:
        preparation_boundary: Real cancellation and status endpoints.
        store: PostgreSQL queue with a claimed parent and an accepted child.
        terminal_status: Explicit cancellation or a parent-specific worker interruption.
    """
    client, _, source, _ = preparation_boundary
    original = _save_preparation(store, source)
    store.cancel(original["id"], HABITAT_PREPARATION_OWNER)
    parent = _retry_all(client, uuid4().hex)
    claimed = store.claim_next_job()
    assert claimed is not None and claimed["id"] == parent["jobId"]
    captured = HabitatInputPreparationRequest.model_validate(
        claimed["spec"]["request"]["areas"][0]
    )
    child = store.submit(
        HABITAT_PREPARATION_OWNER,
        captured.requestId,
        build_habitat_input_preparation_submission(captured),
        captured.requestId,
    )
    if terminal_status == "cancelled":
        response = client.post(f"{BASE}/{parent['jobId']}/cancel", headers=HEADERS)
        assert response.status_code == 202 and response.json()["status"] == "cancelling"
        assert not store.heartbeat(claimed["id"], claimed["attempt_id"], {})
    assert store.finish(
        claimed["id"],
        claimed["attempt_id"],
        None,
        {"code": terminal_status, "detail": "Stopped"},
    )
    assert client.get(f"{BASE}/{parent['jobId']}").json()["status"] == terminal_status
    assert client.get(f"{BASE}/{child['id']}").json()["status"] == "queued"
