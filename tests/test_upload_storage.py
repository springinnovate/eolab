"""Verify shared private upload budgets and original-file lifetime boundaries."""

import asyncio
from collections.abc import AsyncIterator
from datetime import datetime, timedelta, timezone
import hashlib
from io import FileIO
import json
from pathlib import Path
from threading import Event, Thread, get_ident
from typing import Any, IO
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from eolab_app.routes.browser_identity import COOKIE
from eolab_app.routes.uploads import create_uploads_router
from eolab_app.upload_storage import (
    StorageUsage,
    UploadError,
    UploadKind,
    UploadRecord,
    UploadStorage,
)


@pytest.mark.parametrize("entrypoint", ["stage", "read"])
@pytest.mark.parametrize("blocked_on", ["lock", "inventory"])
def test_acquisition_keeps_disk_waits_off_the_event_loop(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    entrypoint: str,
    blocked_on: str,
) -> None:
    """Keep asyncio scheduling responsive while storage acquisition is blocked.

    Args:
        tmp_path: Disposable shared upload volume.
        monkeypatch: Observe the real lock or delay the original inventory.
        entrypoint: Staging or active-read acquisition under test.
        blocked_on: Disk operation deliberately held until asyncio releases it.
    """
    storage = UploadStorage(tmp_path)
    owner = "a" * 64
    record = asyncio.run(admit(storage, owner, "raster"))
    original_lock = storage._disk_lock
    original_usage = storage._usage
    release = Event()
    lock_held = Event()

    async def exercise() -> None:
        """Release blocked disk work from the event loop before acquisition completes."""
        loop = asyncio.get_running_loop()
        loop_thread = get_ident()
        entered = asyncio.Event()

        class ObservedLock:
            """Observe the actual disk-lock wait without replacing its exclusion."""

            def __enter__(self) -> None:
                """Acquire the real lock only from a disk worker."""
                assert get_ident() != loop_thread
                loop.call_soon_threadsafe(entered.set)
                original_lock.acquire()

            def __exit__(self, *exc: object) -> None:
                """Release the real lock after the protected operation.

                Args:
                    exc: Exception details supplied by the context manager.
                """
                original_lock.release()

        def slow_inventory() -> StorageUsage:
            """Hold disk inventory until asyncio responds, then return actual usage.

            Returns:
                Original storage inventory after the event-loop handshake.
            """
            assert get_ident() != loop_thread
            loop.call_soon_threadsafe(entered.set)
            assert release.wait(5), "The event loop did not release inventory"
            return original_usage()

        def hold_lock() -> None:
            """Keep the real disk lock occupied until the event loop responds."""
            with original_lock:
                lock_held.set()
                release.wait(5)

        holder = None
        if blocked_on == "lock":
            monkeypatch.setattr(storage, "_disk_lock", ObservedLock())
            holder = Thread(target=hold_lock)
            holder.start()
            assert lock_held.wait(5)
        else:
            monkeypatch.setattr(storage, "_usage", slow_inventory)

        async def acquire() -> None:
            """Enter and leave the public storage context being exercised."""
            context = (
                storage.stage(owner, "raster", body(b"new original"))
                if entrypoint == "stage"
                else storage.open_source(owner, record.id, "raster")
            )
            async with context:
                pass

        task = asyncio.create_task(acquire())
        try:
            await asyncio.wait_for(entered.wait(), 5)
            await asyncio.sleep(0)
            assert not task.done()
            release.set()
            await task
        finally:
            release.set()
            await asyncio.gather(task, return_exceptions=True)
            if holder is not None:
                holder.join()

    asyncio.run(exercise())


