"""Exercise published-map edit authorization and bounded HTTP inputs."""

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from eolab_app.main import create_app
from eolab_app.routes.saved_maps import create_saved_maps_admin_router
from eolab_app.saved_maps.models import MAX_REQUEST_BYTES
from eolab_app.saved_maps.store import SavedMapStore
from test_saved_maps import map_request

PASSWORD = "test-administrator-password-561"
BASE = "/api/admin/saved-maps"


@pytest.mark.parametrize("method,suffix", [("DELETE", ""), ("POST", "/restore")])
def test_map_deletion_requires_admin_and_same_origin(method: str, suffix: str) -> None:
    """Protect both reversible deletion endpoints before they reach storage.

    Args:
        method: Mutation HTTP method.
        suffix: Restore suffix, or empty for deletion.
    """
    app = FastAPI()
    app.include_router(create_saved_maps_admin_router(SavedMapStore(), PASSWORD))
    client = TestClient(app)
    url = BASE + "/amazon-priorities" + suffix
    assert client.request(method, url).status_code == 401
    assert client.request(method, url, auth=("admin", "wrong")).status_code == 401
    client.auth = ("admin", PASSWORD)
    for headers in (
        {},
        {"X-EOLab-Admin": "1", "Origin": "https://elsewhere.example"},
        {"X-EOLab-Admin": "1", "Sec-Fetch-Site": "cross-site"},
    ):
        assert client.request(method, url, headers=headers).status_code == 403
    disabled = FastAPI()
    disabled.include_router(create_saved_maps_admin_router(SavedMapStore(), ""))
    assert (
        TestClient(disabled).request(method, url, auth=("admin", PASSWORD)).status_code
        == 404
    )


def test_edit_api_requires_admin_and_rejects_invalid_writes() -> None:
    """Reject unauthorized, cross-origin, oversized and malformed updates before storage."""
    app = FastAPI()
    app.include_router(create_saved_maps_admin_router(SavedMapStore(), PASSWORD))
    client = TestClient(app)
    candidate = {**map_request(), "revision": 1}
    url = BASE + "/amazon-priorities"
    for path in (BASE, url):
        response = client.get(path)
        assert response.status_code == 401
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["www-authenticate"].startswith("Basic")
        assert client.get(path, auth=("contributor", PASSWORD)).status_code == 401
    assert client.put(url, json=candidate).status_code == 401
    client.auth = ("admin", PASSWORD)
    assert client.put(url, json=candidate).status_code == 403
    client.headers["X-EOLab-Admin"] = "1"
    assert (
        client.put(
            url, json=candidate, headers={"Origin": "https://elsewhere.example"}
        ).status_code
        == 403
    )
    assert (
        client.put(
            url, json=candidate, headers={"Sec-Fetch-Site": "cross-site"}
        ).status_code
        == 403
    )
    assert client.put(url, content=b"x" * (MAX_REQUEST_BYTES + 1)).status_code == 413
    assert client.put(url, content="{").status_code == 422
    for revision in (None, 0, True, "1"):
        assert (
            client.put(url, json={**candidate, "revision": revision}).status_code == 422
        )
    disabled = FastAPI()
    disabled.include_router(create_saved_maps_admin_router(SavedMapStore(), ""))
    assert TestClient(disabled).get(BASE, auth=("admin", PASSWORD)).status_code == 404


def test_edit_page_requires_admin(
    configured_environment: None,
    version_file_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Protect direct editor navigation and keep the ordinary published page public.

    Args:
        configured_environment: Required application settings.
        version_file_path: Disposable application version file.
        monkeypatch: Override the admin password and HTML response only.
    """
    monkeypatch.setenv("ADMIN_PASSWORD", PASSWORD)
    app = create_app(version_file_path)
    client = TestClient(app)
    assert client.get("/admin-eolab/maps/amazon/edit").status_code == 401
    # Exercise the real authenticated route without requiring built assets in this test.
    from starlette.responses import Response

    monkeypatch.setattr(
        "eolab_app.main.FileResponse",
        lambda *args, **kwargs: Response("editor", headers=kwargs.get("headers")),
    )
    response = client.get("/admin-eolab/maps/amazon/edit", auth=("admin", PASSWORD))
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert client.get("/maps/amazon").status_code == 200
