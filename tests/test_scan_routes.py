"""Test scan HTTP error translation independently of the pipeline."""

from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from eolab_app.routes.scans import create_scan_router


class RecordingScanController:
    """Provide deterministic scan route responses."""

    def __init__(self, start_error: RuntimeError | None = None) -> None:
        """Configure an optional already-running failure.

        Args:
            start_error: Error raised by ``start`` when supplied.
        """
        self.start_error = start_error

    def status(self) -> dict[str, Any]:
        """Return a minimal current status.

        Returns:
            Stable status fixture.
        """
        return {"state": "not_started"}

    async def start(self) -> dict[str, Any]:
        """Return initial progress or raise the configured conflict.

        Returns:
            Stable accepted status.

        Raises:
            RuntimeError: Configured already-running failure.
        """
        if self.start_error is not None:
            raise self.start_error
        return {"state": "discovering"}


def build_test_client(controller: RecordingScanController) -> TestClient:
    """Create a minimal application containing only scan routes.

    Args:
        controller: Scan application fake.

    Returns:
        Synchronous route test client.
    """
    application = FastAPI()
    application.include_router(create_scan_router(controller))
    return TestClient(application)


def test_scan_routes_preserve_current_and_accepted_contracts() -> None:
    """Expose the established paths and POST status code."""
    client = build_test_client(RecordingScanController())

    assert client.get("/api/scans/current").json() == {"state": "not_started"}
    response = client.post("/api/scans")
    assert response.status_code == 202
    assert response.json() == {"state": "discovering"}


def test_scan_route_translates_active_scan_error_to_conflict() -> None:
    """Keep pipeline RuntimeError out of the HTTP boundary."""
    client = build_test_client(
        RecordingScanController(RuntimeError("A dataset scan is already running"))
    )

    response = client.post("/api/scans")

    assert response.status_code == 409
    assert response.json() == {"detail": "A dataset scan is already running"}
