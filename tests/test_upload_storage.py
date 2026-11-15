"""Verify shared private upload budgets and original-file lifetime boundaries."""

import asyncio
from collections.abc import AsyncIterator
from datetime import datetime, timedelta, timezone
import hashlib
from io import FileIO
import json
from pathlib import Path
from typing import Any, IO
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from eolab_app.routes.browser_identity import COOKIE
from eolab_app.routes.uploads import create_uploads_router
from eolab_app.upload_storage import (
    UploadError,
    UploadKind,
    UploadRecord,
    UploadStorage,
)


async def body(content: bytes) -> AsyncIterator[bytes]:
    """Yield fixture original bytes through the real streaming boundary.

    Args:
        content: Small original accepted by the fixture's format adapter.

    Yields:
        One body fragment.
    """
    yield content


async def admit(
    storage: UploadStorage,
    owner: str,
    kind: UploadKind = "vector",
    content: bytes = b"original",
) -> UploadRecord:
    """Act as a format adapter after its input has passed admission inspection.

    Args:
        storage: Real shared file lifecycle and budget owner.
        owner: Browser identity hash.
        kind: Accepted format family, independent of the neutral file contents.
        content: Fixture bytes whose original identity and storage are tested.

    Returns:
        Published path-free upload metadata.
    """
    async with storage.stage(owner, kind, body(content)) as pending:
        metadata = UploadRecord(
            id=uuid4(),
            kind=kind,
            name=f"{kind} original",
            size_bytes=pending.size_bytes,
            created_at=datetime.now(timezone.utc),
        )
        storage.publish(pending, metadata)
        return metadata


def test_shared_slots_and_private_http_summary(tmp_path: Path) -> None:
    """Count mixed original formats once and isolate private browser summaries.

    Args:
        tmp_path: Disposable shared upload volume.
    """
    storage = UploadStorage(tmp_path)
    app = FastAPI()
    app.include_router(create_uploads_router(storage))
    with TestClient(app, base_url="https://testserver") as client:
        empty = client.get("/api/uploads")
        assert empty.headers["Cache-Control"] == "private, no-store"
        assert empty.headers["X-Content-Type-Options"] == "nosniff"
        owner = hashlib.sha256(client.cookies[COOKIE].encode()).hexdigest()
        for index in range(5):
            asyncio.run(admit(storage, owner, "raster" if index % 2 else "vector"))
        summary = client.get("/api/uploads").json()
        assert summary["used_files"] == summary["max_files"] == 5
        assert summary["retained_files"] == 0
        assert {record["kind"] for record in summary["uploads"]} == {"vector", "raster"}
        assert all(
            datetime.fromisoformat(record["expires_at"].replace("Z", "+00:00"))
            - datetime.fromisoformat(record["created_at"].replace("Z", "+00:00"))
            == timedelta(days=7)
            for record in summary["uploads"]
        )
        assert owner not in json.dumps(summary)
        assert str(tmp_path) not in json.dumps(summary)
        with pytest.raises(UploadError, match="5 uploaded files") as full:
            asyncio.run(admit(storage, owner, "raster"))
        assert full.value.status == 409
    with TestClient(app, base_url="https://testserver") as another:
        assert another.get("/api/uploads").json()["used_files"] == 0
    first = storage.summary(owner).uploads[0]
    storage.delete(owner, first.id)
    asyncio.run(admit(storage, owner, "raster"))
    assert storage.summary(owner).used_files == 5


