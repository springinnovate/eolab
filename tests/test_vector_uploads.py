"""Exercise private GeoPackage admission and ownership through the real upload API."""

import asyncio
from collections.abc import AsyncIterator
import hashlib
from io import FileIO
from pathlib import Path
from threading import Event
from typing import Any, IO
from uuid import UUID

import fiona
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from starlette.requests import ClientDisconnect

from eolab_app.routes.annotation_sessions import create_annotation_sessions_router
from eolab_app.routes.browser_identity import COOKIE
from eolab_app.routes.vector_uploads import create_vector_uploads_router
from eolab_app.settings import load_settings
from eolab_app.vector_uploads import VectorUploadStore

BASE = "/api/vector-uploads"
HEADERS = {"X-EOLab-Uploads": "1"}


def write_layer(
    path: Path,
    geometry: str = "Polygon",
    crs: str | None = "EPSG:3857",
    layer: str = "areas",
) -> bytes:
    """Create a real GeoPackage layer with attributes and a polygon hole.

    Args:
        path: Disposable GeoPackage to create or extend.
        geometry: Native geometry type to write.
        crs: CRS for admission, or None to exercise missing metadata.
        layer: Exact native layer name.

    Returns:
        Original file bytes after the writer closes.
    """
    rings = [
        [(0, 0), (1000, 0), (1000, 1000), (0, 1000), (0, 0)],
        [(200, 200), (200, 400), (400, 400), (400, 200), (200, 200)],
    ]
    coordinates = rings
    if geometry == "MultiPolygon":
        coordinates = [
            rings,
            [[(3000, 0), (4000, 0), (4000, 1000), (3000, 1000), (3000, 0)]],
        ]
    if geometry == "Point":
        coordinates = (100, 200)
    with fiona.open(
        path,
        "w",
        driver="GPKG",
        layer=layer,
        crs=crs,
        schema={
            "geometry": geometry,
            "properties": {"label": "str", "count": "int", "weight": "float"},
        },
    ) as dataset:
        dataset.write(
            {
                "geometry": {"type": geometry, "coordinates": coordinates},
                "properties": {"label": "Café wetlands", "count": 7, "weight": 2.5},
            }
        )
    return path.read_bytes()


def client_for(store: VectorUploadStore) -> TestClient:
    """Mount the real upload router without unrelated application services.

    Args:
        store: Real upload storage rooted in the test directory.

    Returns:
        HTTPS client whose context starts and stops the router lifespan.
    """
    app = FastAPI()
    app.include_router(create_vector_uploads_router(store))
    return TestClient(app, base_url="https://testserver")


@pytest.mark.parametrize("geometry", ["Polygon", "MultiPolygon"])
def test_preserves_original_file_and_reopens_after_startup_cleanup(
    tmp_path: Path,
    geometry: str,
) -> None:
    """Preserve an uncapped upload's fields, geometry, CRS and bytes across restart.

    Args:
        tmp_path: Isolated upload volume and input fixture.
        geometry: Supported polygon geometry variant.
    """
    source = tmp_path / "original.gpkg"
    body = write_layer(source, geometry)
    store = VectorUploadStore(tmp_path / "uploads", None)
    with client_for(store) as client:
        response = client.post(
            BASE,
            params={"name": "../Private wetlands.gpkg"},
            headers=HEADERS,
            content=body,
        )
        assert response.status_code == 201, response.text
        record = response.json()
        UUID(record["id"])
        assert record["name"] == "../Private wetlands.gpkg"
        assert record["geometry_type"] == geometry
        assert record["layer_name"] == "areas"
        assert set(record["fields"]) == {"label", "count", "weight"}
        assert fiona.crs.CRS.from_wkt(record["crs_wkt"]).to_epsg() == 3857
        assert record["size_bytes"] == len(body)
        assert response.headers["Cache-Control"] == "private, no-store"
        token = client.cookies[COOKIE]
        owner = hashlib.sha256(token.encode()).hexdigest()
        directory = store.root / owner / record["id"]
        stored = directory / "source.gpkg"
        assert stored.read_bytes() == body
        with fiona.open(stored) as dataset, fiona.open(source) as original:
            actual, expected = next(iter(dataset)), next(iter(original))
            assert actual.geometry == expected.geometry
            assert dict(actual.properties) == dict(expected.properties)
        assert client.get(BASE).json() == [record]
        assert str(tmp_path) not in response.text and owner not in response.text
    for name in (".pending-interrupted", ".deleting-interrupted"):
        abandoned = store.root / owner / name
        abandoned.mkdir()
        (abandoned / "partial").write_bytes(b"unfinished")
    with client_for(VectorUploadStore(store.root, None)) as reopened:
        reopened.cookies.set(COOKIE, token)
        assert reopened.get(BASE).json() == [record]
        assert stored.read_bytes() == body
        assert sorted(path.name for path in directory.parent.iterdir()) == [
            record["id"]
        ]
        assert (
            reopened.delete(f"{BASE}/{record['id']}", headers=HEADERS).status_code
            == 204
        )
        assert not directory.exists()
        assert reopened.get(BASE).json() == []


