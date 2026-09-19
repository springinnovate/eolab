"""Request validation and browser ownership tests for annotation-session routes."""

from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from eolab_app.annotation_sessions.models import ShareLayer
from eolab_app.routes.annotation_sessions import (
    COOKIE,
    create_annotation_sessions_router,
)


def collection(name: str = "Priority areas") -> dict[str, Any]:
    """Build a small valid contribution for public-boundary tests.

    Args:
        name: Layer name.

    Returns:
        Polygon GeoJSON with its name and note.
    """
    return {
        "type": "FeatureCollection",
        "name": name,
        "features": [
            {
                "type": "Feature",
                "properties": {"name": "River", "note": "Restore riparian habitat"},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[0, 0], [2, 0], [1, 2], [0, 0]]],
                },
            }
        ],
    }


class IdentityStore:
    """Capture route identity without a database for cookie/CSRF tests."""

    def list_sessions(self, browser: str) -> list[Any]:
        """Remember the authenticated identity.

        Args:
            browser: One-way cookie hash.

        Returns:
            No existing memberships.
        """
        self.browser = browser
        return []


def test_cookie_and_same_origin_boundary() -> None:
    """Keep private credentials out of JSON and reject cross-site mutations."""
    store = IdentityStore()
    app = FastAPI()
    app.include_router(create_annotation_sessions_router(store))
    client = TestClient(app, base_url="https://testserver")
    response = client.get("/api/annotation-sessions")
    assert response.status_code == 200
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "Secure" in response.headers["set-cookie"]
    assert "SameSite=strict" in response.headers["set-cookie"]
    assert store.browser != client.cookies[COOKIE]
    first = store.browser
    client.get("/api/annotation-sessions")
    assert store.browser == first
    assert client.post("/api/annotation-sessions", json={}).status_code == 403
    assert (
        client.post(
            "/api/annotation-sessions",
            headers={"X-EOLab-Annotations": "1", "Origin": "https://other.example"},
            json={},
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/annotation-sessions", headers={"X-EOLab-Annotations": "1"}, json={}
        ).status_code
        == 422
    )
    assert response.headers["Cache-Control"] == "private, no-store"


@pytest.mark.parametrize(
    "geometry",
    [
        {"type": "Point", "coordinates": [0, 0]},
        {
            "type": "Polygon",
            "coordinates": [
                [[0, 0], [2, 0], [1, 2], [0, 0]],
                [[0, 0], [1, 0], [0, 1], [0, 0]],
            ],
        },
        {"type": "Polygon", "coordinates": [[[0, 0], [2, 0], [1, 2], [1, 1]]]},
        {"type": "Polygon", "coordinates": [[[0, 0], [2, 2], [0, 2], [2, 0], [0, 0]]]},
        {"type": "Polygon", "coordinates": [[[0, 0], [190, 0], [1, 2], [0, 0]]]},
    ],
)
def test_reject_unsupported_geometry(geometry: dict[str, Any]) -> None:
    """Reject invalid editor geometry before persistence.

    Args:
        geometry: Unsupported or invalid GeoJSON geometry.
    """
    document = collection()
    document["features"][0]["geometry"] = geometry
    with pytest.raises(ValueError):
        ShareLayer.model_validate({"revision": 0, "collection": document})


def test_bounded_http_body() -> None:
    """Reject an oversized upload even when the client omits Content-Length."""
    app = FastAPI()
    app.include_router(create_annotation_sessions_router(IdentityStore()))
    response = TestClient(app).put(
        "/api/annotation-sessions/00000000-0000-0000-0000-000000000000/layers/00000000-0000-0000-0000-000000000000",
        content=iter([b"x" * (1024 * 1024)] * 9),
        headers={"X-EOLab-Annotations": "1"},
    )
    assert response.status_code == 413


@pytest.mark.parametrize("unavailable", [False, True])
def test_session_maintenance_lifespan_does_not_gate_other_routes(
    unavailable: bool,
) -> None:
    """Initialize/clean session storage in the background and tolerate a database outage.

    Args:
        unavailable: Whether initialization reports a temporary storage outage.
    """
    from threading import Event
    from eolab_app.annotation_sessions.models import SessionError

    attempted = Event()

    class MaintenanceStore(IdentityStore):
        """Signal background maintenance without needing a live database."""

        def initialize_and_remove_expired_sessions(self) -> None:
            """Record the attempt and optionally simulate a database outage.

            Raises:
                SessionError: When testing temporary database unavailability.
            """
            attempted.set()
            if unavailable:
                raise SessionError(503, "Temporary outage")

    app = FastAPI()
    app.include_router(create_annotation_sessions_router(MaintenanceStore()))
    with TestClient(app, base_url="https://testserver") as client:
        assert attempted.wait(2)
        assert client.get("/api/annotation-sessions").status_code == 200