def test_last_slot_and_busy_admission_do_not_read_a_second_body(tmp_path: Path) -> None:
    """Reject concurrent intake before consuming its body or exceeding five files.

    Args:
        tmp_path: Disposable shared upload volume.
    """
    storage = UploadStorage(tmp_path)
    owner = "a" * 64

    async def exercise() -> None:
        """Hold the fifth upload's body while a second format requests admission."""
        for _ in range(4):
            await admit(storage, owner)
        entered, release = asyncio.Event(), asyncio.Event()
        consumed = False

        async def slow_body() -> AsyncIterator[bytes]:
            """Yield a first fragment, then pause the unfinished body.

            Yields:
                The two fragments of the fifth original.
            """
            yield b"first"
            entered.set()
            await release.wait()
            yield b"last"

        async def unwanted_body() -> AsyncIterator[bytes]:
            """Record whether a rejected body's bytes were consumed.

            Yields:
                Bytes that must remain unread while intake is busy.
            """
            nonlocal consumed
            consumed = True
            yield b"unwanted"

        async def upload_fifth() -> None:
            """Publish the fifth original after its held stream finishes."""
            async with storage.stage(owner, "raster", slow_body()) as pending:
                storage.publish(
                    pending,
                    UploadRecord(
                        id=uuid4(),
                        kind="raster",
                        name="Fifth",
                        size_bytes=pending.size_bytes,
                        created_at=datetime.now(timezone.utc),
                    ),
                )

        task = asyncio.create_task(upload_fifth())
        await entered.wait()
        assert storage.summary(owner).used_files == 5
        assert storage.summary(owner).retained_files == 0
        with pytest.raises(UploadError) as busy:
            async with storage.stage(owner, "vector", unwanted_body()):
                pytest.fail("A second upload entered while the first was active")
        assert busy.value.status == 429
        assert not consumed
        release.set()
        await task
        assert storage.summary(owner).used_files == 5

    asyncio.run(exercise())


@pytest.mark.parametrize("budget", ["file", "owner", "global", "metadata"])
def test_byte_budgets_reject_and_remove_incoming_files(
    tmp_path: Path, budget: str
) -> None:
    """Enforce original, owner, global and prepared-metadata bytes before writes.

    Args:
        tmp_path: Disposable upload directory.
        budget: The budget made too small for this request.
    """
    storage = UploadStorage(
        tmp_path,
        max_bytes=4 if budget == "file" else 1000,
        owner_max_bytes=4 if budget == "owner" else 10000,
        global_max_bytes=4 if budget == "global" else 10000,
    )
    owner = "a" * 64

    async def exercise() -> None:
        """Attempt the request and inspect physical staging after rejection."""
        if budget != "metadata":
            await admit(storage, owner, content=b"12345")
            return
        async with storage.stage(owner, "vector", body(b"small")) as pending:
            storage.publish(
                pending,
                UploadRecord(
                    id=uuid4(),
                    name="Too much metadata",
                    size_bytes=5,
                    created_at=datetime.now(timezone.utc),
                ),
                {"values.json": b"x" * 10000},
            )

    with pytest.raises(UploadError):
        asyncio.run(exercise())
    assert storage.summary(owner).used_files == 0
    assert not any(path.is_file() for path in tmp_path.rglob("*"))


def test_global_budget_includes_other_owners_and_legacy_retained_files(
    tmp_path: Path,
) -> None:
    """Charge legacy unattributed retained originals globally until job cleanup.

    Args:
        tmp_path: Disposable volume containing an old retained original.
    """
    storage = UploadStorage(tmp_path)
    first_owner, second_owner = "a" * 64, "b" * 64
    asyncio.run(admit(storage, first_owner, content=b"first owner"))
    retained = tmp_path / ".retained"
    retained.mkdir()
    token = uuid4().hex
    (retained / f"{token}.gpkg").write_bytes(b"old retained bytes")
    storage.global_max_bytes = storage.summary(first_owner).used_bytes + len(
        b"old retained bytes"
    )
    with pytest.raises(UploadError) as full:
        asyncio.run(admit(storage, second_owner))
    assert full.value.status == 503
    assert storage.summary(second_owner).used_files == 0
    storage.remove_unretained_sources(set())
    storage.global_max_bytes += 1000
    asyncio.run(admit(storage, second_owner))


@pytest.mark.parametrize("kind", ["vector", "raster"])
def test_deleted_original_remains_charged_until_all_jobs_stop(
    tmp_path: Path, kind: UploadKind
) -> None:
    """Retain each original once across jobs, deletion and application restart.

    Args:
        tmp_path: Disposable shared volume.
        kind: Original file family sharing the neutral lifetime mechanism.
    """
    storage = UploadStorage(tmp_path)
    owner = "a" * 64
    record = asyncio.run(admit(storage, owner, kind))
    _, source = storage.get_upload_source(owner, record.id, kind)
    first, second = storage.retain_source(source), storage.retain_source(source)
    assert storage.summary(owner).used_files == 1
    assert storage.get_retained_source(first).samefile(source)
    assert storage.get_retained_source(second).samefile(source)
    assert (
        storage.summary(owner).used_bytes
        == sum(path.stat().st_size for path in tmp_path.rglob("*") if path.is_file())
        - 2 * record.size_bytes
    )
    storage.delete(owner, record.id)
    with pytest.raises(UploadError) as withdrawn:
        storage.get_upload_source(owner, record.id, kind)
    assert withdrawn.value.status == 404
    restarted = UploadStorage(tmp_path)
    restarted.initialize()
    summary = restarted.summary(owner)
    assert summary.uploads == []
    assert summary.used_files == summary.retained_files == 1
    restarted.remove_unretained_sources({second})
    assert restarted.summary(owner).used_files == 1
    assert restarted.get_retained_source(second).read_bytes() == b"original"
    restarted.remove_unretained_sources(set())
    assert restarted.summary(owner).used_files == 0
    assert restarted.summary(owner).used_bytes == 0


