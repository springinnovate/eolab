"""Exercise the standalone preview and its real ASGI proxy boundary."""

import ast
from pathlib import Path
from uuid import uuid4

import httpx2
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from job_service.app import create_app
from eolab_app.main import create_app as create_eolab
from eolab_app.routes.jobs_proxy import create_jobs_proxy_router

JOB = str(uuid4())
ARTIFACT = str(uuid4())
SUBMISSION = {
    "operation": "demo.sum.v1",
    "inputs": {"values": [10, 20, 30]},
    "priority": 10,
}
KEY = {"Idempotency-Key": "demo-1"}
BASE = "/api/jobs"
HOOKS = [
    ("POST", BASE, SUBMISSION),
    ("GET", BASE, None),
    ("GET", f"{BASE}/{JOB}", None),
    ("PATCH", f"{BASE}/{JOB}", {"priority": 3}),
    ("POST", f"{BASE}/{JOB}/cancel", None),
    ("GET", f"{BASE}/{JOB}/result", None),
    ("GET", f"{BASE}/{JOB}/artifacts/{ARTIFACT}", None),
    ("GET", f"{BASE}/{JOB}/events", None),
    ("DELETE", f"{BASE}/{JOB}", None),
]


@pytest.mark.parametrize("through_proxy", [False, True])
@pytest.mark.parametrize("method,path,body", HOOKS)
def test_all_hooks_are_explicit_stubs(
    through_proxy: bool, method: str, path: str, body: dict | None
) -> None:
    """Real service/proxy requests never fabricate accepted work or SSE streams."""
    service = create_app()
    if through_proxy:
        client = httpx2.AsyncClient(transport=httpx2.ASGITransport(app=service))
        app = FastAPI()
        app.include_router(create_jobs_proxy_router(client))
    else:
        app = service
    with TestClient(app) as browser:
        response = browser.request(method, path, json=body, headers=KEY)
        assert response.status_code == 501
        assert response.json()["error"]["code"] == "not_implemented"
        assert response.headers["content-type"].startswith("application/json")
        assert response.headers["cache-control"] == "no-store"
        assert "jobId" not in response.text


def test_discovery_docs_and_schemas() -> None:
    """Discovery distinguishes HTTP readiness from nonexistent execution."""
    with TestClient(create_app()) as client:
        health = client.get(f"{BASE}/health").json()
        assert health == {
            "service": "jobs",
            "mode": "stub",
            "ready": True,
            "acceptsJobs": False,
            "apiVersion": "0.1.0",
        }
        assert client.get(f"{BASE}/operations").json() == {"operations": []}
        assert f"{BASE}/openapi.json" in client.get(f"{BASE}/docs").text
        schema = client.get(f"{BASE}/openapi.json").json()
        post = schema["paths"][BASE]["post"]
        assert "501" in post["responses"]
        assert "202" in post["responses"]  # explicitly proposed, never returned
        assert "STUB" in post["description"]
        assert post["parameters"][0]["name"] == "Idempotency-Key"
        assert post["parameters"][0]["required"]
        models = schema["components"]["schemas"]
        assert models["SubmitJob"]["additionalProperties"] is False
        assert set(models["UpdateJob"]["properties"]) == {"priority"}
        assert "timed_out" in models["JobSnapshot"]["properties"]["status"]["enum"]


@pytest.mark.parametrize(
    "body,headers",
    [
        (SUBMISSION, {}),
        ({**SUBMISSION, "priority": True}, KEY),
        ({**SUBMISSION, "priority": 1001}, KEY),
        ({**SUBMISSION, "owner": "other"}, KEY),
        ({**SUBMISSION, "executionTimeoutSeconds": 0}, KEY),
        ({**SUBMISSION, "queueTimeoutSeconds": -1}, KEY),
        ({**SUBMISSION, "inputs": []}, KEY),
        ({**SUBMISSION, "operation": "../code.py"}, KEY),
    ],
)
def test_submission_boundary(body: dict, headers: dict) -> None:
    """Reject malformed contracts before the stub without exposing raw inputs."""
    response = TestClient(create_app()).post(BASE, json=body, headers=headers)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


@pytest.mark.parametrize(
    "path",
    [
        f"{BASE}?limit=0",
        f"{BASE}?limit=101",
        f"{BASE}?status=unknown",
        f"{BASE}/not-a-uuid",
    ],
)
def test_invalid_job_identity_or_listing(path: str) -> None:
    """Listing and IDs are validated even though no job storage exists."""
    assert TestClient(create_app()).get(path).status_code == 422


def test_unknown_method_path_and_body_limit() -> None:
    """Keep direct container errors structured and reject oversized bodies."""
    client = TestClient(create_app())
    assert client.put(BASE, json={}).json()["error"]["code"] == "method_not_allowed"
    assert client.get(f"{BASE}/not/a/route").json()["error"]["code"] == "not_found"
    response = client.post(BASE, content=b"x" * 65537, headers=KEY)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "request_too_large"
    assert (
        client.post(
            BASE, content="{broken", headers={**KEY, "Content-Type": "application/json"}
        ).status_code
        == 422
    )