def test_annotation_identity_is_reused_and_uploads_remain_private(
    tmp_path: Path,
) -> None:
    """Reuse the existing cookie while keeping other browsers outside ownership.

    Args:
        tmp_path: Isolated GeoPackage and upload directory.
    """

    class Memberships:
        """Capture the identity delivered to the existing annotation route."""

        owner: str | None = None

        def initialize_and_clean_join_attempts(self) -> None:
            """Leave this database-free membership fixture ready for requests."""

        def list_sessions(self, browser: str) -> list[dict[str, Any]]:
            """Capture a browser hash and return its empty memberships.

            Args:
                browser: Identity supplied by the real annotation dependency.

            Returns:
                No memberships; upload admission does not require joining one.
            """
            self.owner = browser
            return []

    body = write_layer(tmp_path / "source.gpkg")
    store = VectorUploadStore(tmp_path / "uploads", len(body))
    app, memberships = FastAPI(), Memberships()
    app.include_router(create_annotation_sessions_router(memberships))
    app.include_router(create_vector_uploads_router(store))
    with (
        TestClient(app, base_url="https://testserver") as owner,
        client_for(store) as other,
    ):
        assert owner.get("/api/annotation-sessions").status_code == 200
        cookie = owner.cookies[COOKIE]
        response = owner.post(
            BASE, params={"name": "Private"}, headers=HEADERS, content=body
        )
        assert response.status_code == 201, response.text
        identifier = response.json()["id"]
        assert owner.cookies[COOKIE] == cookie
        assert store.list_uploads(memberships.owner)[0].id == UUID(identifier)
        assert other.get(BASE).json() == []
        denied = other.delete(f"{BASE}/{identifier}", headers=HEADERS)
        assert denied.status_code == 404
        assert denied.headers["Cache-Control"] == "private, no-store"
        assert len(owner.get(BASE).json()) == 1
        assert owner.delete(f"{BASE}/{identifier}").status_code == 403
        assert owner.delete(f"{BASE}/{identifier}", headers=HEADERS).status_code == 204


@pytest.mark.parametrize("case", ["not-gpkg", "multiple", "point", "missing-crs"])
def test_rejected_native_inputs_leave_no_files(tmp_path: Path, case: str) -> None:
    """Reject unsupported native metadata before making an upload available.

    Args:
        tmp_path: Isolated source and upload directory.
        case: Unsupported file or layer metadata to exercise.
    """
    source = tmp_path / "source.gpkg"
    body = b'{"type":"FeatureCollection","features":[]}'
    if case != "not-gpkg":
        body = write_layer(
            source,
            "Point" if case == "point" else "Polygon",
            None if case == "missing-crs" else "EPSG:3857",
        )
    if case == "multiple":
        body = write_layer(source, layer="second")
    store = VectorUploadStore(tmp_path / "uploads", 2 * 1024 * 1024)
    with client_for(store) as client:
        response = client.post(
            BASE, params={"name": "Bad input"}, headers=HEADERS, content=body
        )
        assert response.status_code == 422, response.text
        assert response.headers["Cache-Control"] == "private, no-store"
        assert str(tmp_path) not in response.text
        assert client.get(BASE).json() == []
        assert not any(path.is_file() for path in store.root.rglob("*"))


def test_http_boundaries_and_streamed_byte_limit(tmp_path: Path) -> None:
    """Reject invalid request identities, names, origins and oversized streams.

    Args:
        tmp_path: Isolated upload directory.
    """
    store = VectorUploadStore(tmp_path / "uploads", 8)
    with client_for(store) as client:
        for headers in (
            {},
            {**HEADERS, "Origin": "https://other.example"},
            {**HEADERS, "Sec-Fetch-Site": "cross-site"},
        ):
            assert (
                client.post(
                    BASE, params={"name": "Private"}, headers=headers, content=b"x"
                ).status_code
                == 403
            )
        for name in ("", " ", "x" * 201):
            assert (
                client.post(
                    BASE, params={"name": name}, headers=HEADERS, content=b"x"
                ).status_code
                == 422
            )
        assert client.delete(f"{BASE}/not-a-uuid", headers=HEADERS).status_code == 422
        assert client.delete(f"{BASE}/..%5Coutside", headers=HEADERS).status_code == 422
        response = client.post(
            BASE,
            params={"name": "Stream"},
            headers=HEADERS,
            content=iter([b"1234", b"5678", b"9"]),
        )
        assert response.status_code == 413
        assert "8 bytes" in response.json()["detail"]
        assert client.get(BASE).json() == []
        assert not any(path.is_file() for path in store.root.rglob("*"))