@pytest.mark.parametrize("entrypoint", ["stage", "read"])
def test_cancelled_acquisition_releases_late_resources(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, entrypoint: str
) -> None:
    """Clean resources acquired after repeated cancellation without yielding them.

    Args:
        tmp_path: Disposable shared upload volume.
        monkeypatch: Delay acquisition while preserving real filesystem operations.
        entrypoint: Staging or active-read acquisition under test.
    """
    storage = UploadStorage(tmp_path)
    owner = "a" * 64
    record = asyncio.run(admit(storage, owner, "raster"))
    original_usage = storage._usage
    release = Event()

    async def exercise() -> None:
        """Cancel during inventory and retain cleanup ownership through late creation."""
        loop = asyncio.get_running_loop()
        loop_thread = get_ident()
        entered = asyncio.Event()

        def slow_inventory() -> StorageUsage:
            """Delay inventory before resource acquisition, then return real usage.

            Returns:
                Current shared storage usage.
            """
            assert get_ident() != loop_thread
            loop.call_soon_threadsafe(entered.set)
            assert release.wait(5), "The test did not release inventory"
            return original_usage()

        async def acquire() -> None:
            """Fail if a cancelled acquisition yields a resource to its caller."""
            context = (
                storage.stage(owner, "raster", body(b"new original"))
                if entrypoint == "stage"
                else storage.open_source(owner, record.id, "raster")
            )
            async with context:
                pytest.fail("Cancelled acquisition yielded its resource")

        with monkeypatch.context() as patch:
            patch.setattr(storage, "_usage", slow_inventory)
            task = asyncio.create_task(acquire())
            try:
                await asyncio.wait_for(entered.wait(), 5)
                task.cancel()
                await asyncio.sleep(0)
                task.cancel()
                await asyncio.sleep(0)
                assert not task.done()
                release.set()
                with pytest.raises(asyncio.CancelledError):
                    await task
            finally:
                release.set()
                await asyncio.gather(task, return_exceptions=True)

        assert not storage._active_reads
        assert not storage._admission.locked()
        assert not list((tmp_path / owner).glob(".pending-*"))
        assert not list((tmp_path / ".reading").glob("*"))
        assert storage.summary(owner).used_files == 1
        async with storage.open_source(owner, record.id, "raster") as (_, source):
            assert source.read_bytes() == b"original"
        await admit(storage, owner)

    asyncio.run(exercise())


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
        for index in range(100):
            asyncio.run(admit(storage, owner, "raster" if index % 2 else "vector"))
        summary = client.get("/api/uploads").json()
        assert summary["used_files"] == summary["max_files"] == 100
        assert len(summary["uploads"]) == 100
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
        with pytest.raises(UploadError, match="100 uploaded files") as full:
            asyncio.run(admit(storage, owner, "raster"))
        assert full.value.status == 409
    with TestClient(app, base_url="https://testserver") as another:
        assert another.get("/api/uploads").json()["used_files"] == 0
    first = storage.summary(owner).uploads[0]
    storage.delete(owner, first.id)
    asyncio.run(admit(storage, owner, "raster"))
    assert storage.summary(owner).used_files == 100