def test_composed_eolab_routes_to_independent_service(
    configured_environment: None, version_file_path: Path
) -> None:
    """The public prefix reaches the standalone service, not frontend fallback."""
    app = create_eolab(
        version_file_path, jobs_transport=httpx2.ASGITransport(app=create_app())
    )
    client = TestClient(app)
    assert client.get(f"{BASE}/health").json()["mode"] == "stub"
    assert client.get(f"{BASE}/operations").json() == {"operations": []}
    assert client.get(f"{BASE}/docs").status_code == 200
    assert client.get(f"{BASE}/openapi.json").json()["info"]["version"] == "0.1.0"
    assert client.get("/healthz").status_code == 200
    assert "/api/processing/jobs" in app.openapi()["paths"]
    assert not any(path.startswith(BASE) for path in app.openapi()["paths"])


def test_proxy_is_bounded_and_does_not_forward_credentials() -> None:
    """Only the fixed prefix and minimal API headers cross the new HTTP edge."""
    seen = []

    def respond(request: httpx2.Request) -> httpx2.Response:
        """Capture the request and simulate a bounded service response.

        Args:
            request: Outbound HTTP request.

        Returns:
            Stub result, oversized body or attempted redirect.
        """
        seen.append(request)
        if request.url.path.endswith("/health"):
            return httpx2.Response(200, content=b"x" * 1048577)
        if request.url.path.endswith("/docs"):
            return httpx2.Response(302, headers={"Location": "http://private/"})
        return httpx2.Response(
            501,
            json={"error": {"code": "not_implemented", "message": "stub"}},
            headers={"Set-Cookie": "unsafe=1"},
        )

    app = FastAPI()
    app.include_router(
        create_jobs_proxy_router(
            httpx2.AsyncClient(transport=httpx2.MockTransport(respond))
        )
    )
    browser = TestClient(app)
    response = browser.post(
        BASE,
        json=SUBMISSION,
        headers={**KEY, "Cookie": "session=private", "Authorization": "Bearer private"},
    )
    assert response.status_code == 501
    assert "set-cookie" not in response.headers
    assert seen[0].url.host == "jobs"
    assert seen[0].url.path == BASE
    assert seen[0].headers["idempotency-key"] == "demo-1"
    assert "cookie" not in seen[0].headers and "authorization" not in seen[0].headers
    assert browser.get(f"{BASE}/health").json()["error"]["code"] == "response_too_large"
    assert browser.get(f"{BASE}/docs").status_code == 502
    count = len(seen)
    assert browser.post(BASE, content=b"x" * 65537).status_code == 413
    assert browser.get(f"{BASE}/%2e%2e/private").status_code == 404
    assert len(seen) == count


def test_jobs_outage_is_local(
    configured_environment: None, version_file_path: Path
) -> None:
    """Job service absence does not break application creation or normal health."""

    def unavailable(request: httpx2.Request) -> httpx2.Response:
        """Simulate a disconnected internal service.

        Args:
            request: Job service request.

        Raises:
            httpx2.ConnectError: Always, to model an outage.
        """
        raise httpx2.ConnectError("private hostname", request=request)

    app = create_eolab(
        version_file_path, jobs_transport=httpx2.MockTransport(unavailable)
    )
    client = TestClient(app)
    assert client.get("/healthz").status_code == 200
    response = client.get(f"{BASE}/health")
    assert response.status_code == 502
    assert "private hostname" not in response.text


def test_standalone_service_has_no_eolab_dependencies() -> None:
    """Keep feature and infrastructure dependencies out of the new service."""
    root = Path(__file__).parents[1]
    for path in (root / "services/jobs/job_service").glob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            imports = (
                [alias.name for alias in node.names]
                if isinstance(node, ast.Import)
                else ([node.module or ""] if isinstance(node, ast.ImportFrom) else [])
            )
            assert not any(
                name.startswith(
                    (
                        "eolab_app",
                        "eolab_infrastructure",
                        "fiona",
                        "rasterio",
                        "psycopg",
                    )
                )
                for name in imports
            )
    dockerfile = (root / "services/jobs/Dockerfile").read_text()
    assert "USER jobs" in dockerfile
    assert "COPY src/" not in dockerfile
    compose = (
        (root / "docker-compose.yml")
        .read_text()
        .split("  jobs:\n", 1)[1]
        .split("  app:\n", 1)[0]
    )
    assert "dockerfile: services/jobs/Dockerfile" in compose
    assert "read_only: true" in compose
    assert (
        "depends_on:" not in compose
        and "volumes:" not in compose
        and "ports:" not in compose
    )


def test_jobs_pins_are_reviewed_web_stack_subset() -> None:
    """Independent image excludes GIS wheels without introducing new resolutions."""
    root = Path(__file__).parents[1]
    jobs = {
        line
        for line in (root / "services/jobs/requirements.txt").read_text().splitlines()
        if line and not line.startswith("#")
    }
    application = set(
        (root / "deployment/application-runtime-requirements.txt")
        .read_text()
        .splitlines()
    )
    assert jobs <= application
    assert not any(
        line.startswith(("numpy", "rasterio", "fiona", "psycopg")) for line in jobs
    )
