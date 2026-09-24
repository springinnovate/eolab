"""Verify administration authentication, deployment settings and private responses."""

from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from eolab_app.annotation_sessions.store import AnnotationSessionStore
from eolab_app.annotation_sessions.models import SessionError
from eolab_app.main import create_app
from eolab_app.routes.shared_layer_admin import create_shared_layer_admin_router
from eolab_app.settings import load_settings

PASSWORD = "test-admin-password-519"
API = "/api/admin/shared-layers"


def test_admin_storage_failure_is_private(monkeypatch: pytest.MonkeyPatch) -> None:
    """An unavailable database returns a private, actionable error rather than a traceback.

    Args:
        monkeypatch: Replace only the store's public list operation.
    """
    store = AnnotationSessionStore()

    def unavailable() -> list[dict[str, object]]:
        """Represent a temporarily unavailable database.

        Raises:
            SessionError: Always, as a failed store operation would.
        """
        raise SessionError(503, "Shared layers are temporarily unavailable.")

    monkeypatch.setattr(store, "list_layers_for_administration", unavailable)
    app = FastAPI()
    app.include_router(create_shared_layer_admin_router(store, PASSWORD))
    response = TestClient(app).get(API, auth=("admin", PASSWORD))
    assert response.status_code == 503
    assert response.json() == {"detail": "Shared layers are temporarily unavailable."}
    assert response.headers["cache-control"] == "private, no-store"


@pytest.mark.parametrize("password,expected", [("", 404), (PASSWORD, 401)])
def test_admin_page_assets_and_api_require_admin(password: str, expected: int) -> None:
    """No contributor cookie or share code can access administration.

    Args:
        password: Disabled or configured administrator credential.
        expected: Status when no valid administrator credentials are supplied.
    """
    app = FastAPI()
    app.include_router(
        create_shared_layer_admin_router(AnnotationSessionStore(), password)
    )
    client = TestClient(app)
    paths = [
        ("GET", "/admin-eolab"),
        ("GET", "/admin-eolab/admin.js"),
        ("GET", "/admin-eolab/admin.css"),
        ("GET", API),
        ("DELETE", f"{API}/{uuid4()}"),
        ("POST", f"{API}/{uuid4()}/restore"),
    ]
    for method, path in paths:
        response = client.request(method, path, headers={"X-EOLab-Admin": "1"})
        assert response.status_code == expected
        assert response.headers["cache-control"] == "private, no-store"
    if password:
        for credentials in [("admin", "wrong"), ("contributor", PASSWORD)]:
            response = client.get("/admin-eolab", auth=credentials)
            assert response.status_code == 401
            assert "Basic" in response.headers["www-authenticate"]
        for path in ["/admin-eolab", "/admin-eolab/admin.js", "/admin-eolab/admin.css"]:
            response = client.get(path, auth=("admin", PASSWORD))
            assert response.status_code == 200
            assert PASSWORD not in response.text
            assert (
                "frame-ancestors 'none'" in response.headers["content-security-policy"]
            )


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"X-EOLab-Admin": "1", "Origin": "https://other.test"},
        {"X-EOLab-Admin": "1", "Sec-Fetch-Site": "cross-site"},
    ],
)
def test_admin_mutations_reject_cross_origin_requests(headers: dict[str, str]) -> None:
    """Cached Basic credentials cannot authorize a cross-site deletion or restoration.

    Args:
        headers: Missing custom header or explicit cross-origin request.
    """
    app = FastAPI()
    app.include_router(
        create_shared_layer_admin_router(AnnotationSessionStore(), PASSWORD)
    )
    client = TestClient(app)
    client.auth = ("admin", PASSWORD)
    assert client.delete(f"{API}/{uuid4()}", headers=headers).status_code == 403
    assert client.post(f"{API}/{uuid4()}/restore", headers=headers).status_code == 403


def test_admin_configuration_is_private_and_composed(
    configured_environment: None,
    version_file_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Wire optional administration into the app without publishing the password.

    Args:
        configured_environment: Valid application environment.
        version_file_path: Baked version fixture.
        monkeypatch: Isolate the administrator environment setting.
    """
    monkeypatch.delenv("ADMIN_PASSWORD", raising=False)
    assert load_settings(version_file_path).admin_password == ""
    assert (
        TestClient(create_app(version_file_path)).get("/admin-eolab").status_code == 404
    )
    monkeypatch.setenv("ADMIN_PASSWORD", PASSWORD)
    settings = load_settings(version_file_path)
    assert settings.admin_password == PASSWORD
    assert PASSWORD not in repr(settings)
    client = TestClient(create_app(version_file_path))
    assert client.get("/admin-eolab").status_code == 401
    assert client.get("/admin-eolab", auth=("admin", PASSWORD)).status_code == 200
    assert PASSWORD not in client.get("/api/config").text
    for invalid in ["short", " " * 20, "a" * 257, "x" * 20 + "\n", "é" * 20]:
        monkeypatch.setenv("ADMIN_PASSWORD", invalid)
        with pytest.raises(ValueError, match="ADMIN_PASSWORD"):
            load_settings(version_file_path)