def test_queued_upload_rechecks_the_last_file_slot(tmp_path: Path) -> None:
    """Recheck the file quota after waiting, before consuming the next body.

    Args:
        tmp_path: Disposable shared upload volume.
    """
    storage = UploadStorage(tmp_path)
    owner = "a" * 64

    async def exercise() -> None:
        """Hold the last allowed upload's body while a second format requests admission."""
        for _ in range(99):
            await admit(storage, owner)
        entered, release = asyncio.Event(), asyncio.Event()
        consumed = False

        async def slow_body() -> AsyncIterator[bytes]:
            """Yield a first fragment, then pause the unfinished body.

            Yields:
                The two fragments of the last allowed original.
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

        async def fill_last_slot() -> None:
            """Publish the last allowed original after its held stream finishes."""
            async with storage.stage(owner, "raster", slow_body()) as pending:
                storage.publish(
                    pending,
                    UploadRecord(
                        id=uuid4(),
                        kind="raster",
                        name="Last available slot",
                        size_bytes=pending.size_bytes,
                        created_at=datetime.now(timezone.utc),
                    ),
                )

        task = asyncio.create_task(fill_last_slot())
        await entered.wait()
        assert storage.summary(owner).used_files == 100
        assert storage.summary(owner).retained_files == 0

        async def upload_over_limit() -> None:
            """Wait for the last slot to fill, then reject without consuming the body."""
            async with storage.stage(owner, "vector", unwanted_body()):
                pytest.fail("The 101st upload exceeded the browser's file quota")

        queued = asyncio.create_task(upload_over_limit())
        await asyncio.sleep(0)
        assert not queued.done()
        assert not consumed
        release.set()
        await task
        with pytest.raises(UploadError, match="100 uploaded files") as full:
            await queued
        assert full.value.status == 409
        assert not consumed
        assert storage.summary(owner).used_files == 100

    asyncio.run(exercise())


def test_upload_burst_waits_in_order_with_bounded_capacity(tmp_path: Path) -> None:
    """Queue distinct browsers without reading bodies or mixing private files.

    Args:
        tmp_path: Disposable upload volume.
    """
    storage = UploadStorage(tmp_path)
    consumed: list[int] = []

    async def upload(index: int) -> UploadRecord:
        """Publish one browser's file and record when its body is consumed.

        Args:
            index: Distinct browser and body identifier.

        Returns:
            This browser's published record.
        """

        async def chunks() -> AsyncIterator[bytes]:
            """Record admission before streaming the browser's original.

            Yields:
                Original bytes unique to this browser.
            """
            consumed.append(index)
            yield str(index).encode()

        async with storage.stage(f"{index:064x}", "vector", chunks()) as pending:
            record = UploadRecord(
                id=uuid4(),
                kind="vector",
                name=str(index),
                size_bytes=pending.size_bytes,
                created_at=datetime.now(timezone.utc),
            )
            storage.publish(pending, record)
            return record

    async def exercise() -> None:
        """Fill the queue, replace one cancelled waiter, then admit in FIFO order."""
        async with storage.stage("f" * 64, "raster", body(b"held")):
            queued = [asyncio.create_task(upload(index)) for index in range(32)]
            await asyncio.sleep(0)
            assert not any(task.done() for task in queued)
            assert consumed == []
            assert len(list(tmp_path.glob("*/.pending-*"))) == 1
            with pytest.raises(UploadError, match="Too many uploads") as full:
                await upload(98)
            assert full.value.status == 429
            queued[15].cancel()
            with pytest.raises(asyncio.CancelledError):
                await queued[15]
            replacement = asyncio.create_task(upload(99))
            await asyncio.sleep(0)
            assert not replacement.done()
            assert consumed == []
        survivors = [task for index, task in enumerate(queued) if index != 15]
        records = await asyncio.wait_for(asyncio.gather(*survivors, replacement), 20)
        expected = [index for index in range(32) if index != 15] + [99]
        assert consumed == expected
        for index, record in zip(expected, records, strict=True):
            assert storage.summary(f"{index:064x}").uploads == [record]
        assert storage.summary(f"{15:064x}").used_files == 0
        assert storage.summary(f"{98:064x}").used_files == 0
        assert not list(tmp_path.glob("*/.pending-*"))

    asyncio.run(exercise())


@pytest.mark.parametrize("stop", ["cancel", "timeout"])
def test_stopped_upload_waiter_does_not_consume_body_or_storage(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    stop: str,
) -> None:
    """Release a cancelled or timed-out wait without creating an incoming file.

    Args:
        tmp_path: Disposable upload volume.
        monkeypatch: Shorten only the admission wait for the deadline case.
        stop: How the pending request ends before admission.
    """
    storage = UploadStorage(tmp_path)
    consumed = False

    async def chunks() -> AsyncIterator[bytes]:
        """Track whether an abandoned request's body is consumed.

        Yields:
            Bytes that must remain unread.
        """
        nonlocal consumed
        consumed = True
        yield b"unused"

    async def waiting() -> None:
        """Try to stage a second browser's body while the first holds admission."""
        async with storage.stage("b" * 64, "vector", chunks()):
            pytest.fail("Stopped waiter entered upload admission")

    async def exercise() -> None:
        """End a waiting request, then prove the storage accepts a fresh request."""
        async with storage.stage("a" * 64, "raster", body(b"held")):
            if stop == "timeout":
                monkeypatch.setattr(
                    "eolab_app.upload_storage.UPLOAD_QUEUE_WAIT_SECONDS", 0.02
                )
            task = asyncio.create_task(waiting())
            await asyncio.sleep(0)
            assert not task.done()
            if stop == "cancel":
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
            else:
                with pytest.raises(UploadError, match="waited too long") as expired:
                    await asyncio.wait_for(task, 5)
                assert expired.value.status == 429
            assert not consumed
            assert not (tmp_path / ("b" * 64)).exists()
        await admit(storage, "b" * 64)
        assert storage.summary("b" * 64).used_files == 1
        assert not list(tmp_path.glob("*/.pending-*"))

    asyncio.run(exercise())


