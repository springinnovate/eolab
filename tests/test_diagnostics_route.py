"""Test the public rendering diagnostics route and classification."""

from pathlib import Path

import httpx2
import pytest
from fastapi.testclient import TestClient

from eolab_app.main import create_app
from tests.app_support import VALID_GEOSERVER_METRICS


def test_rendering_diagnostics_exposes_only_the_safe_summary(
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Convert internal probes into explicit browser-safe values and units."""
    requests: list[httpx2.Request] = []

    def diagnostics_response(request: httpx2.Request) -> httpx2.Response:
        requests.append(request)
        if request.url.port == 9404 and request.url.path == "/metrics":
            return httpx2.Response(
                200,
                text=VALID_GEOSERVER_METRICS,
                headers={"content-type": "text/plain; version=0.0.4"},
            )
        if request.url.path == "/geoserver/eolab/wms":
            assert request.url.params["request"] == "GetCapabilities"
            return httpx2.Response(
                200,
                text='<WMS_Capabilities version="1.3.0"/>',
                headers={"content-type": "application/xml"},
            )
        raise AssertionError(f"Unexpected diagnostics request: {request.url}")

    with TestClient(
        create_app(
            version_file_path,
            geoserver_diagnostics_transport=httpx2.MockTransport(
                diagnostics_response
            ),
        )
    ) as client:
        first_response = client.get("/api/rendering/diagnostics")
        second_response = client.get("/api/rendering/diagnostics")

    assert first_response.status_code == 200
    assert first_response.headers["cache-control"] == "no-store"
    response_document = first_response.json()
    assert response_document["state"] == "ready"
    assert response_document["observedAt"].endswith("Z")
    assert response_document["metrics"] == {
        "heap": {
            "usedBytes": 268_435_456,
            "committedBytes": 536_870_912,
            "maxBytes": 1_073_741_824,
            "usedPercent": 25.0,
        },
        "cpu": {"processLoadPercent": 12.5},
        "garbageCollection": {"count": 42, "seconds": 0.361},
        "threads": {"live": 42},
        "uptimeSeconds": 3600.5,
        "requests": {
            "activeGetMap": 0,
            "concurrencyLimit": 2,
            "completedGetMap": 0,
            "latestGetMapSeconds": None,
            "recentGetMapFailures": 0,
            "recentWindowSize": 0,
        },
    }
    assert second_response.json() == response_document
    assert len(requests) == 2


@pytest.mark.parametrize(
    ("metrics_document", "expected_state"),
    (
        (
            VALID_GEOSERVER_METRICS.replace(
                "eolab_jvm_process_cpu_load_ratio 0.125",
                "eolab_jvm_process_cpu_load_ratio 0.9",
            ),
            "busy",
        ),
        (
            VALID_GEOSERVER_METRICS.replace(
                "eolab_jvm_heap_used_bytes 268435456",
                "eolab_jvm_heap_used_bytes 1020054733",
            ).replace(
                "eolab_jvm_heap_committed_bytes 536870912",
                "eolab_jvm_heap_committed_bytes 1073741824",
            ),
            "degraded",
        ),
    ),
    ids=("high-cpu", "high-heap"),
)
def test_rendering_diagnostics_classifies_resource_pressure(
    configured_environment: None,
    expected_state: str,
    metrics_document: str,
    version_file_path: Path,
) -> None:
    """Distinguish a responsive but busy or degraded renderer from downtime."""

    def diagnostics_response(request: httpx2.Request) -> httpx2.Response:
        if request.url.port == 9404:
            return httpx2.Response(
                200,
                text=metrics_document,
                headers={"content-type": "text/plain"},
            )
        return httpx2.Response(200, text="<WMS_Capabilities/>")

    with TestClient(
        create_app(
            version_file_path,
            geoserver_diagnostics_transport=httpx2.MockTransport(
                diagnostics_response
            ),
        )
    ) as client:
        response = client.get("/api/rendering/diagnostics")

    assert response.status_code == 200
    assert response.json()["state"] == expected_state
    assert response.json()["metrics"] is not None


@pytest.mark.parametrize("failure_kind", ("unavailable", "malformed", "oversized"))
def test_rendering_diagnostics_failure_is_stable_and_does_not_change_health(
    configured_environment: None,
    failure_kind: str,
    version_file_path: Path,
) -> None:
    """Hide upstream errors and keep application liveness independent."""
    secret = "internal-secret-path-and-password"

    def diagnostics_response(request: httpx2.Request) -> httpx2.Response:
        if request.url.path == "/geoserver/eolab/wms":
            return httpx2.Response(
                200,
                text="<WMS_Capabilities/>",
                headers={"content-type": "application/xml"},
            )
        if failure_kind == "unavailable":
            raise httpx2.ConnectError(secret, request=request)
        if failure_kind == "malformed":
            return httpx2.Response(
                200,
                text=f"eolab_jvm_heap_used_bytes {secret}",
                headers={"content-type": "text/plain"},
            )
        return httpx2.Response(
            200,
            content=b"x" * 65_537,
            headers={"content-type": "text/plain"},
        )

    with TestClient(
        create_app(
            version_file_path,
            geoserver_diagnostics_transport=httpx2.MockTransport(
                diagnostics_response
            ),
        )
    ) as client:
        diagnostics_response_value = client.get("/api/rendering/diagnostics")
        health_response = client.get("/healthz")

    assert diagnostics_response_value.status_code == 200
    assert diagnostics_response_value.json()["state"] == "unavailable"
    assert diagnostics_response_value.json()["metrics"] is None
    assert secret not in diagnostics_response_value.text
    assert health_response.status_code == 200
