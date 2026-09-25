"""Request validation and browser ownership tests for annotation-session routes."""

from typing import Any
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from eolab_app.annotation_sessions.models import ShareLayer
from eolab_app.annotation_sessions.colors import (
    DEFAULT_CONTRIBUTOR_COLORS,
    choose_contributor_color,
    get_contributor_color,
)
from eolab_app.routes.annotation_sessions import (
    COOKIE,
    create_annotation_sessions_router,
)
from eolab_app.settings import load_settings


@pytest.mark.parametrize(
    "variable,attribute,default",
    [
        ("SHARED_LAYER_CAPACITY", "shared_layer_capacity", 10000),
        ("SHARED_LAYER_CREATION_LIMIT", "shared_layer_creation_limit", 100),
        (
            "SHARED_LAYER_CREATION_WINDOW_SECONDS",
            "shared_layer_creation_window_seconds",
            60,
        ),
    ],
)
def test_shared_layer_limits_are_configurable_positive_integers(
    configured_environment: None,
    version_file_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    variable: str,
    attribute: str,
    default: int,
) -> None:
    """Accept runtime limits and reject values that cannot define a positive budget.

    Args:
        configured_environment: Required app environment.
        version_file_path: Disposable version file.
        monkeypatch: Isolated environment changes.
        variable: Runtime environment variable being checked.
        attribute: Matching Settings field.
        default: Expected value when the variable is absent.
    """
    monkeypatch.delenv(variable, raising=False)
    assert getattr(load_settings(version_file_path), attribute) == default
    monkeypatch.setenv(variable, "250")
    assert getattr(load_settings(version_file_path), attribute) == 250
    for invalid in ("0", "-1", "1.5", "", "unlimited"):
        monkeypatch.setenv(variable, invalid)
        with pytest.raises(ValueError):
            load_settings(version_file_path)


def test_app_passes_shared_layer_settings_to_store(
    configured_environment: None,
    version_file_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Connect deployment overrides to the shared-layer store used by the API.

    Args:
        configured_environment: Required app environment.
        version_file_path: Disposable version file.
        monkeypatch: Capture the composed store without opening PostgreSQL.
    """
    from eolab_app.annotation_sessions.store import AnnotationSessionStore
    from eolab_app.main import create_app

    stores: list[AnnotationSessionStore] = []

    def capture_store(**kwargs: int) -> AnnotationSessionStore:
        """Retain the real store constructed by application composition.

        Args:
            kwargs: Configured capacity and rate limits.

        Returns:
            Unconnected shared-layer store.
        """
        store = AnnotationSessionStore(**kwargs)
        stores.append(store)
        return store

    monkeypatch.setenv("SHARED_LAYER_CAPACITY", "50000")
    monkeypatch.setenv("SHARED_LAYER_CREATION_LIMIT", "300")
    monkeypatch.setenv("SHARED_LAYER_CREATION_WINDOW_SECONDS", "30")
    monkeypatch.setattr("eolab_app.main.AnnotationSessionStore", capture_store)
    create_app(version_file_path)
    assert len(stores) == 1
    assert stores[0].layer_capacity == 50000
    assert stores[0].creation_limit == 300
    assert stores[0].creation_window_seconds == 30


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


def test_contributor_palette_and_stable_older_membership_colors() -> None:
    """Use all supplied colors before repeating; custom colors and old fallbacks persist."""
    from uuid import UUID

    used = []
    for expected in DEFAULT_CONTRIBUTOR_COLORS:
        chosen = choose_contributor_color(used)
        assert chosen == expected
        used.append(chosen.lower())
    assert len(set(used)) == 25
    assert choose_contributor_color(used) == DEFAULT_CONTRIBUTOR_COLORS[0]
    used.append(DEFAULT_CONTRIBUTOR_COLORS[0])
    assert choose_contributor_color(used) == DEFAULT_CONTRIBUTOR_COLORS[1]
    identifier = UUID("00000000-0000-0000-0000-000000000007")
    assert get_contributor_color(identifier, None) == "#7CB518"
    assert get_contributor_color(identifier, "#123456") == "#123456"


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

        def initialize_and_clean_join_attempts(self) -> None:
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