@pytest.mark.parametrize("failure", ["inspection", "disconnect"])
def test_failed_upload_releases_admission_to_waiting_browser(
    tmp_path: Path,
    failure: str,
) -> None:
    """Clean a failed upload before another browser starts streaming its file.

    Args:
        tmp_path: Disposable upload volume.
        failure: Fail after streaming, or disconnect before the body arrives.
    """
    from starlette.requests import ClientDisconnect

    storage = UploadStorage(tmp_path)

    async def exercise() -> None:
        """Queue work behind a failed original and verify isolation and cleanup."""
        entered, release = asyncio.Event(), asyncio.Event()

        async def chunks() -> AsyncIterator[bytes]:
            """Hold reception, optionally ending it with a client disconnect.

            Yields:
                Original bytes when the body arrives successfully.

            Raises:
                ClientDisconnect: When the pending connection has closed.
            """
            entered.set()
            await release.wait()
            if failure == "disconnect":
                raise ClientDisconnect()
            yield b"invalid original"

        async def failed() -> None:
            """Fail inspection after receiving the original.

            Raises:
                OSError: The simulated format inspection rejects its source.
                ClientDisconnect: The request body reports a disconnected client.
            """
            async with storage.stage("a" * 64, "vector", chunks()):
                raise OSError("inspection failed")

        first = asyncio.create_task(failed())
        await entered.wait()
        next_upload = asyncio.create_task(admit(storage, "b" * 64, "raster"))
        await asyncio.sleep(0)
        assert not next_upload.done()
        release.set()
        with pytest.raises(ClientDisconnect if failure == "disconnect" else OSError):
            await first
        record = await asyncio.wait_for(next_upload, 5)
        assert storage.summary("a" * 64).used_files == 0
        assert storage.summary("b" * 64).uploads == [record]
        assert not list(tmp_path.glob("*/.pending-*"))

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
                    kind="vector",
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


@pytest.mark.parametrize("kind", ["vector", "raster"])
def test_expiry_withdraws_access_before_sweep_and_preserves_original_date(
    tmp_path: Path,
    kind: UploadKind,
) -> None:
    """Trust existing admission records and expire without opening their datasets.

    Args:
        tmp_path: Disposable upload volume.
        kind: Published kind to remove from an otherwise intact record.
    """
    storage = UploadStorage(tmp_path)
    owner = "a" * 64
    record = asyncio.run(admit(storage, owner, kind))
    _, source = storage.get_upload_source(owner, record.id, kind)
    token = storage.retain_source(source)
    metadata_path = source.parent / "metadata.json"
    existing = json.loads(metadata_path.read_text())
    existing.pop("kind")
    metadata_path.write_text(json.dumps(existing))
    storage.initialize()
    assert storage.summary(owner).uploads == []
    assert storage.summary(owner).used_files == 1
    for requested in ("vector", "raster"):
        assert not storage.is_available(record.id, requested)
        with pytest.raises(UploadError) as unavailable:
            storage.get_upload_source(owner, record.id, requested)
        assert unavailable.value.status == 404
    peer = asyncio.run(admit(storage, owner, "raster"))
    assert storage.summary(owner).uploads == [peer]
    storage.delete(owner, peer.id)
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