def test_expiry_withdraws_access_before_sweep_and_preserves_original_date(
    tmp_path: Path,
) -> None:
    """Trust existing admission records and expire without opening their datasets.

    Args:
        tmp_path: Disposable volume with an existing untyped GeoPackage record.
    """
    storage = UploadStorage(tmp_path)
    owner = "a" * 64
    record = asyncio.run(admit(storage, owner))
    _, source = storage.get_upload_source(owner, record.id, "vector")
    token = storage.retain_source(source)
    metadata_path = source.parent / "metadata.json"
    existing = json.loads(metadata_path.read_text())
    existing.pop("kind")
    existing["created_at"] = (
        datetime.now(timezone.utc) - timedelta(days=8)
    ).isoformat()
    metadata_path.write_text(json.dumps(existing))
    original = source.read_bytes()
    with pytest.raises(UploadError) as expired:
        storage.get_upload_source(owner, record.id, "vector")
    assert expired.value.status == 404
    assert not storage.is_available(record.id, "vector")
    assert source.read_bytes() == original
    storage.sweep_expired()
    assert not source.exists()
    assert (
        storage.summary(owner).used_files == storage.summary(owner).retained_files == 1
    )
    assert storage.get_retained_source(token).read_bytes() == original
    storage.remove_unretained_sources(set())
    assert storage.summary(owner).used_files == 0


def test_active_read_survives_delete_and_processing_reconciliation(
    tmp_path: Path,
) -> None:
    """Keep original bytes until the read context exits, independent of job tokens.

    Args:
        tmp_path: Disposable volume for one raster original.
    """
    storage = UploadStorage(tmp_path)
    owner = "a" * 64

    async def exercise() -> None:
        """Delete the visible original while its authorized read remains open."""
        record = await admit(storage, owner, "raster")
        async with storage.open_source(owner, record.id, "raster") as (
            metadata,
            source,
        ):
            assert metadata.id == record.id
            storage.delete(owner, record.id)
            storage.remove_unretained_sources(set())
            assert source.read_bytes() == b"original"
            assert storage.summary(owner).retained_files == 1
            with pytest.raises(UploadError):
                async with storage.open_source(owner, record.id, "raster"):
                    pytest.fail("Deletion must withdraw all new reads")
        assert storage.summary(owner).used_bytes == 0
        assert storage.summary(owner).used_files == 0

    asyncio.run(exercise())


def test_restart_cleans_abandoned_read_and_staging_but_keeps_job_input(
    tmp_path: Path,
) -> None:
    """Remove crashed API work while retained job originals keep quota ownership.

    Args:
        tmp_path: Disposable upload volume.
    """
    storage = UploadStorage(tmp_path)
    owner = "a" * 64
    record = asyncio.run(admit(storage, owner))
    _, source = storage.get_upload_source(owner, record.id, "vector")
    token = storage.retain_source(source)
    for directory in (
        tmp_path / ".reading",
        tmp_path / owner / ".pending-crash",
        tmp_path / owner / ".deleting-crash",
    ):
        directory.mkdir()
        (directory / "abandoned").write_bytes(b"partial")
    restarted = UploadStorage(tmp_path)
    restarted.initialize()
    assert not (tmp_path / ".reading").exists()
    assert not list((tmp_path / owner).glob(".*"))
    assert restarted.get_retained_source(token).samefile(source)
    assert restarted.is_available(record.id, "vector")
    assert not restarted.is_available(record.id, "raster")