@pytest.mark.parametrize("cancel", [False, True])
def test_interrupted_body_cleans_staging(tmp_path: Path, cancel: bool) -> None:
    """Remove partial files after a disconnected or cancelled upload.

    Args:
        tmp_path: Isolated upload directory.
        cancel: Cancel the task externally instead of disconnecting its body.
    """
    store = VectorUploadStore(tmp_path / "uploads", 100)
    store.initialize()

    async def exercise() -> None:
        """Interrupt streaming after the first disk write has completed."""
        started = asyncio.Event()

        async def chunks() -> AsyncIterator[bytes]:
            """Yield partial data, then wait for cancellation or disconnect.

            Yields:
                A body fragment written before the connection is interrupted.

            Raises:
                ClientDisconnect: When exercising a disconnected request body.
            """
            yield b"partial"
            started.set()
            if not cancel:
                raise ClientDisconnect()
            await asyncio.Event().wait()

        task = asyncio.create_task(store.create("a" * 64, "Interrupted", chunks()))
        await started.wait()
        if cancel:
            task.cancel()
        with pytest.raises(asyncio.CancelledError if cancel else ClientDisconnect):
            await task

    asyncio.run(exercise())
    assert list((store.root / ("a" * 64)).iterdir()) == []


def test_repeated_cancellation_waits_for_file_write(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep the upload file open until its active write finishes despite cancellation.

    Args:
        tmp_path: Isolated upload directory.
        monkeypatch: Gate only the actual staging file's write.
    """
    entered, release = Event(), Event()
    original_open = Path.open

    class GatedFile(FileIO):
        """Pause a real disk write until the upload has been cancelled twice."""

        def write(self, data: bytes) -> int:
            """Wait before writing the supplied body fragment.

            Args:
                data: Upload bytes supplied by the real store.

            Returns:
                Number of bytes written to the still-open staging file.

            Raises:
                TimeoutError: If the test does not release the write.
            """
            entered.set()
            if not release.wait(5):
                raise TimeoutError("Upload write was not released")
            return super().write(data)

    def open_upload(path: Path, mode: str = "r", **kwargs: Any) -> IO[Any]:
        """Gate the staging writer while leaving other filesystem reads unchanged.

        Args:
            path: File being opened by upload storage.
            mode: Requested file mode.
            kwargs: Text options for unrelated metadata reads and writes.

        Returns:
            A real file whose write can be paused, or the ordinary file handle.
        """
        if path.name == "source.gpkg" and mode == "wb":
            return GatedFile(path, mode)
        return original_open(path, mode, **kwargs)

    async def chunks() -> AsyncIterator[bytes]:
        """Yield a body fragment for the pending disk write.

        Yields:
            Bytes whose write is held until both cancellations are delivered.
        """
        yield b"partial"

    async def exercise() -> None:
        """Cancel twice, then release the real write and wait for cleanup."""
        store = VectorUploadStore(tmp_path / "uploads", 100)
        task = asyncio.create_task(store.create("a" * 64, "Interrupted", chunks()))
        try:
            assert await asyncio.to_thread(entered.wait, 5)
            for _ in range(2):
                task.cancel()
                await asyncio.sleep(0)
            assert not task.done()
            assert list(store.root.rglob("source.gpkg"))
        finally:
            release.set()
            await asyncio.gather(task, return_exceptions=True)
        assert task.cancelled()
        assert list((store.root / ("a" * 64)).iterdir()) == []

    monkeypatch.setattr(Path, "open", open_upload)
    asyncio.run(exercise())


def test_upload_settings_and_application_wiring(
    configured_environment: None,
    version_file_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Accept an optional deployment limit and pass it to the composed store.

    Args:
        configured_environment: Required application environment.
        version_file_path: Disposable application version file.
        monkeypatch: Isolated deployment values and construction capture.
        tmp_path: Absolute configured upload directory.
    """
    from eolab_app.main import create_app

    monkeypatch.delenv("VECTOR_UPLOAD_MAX_BYTES", raising=False)
    assert load_settings(version_file_path).vector_upload_max_bytes is None
    monkeypatch.setenv("VECTOR_UPLOAD_MAX_BYTES", "")
    assert load_settings(version_file_path).vector_upload_max_bytes is None
    for value in ("0", "-1", "1.5", "invalid"):
        monkeypatch.setenv("VECTOR_UPLOAD_MAX_BYTES", value)
        with pytest.raises(ValueError):
            load_settings(version_file_path)
    monkeypatch.setenv("VECTOR_UPLOAD_MAX_BYTES", "12345")
    monkeypatch.setenv("VECTOR_UPLOAD_DATA_PATH", "relative/uploads")
    with pytest.raises(ValueError, match="absolute path"):
        load_settings(version_file_path)
    monkeypatch.setenv("VECTOR_UPLOAD_DATA_PATH", str(tmp_path))
    stores: list[VectorUploadStore] = []

    def capture(root: Path, max_bytes: int | None) -> VectorUploadStore:
        """Capture the configured store without changing its behavior.

        Args:
            root: Configured upload volume path.
            max_bytes: Configured maximum file size, or None for no size cap.

        Returns:
            The real store used by upload routes.
        """
        store = VectorUploadStore(root, max_bytes)
        stores.append(store)
        return store

    monkeypatch.setattr("eolab_app.main.VectorUploadStore", capture)
    create_app(version_file_path)
    assert len(stores) == 1
    assert stores[0].root == tmp_path
    assert stores[0].max_bytes == 12345
    monkeypatch.setenv("VECTOR_UPLOAD_MAX_BYTES", "")
    create_app(version_file_path)
    assert stores[1].max_bytes is None
