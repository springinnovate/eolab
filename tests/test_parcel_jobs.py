"""Exercise parcel requests across Catalog, HTTP, Jobs and native runner boundaries."""

import asyncio
import json
from pathlib import Path
import subprocess
import sys
from typing import Any
from uuid import uuid4

from fastapi import HTTPException
from fastapi.testclient import TestClient
import httpx2
import pytest
from starlette.requests import Request

from eolab_app.attribute_filter import VectorFilter
from eolab_app.catalog_selection import CatalogSelection
from eolab_app.main import create_app
from eolab_app.routes.vector_sampling import create_vector_sampling_router
from eolab_app.vector.catalog import StacVectorCatalog
from eolab_app.vector.parcel_jobs import ParcelJobs
from eolab_app.vector.parcel_models import ParcelIdRequest, ParcelRowsRequest
from eolab_app.vector.sampling import VectorSamplingService
from eolab_app.vector.sources import MountedVectorResolver
from eolab_jobs.client import JobsClient

from test_outline_jobs import outline_case

TOKEN = "test-outline-" + "a" * 40
VALIDATION = {"idField": "selected", "idType": "integer", "featureCount": 2}
PAGE = {
    "rows": [
        {"id": {"type": "integer", "value": "1"}, "properties": {"selected": "1"}}
    ],
    "offset": 0,
    "nextOffset": None,
}


@pytest.mark.parametrize("operation", ["parcel-id-validation", "parcel-rows"])
@pytest.mark.parametrize("wrong_layer", [False, True])
def test_registered_parcel_reader_uses_original_catalog_source(
    outline_case: tuple[CatalogSelection, dict[str, Any], str],
    tmp_path: Path,
    operation: str,
    wrong_layer: bool,
) -> None:
    """Read real polygon attributes through the registered isolated native runner.

    Args:
        outline_case: HTTP Catalog and two original GeoPackage polygons.
        tmp_path: Source mount supplied as deployment configuration.
        operation: Full ID validation or one selected attribute page.
        wrong_layer: Substitute the descriptor's native layer to prove reauthorization.
    """
    selection, _, catalog_url = outline_case
    if operation == "parcel-id-validation":
        selection = selection.model_copy(update={"filter": VectorFilter()})
    if wrong_layer:
        selection = selection.model_copy(update={"layerName": "other"})
    inputs = {
        "selection": selection.model_dump(mode="json", by_alias=True),
        "idField": "selected",
    }
    if operation == "parcel-rows":
        inputs.update(fields=["selected"], offset=0, limit=1)
    command = (
        "from pathlib import Path; from eolab_app.vector import parcel_operation as op; "
        f"op.CATALOG_URL={catalog_url!r}; op.SCAN_MOUNT=Path({str(tmp_path)!r}); "
        "from job_service.runner import main; main()"
    )
    result = subprocess.run(
        [sys.executable, "-c", command],
        cwd=Path(__file__).parents[1] / "services/jobs",
        input=json.dumps(
            {"operation": f"vector.{operation}.v1", "inputs": inputs}
        ).encode(),
        capture_output=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr.decode()
    reply = json.loads(result.stdout)
    assert reply["ok"], result.stderr.decode()
    if wrong_layer:
        assert "identity changed" in reply["value"]["error"]
    else:
        key, expected = (
            ("validation", VALIDATION)
            if operation == "parcel-id-validation"
            else ("page", PAGE)
        )
        assert reply["value"][key] == expected
        assert reply["value"]["error"] is None
    assert str(tmp_path) not in result.stdout.decode()


@pytest.mark.parametrize("route", ["validate-id", "rows"])
@pytest.mark.parametrize(
    "outcome", ["success", "invalid", "full", "unauthorized", "timed_out", "malformed"]
)
def test_parcel_routes_use_composed_jobs_without_rendering(
    outline_case: tuple[CatalogSelection, dict[str, Any], str],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    configured_environment: None,
    version_file_path: Path,
    route: str,
    outcome: str,
) -> None:
    """Keep actual HTTP parcel identities and errors independent of GeoServer.

    Args:
        outline_case: Authorized original Catalog source.
        tmp_path: Mounted source directory.
        monkeypatch: Isolated deployment settings.
        configured_environment: Complete application configuration fixture.
        version_file_path: Existing version file fixture.
        route: Full validation or selected row route.
        outcome: Native result or controlled Jobs lifecycle failure.
    """
    selection, _, catalog_url = outline_case
    monkeypatch.setenv("CATALOG_INTERNAL_URL", catalog_url)
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(tmp_path))
    job_id = str(uuid4())
    calls: list[httpx2.Request] = []
    key, expected = (
        ("validation", VALIDATION) if route == "validate-id" else ("page", PAGE)
    )

    def respond(request: httpx2.Request) -> httpx2.Response:
        """Return Jobs lifecycle messages while retaining real application composition.

        Args:
            request: Authenticated request to the Jobs service.

        Returns:
            A controlled admission/status/result/deletion response.
        """
        calls.append(request)
        assert request.url.host == "jobs"
        assert request.headers["authorization"] == f"Bearer {TOKEN}"
        if outcome in {"full", "unauthorized"}:
            return httpx2.Response(503 if outcome == "full" else 401)
        if request.method == "DELETE":
            return httpx2.Response(204)
        if request.url.path.endswith("/result"):
            value = {key: expected}
            if outcome == "invalid":
                value = {
                    "error": "Parcel IDs must be unique across the entire original layer"
                }
            elif outcome == "malformed":
                value = {key: {"unexpected": True}}
            return httpx2.Response(200, json={"jobId": job_id, "value": value})
        return httpx2.Response(
            202,
            json={
                "jobId": job_id,
                "status": "timed_out" if outcome == "timed_out" else "succeeded",
            },
        )

    payload = {
        "collectionId": selection.collection_id,
        "itemId": selection.item_id,
        "idField": "selected",
    }
    if route == "rows":
        payload.update(
            filter=selection.filter.model_dump(mode="json"),
            fields=["selected"],
            limit=1,
        )
    app = create_app(version_file_path, jobs_transport=httpx2.MockTransport(respond))
    with TestClient(app) as browser:
        response = browser.post(f"/api/vector-sampling/parcels/{route}", json=payload)
    submitted = json.loads(calls[0].content)
    assert submitted["operation"] == (
        "vector.parcel-id-validation.v1"
        if route == "validate-id"
        else "vector.parcel-rows.v1"
    )
    assert submitted["executionTimeoutSeconds"] == 15
    assert submitted["queueTimeoutSeconds"] == 30
    assert submitted["inputs"]["selection"]["filter"] == (
        VectorFilter().model_dump(mode="json")
        if route == "validate-id"
        else selection.filter.model_dump(mode="json")
    )
    assert response.headers["cache-control"] == "private, no-store"
    assert TOKEN not in response.text and str(tmp_path) not in response.text
    if outcome == "success":
        assert response.status_code == 200, response.text
        source = submitted["inputs"]["selection"]
        assert response.json() == {**expected, "selection": source}
        assert calls[-1].method == "DELETE"
    else:
        assert response.status_code == 409, response.text
        message = {
            "invalid": "unique",
            "full": "busy",
            "unauthorized": "unavailable",
            "timed_out": "time budget",
            "malformed": "unavailable",
        }[outcome]
        assert message in response.text