def test_concurrent_reads_share_one_path_until_the_last_scope_exits(
    tmp_path: Path,
) -> None:
    """Keep a coalesced read's original path after its first requester cancels.

    Args:
        tmp_path: Disposable shared upload volume.
    """
    storage = UploadStorage(tmp_path)
    owner = "a" * 64

    async def exercise() -> None:
        """Delete an original and cancel its first reader while a second keeps reading."""
        record = await admit(storage, owner, "raster")
        first_entered = asyncio.Event()
        paths: list[Path] = []

        async def first_reader() -> None:
            """Hold the first authorized read until the requester is cancelled."""
            async with storage.open_source(owner, record.id, "raster") as (_, path):
                paths.append(path)
                first_entered.set()
                await asyncio.Event().wait()

        first = asyncio.create_task(first_reader())
        try:
            await first_entered.wait()
            initial_bytes = storage.summary(owner).used_bytes
            async with storage.open_source(owner, record.id, "raster") as (
                _,
                second_path,
            ):
                assert paths == [second_path]
                assert storage.summary(owner).used_bytes == initial_bytes
                storage.delete(owner, record.id)
                first.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await first
                assert paths[0].read_bytes() == b"original"
                assert second_path.read_bytes() == b"original"
                storage.remove_unretained_sources(set())
                assert storage.summary(owner).retained_files == 1
                assert storage.summary(owner).used_files == 1
                with pytest.raises(UploadError):
                    async with storage.open_source(owner, record.id, "raster"):
                        pytest.fail("A retained path must not authorize a new reader")
            assert not second_path.exists()
            assert storage.summary(owner).used_files == 0
            assert storage.summary(owner).used_bytes == 0
        finally:
            first.cancel()
            await asyncio.gather(first, return_exceptions=True)

    asyncio.run(exercise())


def test_retention_during_stream_updates_remaining_byte_budget(tmp_path: Path) -> None:
    """Account for concurrent retention metadata before accepting another chunk.

    Args:
        tmp_path: Disposable shared volume.
    """
    storage = UploadStorage(tmp_path)
    owner = "a" * 64

    async def exercise() -> None:
        """Interleave a retained input with a body already using its byte snapshot."""
        record = await admit(storage, owner)
        _, source = storage.get_upload_source(owner, record.id, "vector")
        token = None

        async def stream() -> AsyncIterator[bytes]:
            """Retain a prior original between two incoming data chunks.

            Yields:
                Two fragments, with no global room left for the second.
            """
            nonlocal token
            yield b"first"
            token = storage.retain_source(source)
            storage.global_max_bytes = storage.summary(owner).used_bytes
            yield b"last"

        with pytest.raises(UploadError) as full:
            async with storage.stage(owner, "raster", stream()):
                pytest.fail("The second chunk would exceed storage capacity")
        assert full.value.status == 503
        assert token is not None
        assert storage.get_retained_source(token).read_bytes() == b"original"
        assert storage.summary(owner).used_files == 1

    asyncio.run(exercise())


def test_short_disk_writes_preserve_every_original_byte(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Finish a raw short write before advancing the admitted original byte count.

    Args:
        tmp_path: Disposable upload volume.
        monkeypatch: Restrict each actual staging write to a few original bytes.
    """
    original_open = Path.open

    class ShortFile(FileIO):
        """Accept only three bytes during each actual raw write."""

        def write(self, content: bytes | memoryview) -> int:
            """Write a short fragment and report the actual accepted byte count.

            Args:
                content: Bytes remaining in the incoming original fragment.

            Returns:
                Actual bytes written to the file by this invocation.
            """
            return super().write(content[:3])

    def open_short(path: Path, mode: str = "r", **kwargs: Any) -> IO[Any]:
        """Use short writes only for the staging original, preserving metadata IO.

        Args:
            path: File being opened by storage.
            mode: Requested read or write mode.
            kwargs: Buffering and encoding options for ordinary file access.

        Returns:
            Short-writing original handle or the ordinary file object.
        """
        if path.name == "source.gpkg" and mode == "wb":
            return ShortFile(path, mode)
        return original_open(path, mode, **kwargs)

    monkeypatch.setattr(Path, "open", open_short)
    storage = UploadStorage(tmp_path)
    owner = "a" * 64
    content = b"An immutable original includes every final byte."
    record = asyncio.run(admit(storage, owner, content=content))
    _, source = storage.get_upload_source(owner, record.id, "vector")
    assert source.read_bytes() == content
    assert record.size_bytes == len(content)
