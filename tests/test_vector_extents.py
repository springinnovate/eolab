"""Verify filtered extent reads across original sources, Jobs and browser boundaries."""

import asyncio
import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from uuid import uuid4

import fiona
import httpx2
import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request
from starlette.responses import Response

from eolab_app.attribute_filter import VectorFilter, ogr_predicate
from eolab_app.bounded_geometry import GeometryValidationError
from eolab_app.bounded_vector import VectorReadLimits
from eolab_app.catalog_selection import CatalogSelection, ResolvedCatalogSelection
from eolab_app.main import create_app
from eolab_app.routes.vector_sampling import create_vector_sampling_router
from eolab_app.vector.catalog import StacVectorCatalog
from eolab_app.vector.extent_jobs import ExtentJobs
from eolab_app.vector.extent_operation import (
    ArtifactExtentSelection,
    ArtifactSourceLocation,
    FeatureExtent,
    SelectionExtentResult,
    resolve_artifact_path,
)
from eolab_app.vector.extents import read_selected_extent
from eolab_app.vector.filters import CatalogVectorFilterRequest
from eolab_app.vector.sampling import VectorSamplingService
from eolab_app.vector.sources import MountedVectorResolver
from eolab_jobs.client import JobResult, JobsClient

from test_outline_jobs import outline_case

TOKEN = "test-outline-" + "a" * 40
EXTENT = {"matched": 1, "bbox": [0.0, 0.0, 4.0, 4.0]}


@pytest.mark.parametrize("case", ["valid", "empty", "wrong-layer"])
def test_registered_extent_reads_original_filtered_features(
    outline_case: tuple[CatalogSelection, dict[str, Any], str],
    tmp_path: Path,
    case: str,
) -> None:
    """Measure original coordinates through the registered operation's native runner.

    Args:
        outline_case: HTTP Catalog and mounted polygons used by outline tests too.
        tmp_path: Readable fixture mount, injected only as deployment configuration.
        case: Valid selection, empty predicate, or wrong native layer.
    """
    selection, _, url = outline_case
    if case == "empty":
        selection = selection.model_copy(
            update={
                "filter": VectorFilter(
                    rules=[{"field": "selected", "operator": "eq", "value": 99}]
                )
            }
        )
    if case == "wrong-layer":
        selection = selection.model_copy(update={"layerName": "other"})
    descriptor = selection.model_dump(mode="json", by_alias=True)
    command = (
        "from pathlib import Path; from eolab_app.vector import extent_operation as op; "
        f"op.CATALOG_URL={url!r}; op.SCAN_MOUNT=Path({str(tmp_path)!r}); "
        "from job_service.runner import main; main()"
    )
    result = subprocess.run(
        [sys.executable, "-c", command],
        cwd=Path(__file__).parents[1] / "services/jobs",
        input=json.dumps(
            {
                "operation": "vector.selection-extent.v1",
                "inputs": {
                    "selection": descriptor,
                },
            }
        ).encode(),
        capture_output=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr.decode()
    reply = json.loads(result.stdout)
    if case == "wrong-layer":
        assert reply["ok"]
        assert reply["value"]["extent"] is None
        assert "identity changed" in reply["value"]["error"]
    elif case == "empty":
        assert reply["ok"]
        assert reply["value"]["extent"] == {"matched": 0, "bbox": None}
        assert reply["value"]["error"] is None
    else:
        measured = SelectionExtentResult.model_validate(reply["value"])
        assert measured.error is None
        assert measured.extent.model_dump(mode="json") == EXTENT
        assert "geometry" not in reply["value"]


@pytest.mark.parametrize(
    "outcome",
    [
        "success",
        "empty",
        "full",
        "unauthorized",
        "restart",
        "expired",
        "timed_out",
        "failed",
    ],
)
def test_application_reads_extent_only_through_jobs(
    outline_case: tuple[CatalogSelection, dict[str, Any], str],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    configured_environment: None,
    version_file_path: Path,
    outcome: str,
) -> None:
    """Preserve public selection results and errors through real app composition.

    Args:
        outline_case: Real authorized source and HTTP Catalog.
        tmp_path: Mounted fixture root.
        monkeypatch: Isolated app deployment settings.
        configured_environment: Complete application environment.
        version_file_path: Application version fixture.
        outcome: Jobs completion, rejection, or lifecycle failure.
    """
    selection, _, catalog_url = outline_case
    monkeypatch.setenv("CATALOG_INTERNAL_URL", catalog_url)
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(tmp_path))
    job_id = str(uuid4())
    calls: list[httpx2.Request] = []

    def respond(request: httpx2.Request) -> httpx2.Response:
        """Return Jobs protocol responses without replacing application logic.

        Args:
            request: Authenticated request to the internal Jobs host.

        Returns:
            Controlled lifecycle state or operation result.
        """
        calls.append(request)
        assert request.url.host == "jobs"
        assert request.headers["authorization"] == f"Bearer {TOKEN}"
        if outcome in {"full", "unauthorized"}:
            return httpx2.Response(503 if outcome == "full" else 401)
        if request.method == "DELETE":
            return httpx2.Response(204)
        if outcome == "restart" and request.method == "GET":
            return httpx2.Response(404)
        if request.url.path.endswith("/result"):
            value = (
                {"extent": {"matched": 0, "bbox": None}}
                if outcome == "empty"
                else {"extent": EXTENT}
            )
            return httpx2.Response(200, json={"jobId": job_id, "value": value})
        status = (
            outcome if outcome in {"expired", "timed_out", "failed"} else "succeeded"
        )
        return httpx2.Response(202, json={"jobId": job_id, "status": status})

    def reject_rendering(request: httpx2.Request) -> httpx2.Response:
        """Reject any dependency on WMS publication while measuring source bounds.

        Args:
            request: Unexpected GeoServer request.

        Raises:
            AssertionError: Always, because original-source zoom needs no renderer.
        """
        raise AssertionError(f"Vector extent contacted rendering: {request.url}")

    app = create_app(
        version_file_path,
        jobs_transport=httpx2.MockTransport(respond),
        geoserver_transport=httpx2.MockTransport(reject_rendering),
    )
    with TestClient(app) as browser:
        response = browser.post(
            "/api/vector-sampling/extent",
            json={
                "collectionId": selection.collection_id,
                "itemId": selection.item_id,
                "filter": selection.filter.model_dump(mode="json"),
            },
        )
    payload = json.loads(calls[0].content)
    assert payload["operation"] == "vector.selection-extent.v1"
    assert payload["inputs"] == {
        "selection": selection.model_dump(mode="json", by_alias=True),
        "uploadOwner": None,
    }
    assert payload["priority"] > -10
    assert payload["executionTimeoutSeconds"] == 15
    assert payload["queueTimeoutSeconds"] == 30
    assert TOKEN not in response.text and str(tmp_path) not in response.text
    if outcome in {"success", "empty"}:
        assert response.status_code == 200, response.text
        assert response.json() == (
            EXTENT if outcome == "success" else {"matched": 0, "bbox": None}
        )
        assert calls[-1].method == "DELETE"
    else:
        assert response.status_code == 409, response.text
        expected = {
            "empty": "No matching",
            "full": "busy or unavailable",
            "unauthorized": "unavailable",
            "restart": "unavailable",
            "expired": "waited too long",
            "timed_out": "time budget",
            "failed": "could not be read",
        }[outcome]
        assert expected in response.text


