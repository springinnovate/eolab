"""Test scan HTTP error translation independently of the pipeline."""

from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from eolab_app.routes.scans import create_scan_router


class RecordingScanController:
    """Provide deterministic scan route responses."""

    def __init__(
        self,
        start_error: RuntimeError | None = None,
        cancel_error: RuntimeError | None = None,
    ) -> None:
        """Configure an optional already-running failure.

        Args:
            start_error: Error raised by ``start`` when supplied.
            cancel_error: Error raised by ``cancel`` when supplied.
        """
        self.start_error = start_error
        self.cancel_error = cancel_error

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

    async def cancel(self) -> dict[str, Any]:
        """Return cancelled progress or raise the configured conflict.

        Returns:
            Stable cancelled status.

        Raises:
            RuntimeError: Configured no-active-scan failure.
        """
        if self.cancel_error is not None:
            raise self.cancel_error
        return {"state": "cancelled"}


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


def test_scan_cancel_route_returns_terminal_status_and_conflict() -> None:
    """Expose cancellation while translating a missing active scan to 409."""
    successful_client = build_test_client(RecordingScanController())
    conflict_client = build_test_client(RecordingScanController(
        cancel_error=RuntimeError("No dataset scan is running")
    ))

    successful_response = successful_client.delete("/api/scans/current")
    conflict_response = conflict_client.delete("/api/scans/current")

    assert successful_response.status_code == 200
    assert successful_response.json() == {"state": "cancelled"}
    assert conflict_response.status_code == 409
    assert conflict_response.json() == {"detail": "No dataset scan is running"}
