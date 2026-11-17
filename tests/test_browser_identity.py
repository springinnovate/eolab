"""Keep real uploads and shared contributions accessible after delayed startup reads."""

import asyncio
import hashlib
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx2
import pytest

import eolab_app.main as application_module
from eolab_app.routes.browser_identity import COOKIE
from eolab_app.routes.system import create_system_router
from eolab_app.routes.uploads import create_uploads_router
from eolab_app.routes.vector_uploads import create_vector_uploads_router
from eolab_app.vector_uploads import VectorUploadStore
from test_vector_uploads import write_layer


class DelayedUploadResponse(httpx2.AsyncBaseTransport):
    """Hold one real upload-summary response before the client's cookie jar sees it."""

    def __init__(self, app: FastAPI) -> None:
        """Prepare the real ASGI transport and explicit response-ordering events.

        Args:
            app: Application with production HTTP routes and storage.
        """
        self.transport = httpx2.ASGITransport(app=app)
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        """Run each route normally, delaying only the first completed usage read.

        Args:
            request: Real request including the client's current Cookie header.

        Returns:
            Original route response, including its unmodified Set-Cookie header.

        Raises:
            TimeoutError: If the test fails to release its delayed response.
        """
        response = await self.transport.handle_async_request(request)
        if request.url.path == "/api/uploads" and not self.started.is_set():
            self.started.set()
            await asyncio.wait_for(self.release.wait(), timeout=10)
        return response


def test_application_entries_preserve_identity_after_cross_site_navigation(
    configured_environment: None,
    version_file_path: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep an existing Strict cookie when cross-site document requests omit it.

    Args:
        configured_environment: Required application configuration.
        version_file_path: Baked application version fixture.
        tmp_path: Disposable built-HTML stand-in.
        monkeypatch: Select the static directory and editor administrator password.
    """
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<html>Application</html>", encoding="utf-8")
    monkeypatch.setattr(application_module, "__file__", str(tmp_path / "main.py"))
    monkeypatch.setenv("ADMIN_PASSWORD", "test-admin-password-1328")
    app = application_module.create_app(version_file_path)
    client = TestClient(app, base_url="https://testserver")
    assert client.get("/api/config").status_code == 200
    token = client.cookies[COOKIE]
    for path in (
        "/",
        "/index.html",
        "/maps/wetlands",
        "/admin-eolab/maps/wetlands/edit",
    ):
        # Model SameSite=Strict withholding the cookie only on the navigation.
        page = client.get(
            path,
            headers={"Cookie": "", "Sec-Fetch-Site": "cross-site"},
            auth=("admin", "test-admin-password-1328"),
        )
        assert page.status_code == 200
        assert "set-cookie" not in page.headers
        response = client.get("/api/config", headers={"Sec-Fetch-Site": "same-origin"})
        assert response.status_code == 200
        assert response.headers["cache-control"] == "private, no-store"
        assert client.cookies[COOKIE] == token


@pytest.mark.parametrize("cookie", [None, "a" * 64, "invalid"])
def test_configuration_establishes_private_uncached_identity(
    cookie: str | None,
) -> None:
    """Set or reuse the ownership cookie without exposing it in public configuration.

    Args:
        cookie: Absent, valid, or malformed incoming ownership token.
    """
    app = FastAPI()
    app.include_router(create_system_router("test", {"appTitle": "Test"}))
    client = TestClient(app, base_url="https://testserver")
    if cookie is not None:
        client.cookies.set(COOKIE, cookie, domain="testserver.local", path="/")
    response = client.get("/api/config")
    token = client.cookies[COOKIE]
    assert len(token) == 64
    if cookie == "a" * 64:
        assert token == cookie
    else:
        assert token != cookie
    assert response.json() == {"appTitle": "Test"}
    assert response.headers["cache-control"] == "private, no-store"
    header = response.headers["set-cookie"]
    for attribute in (
        "HttpOnly",
        "Secure",
        "SameSite=strict",
        "Path=/",
        "Max-Age=31536000",
    ):
        assert attribute in header
    assert "Domain=" not in header
    assert "set-cookie" not in client.get("/healthz").headers
    assert client.get("/api/config").status_code == 200
    assert client.cookies[COOKIE] == token


@pytest.mark.parametrize("existing_cookie", [False, True])
@pytest.mark.parametrize("sequential", [False, True])
def test_delayed_usage_keeps_uploaded_file_accessible(
    tmp_path: Path, existing_cookie: bool, sequential: bool
) -> None:
    """Retain exact file ownership when an earlier usage response arrives last.

    Args:
        tmp_path: Disposable real GeoPackage and upload storage directory.
        existing_cookie: Reuse a browser identity from an earlier visit.
        sequential: Complete startup usage before admission as a control.
    """
    original = write_layer(tmp_path / "wetlands.gpkg")
    uploads = VectorUploadStore(tmp_path / "uploads", None)
    uploads.initialize()
    app = FastAPI()
    app.include_router(create_system_router("test", {}))
    app.include_router(create_uploads_router(uploads.storage))
    app.include_router(create_vector_uploads_router(uploads))

    async def exercise() -> None:
        """Bootstrap one real cookie jar, reorder responses, then read and delete."""
        transport = DelayedUploadResponse(app)
        async with httpx2.AsyncClient(
            transport=transport, base_url="https://testserver"
        ) as client:
            if existing_cookie:
                assert (await client.get("/api/vector-uploads")).status_code == 200
                existing = client.cookies[COOKIE]
            assert (await client.get("/api/config")).status_code == 200
            token = client.cookies[COOKIE]
            if existing_cookie:
                assert token == existing
            pending = asyncio.create_task(client.get("/api/uploads"))
            try:
                await asyncio.wait_for(transport.started.wait(), timeout=5)
                if sequential:
                    transport.release.set()
                    assert (await pending).status_code == 200
                created = await client.post(
                    "/api/vector-uploads?name=Wetlands",
                    headers={"X-EOLab-Uploads": "1"},
                    content=original,
                )
                assert created.status_code == 201, created.text
                record = created.json()
                url = f"/api/vector-uploads/{record['id']}"
                assert (await client.get(url)).json() == record
                transport.release.set()
                assert (await pending).status_code == 200
                assert client.cookies[COOKIE] == token
                assert (await client.get(url)).json() == record
                summary = (await client.get("/api/uploads")).json()
                assert [item["id"] for item in summary["uploads"]] == [record["id"]]
                owner = hashlib.sha256(token.encode()).hexdigest()
                stored = uploads.root / owner / record["id"] / "source.gpkg"
                assert stored.read_bytes() == original
                async with httpx2.AsyncClient(
                    transport=httpx2.ASGITransport(app=app),
                    base_url="https://testserver",
                ) as foreign:
                    await foreign.get("/api/config")
                    assert (await foreign.get(url)).status_code == 404
                    assert (await foreign.get("/api/uploads")).json()["uploads"] == []
                    assert (
                        await foreign.delete(url, headers={"X-EOLab-Uploads": "1"})
                    ).status_code == 404
                assert (
                    await client.delete(url, headers={"X-EOLab-Uploads": "1"})
                ).status_code == 204
                assert not stored.exists()
            finally:
                transport.release.set()
                await pending

    asyncio.run(exercise())