@pytest.mark.parametrize("route", ["validate-id", "rows"])
@pytest.mark.parametrize(
    "extra", [{"path": "/private"}, {"uploadId": str(uuid4())}, {"kind": "runArtifact"}]
)
def test_parcel_public_boundary_rejects_private_sources_and_paths(
    configured_environment: None,
    version_file_path: Path,
    route: str,
    extra: dict[str, str],
) -> None:
    """Reject source substitutions before any Catalog or Jobs read.

    Args:
        configured_environment: Existing deployment configuration fixture.
        version_file_path: Existing version file fixture.
        route: Public parcel request endpoint.
        extra: Unsupported private-source or filesystem argument.
    """
    app = create_app(version_file_path)
    payload = {
        "collectionId": "eolab-mounted-vectors",
        "itemId": "item",
        "idField": "id",
        **extra,
    }
    if route == "rows":
        payload["filter"] = {"rules": []}
    with TestClient(app) as browser:
        response = browser.post(f"/api/vector-sampling/parcels/{route}", json=payload)
    assert response.status_code == 422
    assert any(error["loc"][-1] in extra for error in response.json()["detail"])


@pytest.mark.parametrize("route", ["validate-id", "rows"])
def test_parcel_disconnect_cancels_its_admitted_job(
    outline_case: tuple[CatalogSelection, dict[str, Any], str],
    tmp_path: Path,
    route: str,
) -> None:
    """Recover admission, request cancellation and delete a terminal result.

    Args:
        outline_case: Real HTTP Catalog and accepted source.
        tmp_path: Mounted source directory.
        route: Public validation or row endpoint.
    """
    selection, _, catalog_url = outline_case

    async def scenario() -> None:
        """Disconnect during admission and verify cancel, terminal polling and deletion."""
        admitted, disconnected, release = (
            asyncio.Event(),
            asyncio.Event(),
            asyncio.Event(),
        )
        job_id = str(uuid4())
        calls: list[tuple[str, str]] = []

        async def respond(request: httpx2.Request) -> httpx2.Response:
            """Hold admission until disconnect, then report terminal cancellation.

            Args:
                request: Jobs lifecycle request.

            Returns:
                The accepted job, terminal cancellation or deletion acknowledgement.
            """
            calls.append((request.method, request.url.path))
            if request.url.path == "/api/jobs":
                admitted.set()
                await release.wait()
                return httpx2.Response(202, json={"jobId": job_id, "status": "running"})
            if request.method == "DELETE":
                return httpx2.Response(204)
            return httpx2.Response(200, json={"jobId": job_id, "status": "cancelled"})

        async def receive() -> dict[str, str]:
            """Wait for the simulated browser disconnect and return its ASGI event."""
            await disconnected.wait()
            return {"type": "http.disconnect"}

        async with (
            httpx2.AsyncClient() as catalog_http,
            httpx2.AsyncClient(transport=httpx2.MockTransport(respond)) as job_http,
        ):
            service = VectorSamplingService(
                StacVectorCatalog(catalog_http, catalog_url),
                MountedVectorResolver(tmp_path),
                parcel_executor=ParcelJobs(JobsClient(job_http, TOKEN)),
            )
            router = create_vector_sampling_router(service)
            endpoint = next(
                item.endpoint
                for item in router.routes
                if item.path.endswith("/" + route)
            )
            values = {
                "collectionId": selection.collection_id,
                "itemId": selection.item_id,
                "idField": "selected",
            }
            payload = (
                ParcelIdRequest(**values)
                if route == "validate-id"
                else ParcelRowsRequest(**values, filter=selection.filter)
            )
            task = asyncio.create_task(
                endpoint(payload, Request({"type": "http"}, receive))
            )
            await asyncio.wait_for(admitted.wait(), 5)
            disconnected.set()
            release.set()
            with pytest.raises(HTTPException) as failure:
                await asyncio.wait_for(task, 5)
            assert failure.value.status_code == 499
        assert ("POST", f"/api/jobs/{job_id}/cancel") in calls
        assert calls[-1] == ("DELETE", f"/api/jobs/{job_id}")

    asyncio.run(scenario())