@pytest.mark.parametrize("status", ["queued", "running"])
def test_route_disconnect_cancels_only_its_extent(
    outline_case: tuple[CatalogSelection, dict[str, Any], str],
    tmp_path: Path,
    status: str,
) -> None:
    """Propagate the route's disconnect to the exact admitted Jobs identity.

    Args:
        outline_case: Real catalog descriptor and source.
        tmp_path: Fixture source mount.
        status: State when the browser connection is lost.
    """
    selection, _, url = outline_case

    async def scenario() -> None:
        """Disconnect during admission, then verify cancellation and deletion."""
        admitted, disconnected, release = (
            asyncio.Event(),
            asyncio.Event(),
            asyncio.Event(),
        )
        job_id = str(uuid4())
        calls: list[tuple[str, str]] = []

        async def respond(request: httpx2.Request) -> httpx2.Response:
            """Keep the admission response in flight until the browser leaves.

            Args:
                request: Jobs lifecycle request.

            Returns:
                The admitted job or its cancellation acknowledgement.
            """
            calls.append((request.method, request.url.path))
            if request.url.path == "/api/jobs":
                admitted.set()
                await release.wait()
                return httpx2.Response(202, json={"jobId": job_id, "status": status})
            if request.url.path.endswith("/cancel"):
                return httpx2.Response(
                    200, json={"jobId": job_id, "status": "cancelled"}
                )
            return httpx2.Response(204)

        async def receive() -> dict[str, Any]:
            """Wait for the browser disconnect message.

            Returns:
                The ASGI disconnect event.
            """
            await disconnected.wait()
            return {"type": "http.disconnect"}

        async with (
            httpx2.AsyncClient() as catalog_http,
            httpx2.AsyncClient(transport=httpx2.MockTransport(respond)) as job_http,
        ):
            service = VectorSamplingService(
                StacVectorCatalog(catalog_http, url),
                MountedVectorResolver(tmp_path),
                extent_executor=ExtentJobs(JobsClient(job_http, TOKEN)),
            )
            router = create_vector_sampling_router(service)
            endpoint = next(
                route.endpoint
                for route in router.routes
                if route.path.endswith("/extent")
            )
            task = asyncio.create_task(
                endpoint(
                    CatalogVectorFilterRequest(
                        collectionId=selection.collection_id,
                        itemId=selection.item_id,
                        filter=selection.filter,
                    ),
                    Request({"type": "http"}, receive),
                    Response(),
                )
            )
            await asyncio.wait_for(admitted.wait(), 5)
            disconnected.set()
            release.set()
            from fastapi import HTTPException

            with pytest.raises(HTTPException) as failure:
                await asyncio.wait_for(task, 5)
            assert failure.value.status_code == 499
        assert calls[-2:] == [
            ("POST", f"/api/jobs/{job_id}/cancel"),
            ("DELETE", f"/api/jobs/{job_id}"),
        ]

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "case", ["valid", "empty", "null-geometry", "denied", "traversal", "missing-lease"]
)
def test_registered_extent_reads_leased_artifact_through_source_authority(
    tmp_path: Path, case: str
) -> None:
    """Use the registered runner, HTTP source capability and real GeoPackage reader.

    Args:
        tmp_path: Read-only worker mount populated with one published result.
        case: Successful extent, no coordinates, denied source or invalid descriptor.
    """
    directory = tmp_path / "results" / ("d" * 32)
    directory.mkdir(parents=True)
    path = directory / "features.gpkg"
    with fiona.open(
        path,
        "w",
        driver="GPKG",
        layer="features",
        crs="EPSG:4326",
        schema={"geometry": "Point", "properties": {"name": "str"}},
    ) as dataset:
        for name, coordinates in [
            ("Exact", (0, 1)),
            ("exact", (20, 30)),
            ("Null", None),
        ]:
            dataset.write(
                {
                    "geometry": (
                        {"type": "Point", "coordinates": coordinates}
                        if coordinates is not None
                        else None
                    ),
                    "properties": {"name": name},
                }
            )
    selection = ArtifactExtentSelection(
        kind="runArtifact",
        jobId="a" * 32,
        artifactId="b" * 32,
        filter=VectorFilter(
            rules=[
                {
                    "field": "name",
                    "operator": "eq",
                    "value": {"empty": "Absent", "null-geometry": "Null"}.get(
                        case, "Exact"
                    ),
                }
            ]
        ),
    )
    lease = "c" * 32
    calls: list[tuple[str, str | None]] = []

    class SourceHandler(BaseHTTPRequestHandler):
        """Serve only the internal leased-source descriptor used by this worker."""

        def do_GET(self) -> None:
            """Record the capability and return source metadata or an authorization failure."""
            calls.append((self.path, self.headers.get("Authorization")))
            relative = path.relative_to(tmp_path).as_posix()
            body = json.dumps(
                {
                    "relativePath": (
                        "results/../secret.gpkg" if case == "traversal" else relative
                    ),
                    "mediaType": "application/geopackage+sqlite3",
                }
            ).encode()
            self.send_response(403 if case == "denied" else 200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: Any) -> None:
            """Keep controlled source HTTP responses out of test output.

            Args:
                format: Standard HTTP log format.
                args: Values supplied by the fixture server.
            """

    server = ThreadingHTTPServer(("127.0.0.1", 0), SourceHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    command = f"""
from pathlib import Path
import sys
from eolab_app.vector import extent_operation as op, extents
op.SOURCE_FILES_URL = 'http://127.0.0.1:{server.server_port}/source-files'
op.PROCESSING_MOUNT = Path({str(tmp_path)!r})
original_read = extents.read_file_extent
def check_memory_and_read(path, candidate):
    if sys.platform == 'linux':
        import resource
        assert 0 < resource.getrlimit(resource.RLIMIT_AS)[0] <= 2 * 1024**3
    return original_read(path, candidate)
extents.read_file_extent = check_memory_and_read
from job_service.runner import main
main()
"""
    inputs = {"selection": selection.model_dump(mode="json")}
    if case != "missing-lease":
        inputs["readLease"] = lease
    try:
        result = subprocess.run(
            [sys.executable, "-c", command],
            cwd=Path(__file__).parents[1] / "services/jobs",
            input=json.dumps(
                {"operation": "vector.selection-extent.v1", "inputs": inputs}
            ).encode(),
            capture_output=True,
            timeout=20,
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    assert result.returncode == 0, result.stderr.decode()
    reply = json.loads(result.stdout)
    assert (
        str(tmp_path) not in result.stdout.decode()
        and lease not in result.stdout.decode()
    )
    if case == "missing-lease":
        assert reply == {"ok": False} and not calls
        return
    assert calls == [
        (f"/source-files/{selection.jobId}/{selection.artifactId}", f"Bearer {lease}")
    ]
    assert reply["ok"]
    if case in {"denied", "traversal"}:
        assert reply["value"]["extent"] is None
        assert reply["value"]["error"] == "The selected vector result is unavailable."
    else:
        expected = {
            "valid": {"matched": 1, "bbox": [0, 1, 0, 1]},
            "empty": {"matched": 0, "bbox": None},
            "null-geometry": {"matched": 1, "bbox": None},
        }
        assert reply["value"]["extent"] == expected[case]
        assert reply["value"]["error"] is None


@pytest.mark.parametrize(
    "relative",
    [
        "/results/file.gpkg",
        "C:/results/file.gpkg",
        "results/../secret.gpkg",
        "results/./file.gpkg",
        "results\\file.gpkg",
        "results/missing.gpkg",
        "results",
    ],
)
def test_internal_artifact_locator_confines_the_native_reader(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, relative: str
) -> None:
    """Reject absolute, traversing, missing and non-file internal source locations.

    Args:
        tmp_path: Shared mount containing only a results directory.
        monkeypatch: Configure the worker mount without changing a public input.
        relative: Invalid internal source authority response.
    """
    from eolab_app.catalog_selection import SelectionUnavailableError

    (tmp_path / "results").mkdir()
    monkeypatch.setattr("eolab_app.vector.extent_operation.PROCESSING_MOUNT", tmp_path)
    with pytest.raises(SelectionUnavailableError, match="unavailable"):
        resolve_artifact_path(
            ArtifactSourceLocation(
                relativePath=relative, mediaType="application/geopackage+sqlite3"
            )
        )


def test_internal_artifact_locator_rejects_linked_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Reject a symbolic link even when its target stays inside published results.

    Args:
        tmp_path: Shared mount containing an immutable file and a linked alias.
        monkeypatch: Configure the worker mount for the filesystem boundary.
    """
    from eolab_app.catalog_selection import SelectionUnavailableError

    directory = tmp_path / "results"
    directory.mkdir()
    original = directory / "original.gpkg"
    original.write_bytes(b"immutable")
    try:
        (directory / "linked.gpkg").symlink_to(original)
    except OSError:
        pytest.skip("This host does not permit symbolic-link creation")
    monkeypatch.setattr("eolab_app.vector.extent_operation.PROCESSING_MOUNT", tmp_path)
    with pytest.raises(SelectionUnavailableError, match="unavailable"):
        resolve_artifact_path(
            ArtifactSourceLocation(
                relativePath="results/linked.gpkg",
                mediaType="application/geopackage+sqlite3",
            )
        )


def test_artifact_extent_uses_existing_budgets_and_waits_for_terminal_cleanup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Require confirmed native exit before the caller releases a run-file lease.

    Args:
        monkeypatch: Observe options at the existing JobsClient boundary.
    """
    captured: list[tuple[dict[str, Any], dict[str, Any]]] = []

    async def run(
        client: JobsClient, payload: dict[str, Any], **options: Any
    ) -> JobResult:
        """Capture the submitted operation and return its ordinary typed result.

        Args:
            client: Existing Jobs client receiving the request.
            payload: Registered operation and immutable source inputs.
            options: Client deadline, deletion and cleanup settings.

        Returns:
            Completed Jobs response containing the native extent contract.
        """
        captured.append((payload, options))
        return JobResult(jobId=uuid4(), value={"extent": EXTENT})

    monkeypatch.setattr(JobsClient, "run", run)
    selection = ArtifactExtentSelection(
        kind="runArtifact", jobId="a" * 32, artifactId="b" * 32, filter=VectorFilter()
    )

    async def scenario() -> dict[str, Any]:
        """Call the real extent adapter with an opaque source capability.

        Returns:
            Validated matching count and bounds from the registered operation.
        """
        async with httpx2.AsyncClient() as http:
            return await ExtentJobs(JobsClient(http, TOKEN)).measure_artifact(
                selection, "c" * 32
            )

    assert asyncio.run(scenario()) == EXTENT
    assert captured == [
        (
            {
                "operation": "vector.selection-extent.v1",
                "inputs": {
                    "selection": selection.model_dump(mode="json"),
                    "readLease": "c" * 32,
                },
                "priority": 0,
                "executionTimeoutSeconds": 15,
                "queueTimeoutSeconds": 30,
            },
            {
                "timeout_seconds": 60,
                "delete_on_completion": True,
                "require_terminal_cleanup": True,
            },
        )
    ]
