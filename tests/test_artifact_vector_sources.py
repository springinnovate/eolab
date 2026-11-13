"""Check immutable vector metadata concurrency through authorized source leases."""

import asyncio
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from eolab_app.source_files import LeasedSourceFile, SourceFileError
from eolab_app.vector import artifact_sources
from eolab_app.vector.artifact_sources import (
    ArtifactVectorLayer,
    ArtifactVectorSourceResolver,
)
from tests.test_raster_source_access import FileAuthority, PRIVATE

FIRST = PRIVATE["artifactId"]
SECOND = "c" * 32
METADATA = ("features", {"label": "str"}, 1, (0, 0, 1, 1), "polygon", {})


@pytest.fixture
def metadata_boundary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> tuple[ArtifactVectorSourceResolver, FileAuthority, asyncio.Queue[str]]:
    """Compose real renewable leases with two fixture identities for one file.

    Args:
        tmp_path: Private original-file directory; native inspection is controlled.
        monkeypatch: Adapt the existing authority to two published vector identities.

    Returns:
        Resolver, source authority and a queue recording fully authorized reads.
    """
    path = tmp_path / "result.gpkg"
    path.write_bytes(b"immutable metadata fixture")
    authority = FileAuthority(path)
    check = authority.check

    async def check_artifact(owner: str, run: str, file: str) -> None:
        """Authorize either fixture identity through the existing owner/lifetime checks.

        Args:
            owner: Requesting browser identity.
            run: Requested run ID.
            file: Requested immutable artifact ID.

        Raises:
            SourceFileError: If identity, owner or source lifetime rejects access.
        """
        if file not in (FIRST, SECOND):
            raise SourceFileError("Unavailable to this session", 404)
        await check(owner, run, FIRST)

    monkeypatch.setattr(authority, "check", check_artifact)
    files = authority.files()
    open_file = files.open
    authorized: asyncio.Queue[str] = asyncio.Queue()

    @asynccontextmanager
    async def open_vector(
        owner: str, run: str, file: str
    ) -> AsyncIterator[LeasedSourceFile]:
        """Record admission immediately before the resolver can inspect its cache.

        Args:
            owner: Requesting browser identity.
            run: Requested run ID.
            file: Requested artifact ID.

        Yields:
            The retained file with its published vector MIME type.

        Raises:
            SourceFileError: If source authorization or successful delivery fails.
        """
        async with open_file(owner, run, file) as source:
            authorized.put_nowait(file)
            yield replace(source, media_type="application/geopackage+sqlite3")

    monkeypatch.setattr(files, "open", open_vector)
    return ArtifactVectorSourceResolver(files), authority, authorized


async def read_metadata(
    sources: ArtifactVectorSourceResolver, file: str = FIRST, owner: str = "owner"
) -> ArtifactVectorLayer:
    """Return metadata only after the real source scope reauthorizes and releases it.

    Args:
        sources: Resolver using the controlled source authority.
        file: Requested artifact ID.
        owner: Server-derived browser identity.

    Returns:
        Complete immutable layer metadata after successful delivery checks.

    Raises:
        SourceFileError: If source access or native inspection fails.
        asyncio.CancelledError: After a cancelled read releases its source lease.
    """
    async with sources.open_layer(owner, PRIVATE["jobId"], file) as metadata:
        return metadata


def test_cached_metadata_does_not_wait_for_unrelated_cold_scan(
    metadata_boundary: tuple[
        ArtifactVectorSourceResolver, FileAuthority, asyncio.Queue[str]
    ],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Deliver a warm artifact while another artifact's native metadata read is paused.

    Args:
        metadata_boundary: Real resolver and leases with observable source admission.
        monkeypatch: Pause only the second native metadata invocation.
    """
    sources, authority, authorized = metadata_boundary

    async def exercise() -> None:
        """Require warm delivery before releasing the unrelated native read."""
        entered, release = asyncio.Event(), asyncio.Event()
        calls = 0

        async def scan(
            target: Callable[..., None],
            arguments: tuple[Any, ...],
            timeout_seconds: float | None,
        ) -> tuple[Any, ...]:
            """Hold the second native scan while retaining its original file.

            Args:
                target: Existing metadata inspection function.
                arguments: Original retained file path.
                timeout_seconds: Existing native deadline.

            Returns:
                Ordinary metadata after the controlled scan finishes.
            """
            nonlocal calls
            assert target is artifact_sources.read_artifact_vector_metadata
            assert arguments == (authority.path,) and timeout_seconds == 60
            calls += 1
            if calls == 2:
                entered.set()
                await release.wait()
            return METADATA

        monkeypatch.setattr(artifact_sources, "run_bounded_process", scan)
        cached = await read_metadata(sources)
        assert await authorized.get() == FIRST
        cold = asyncio.create_task(read_metadata(sources, SECOND))
        warm: asyncio.Task[ArtifactVectorLayer] | None = None
        try:
            await asyncio.wait_for(entered.wait(), 5)
            assert await authorized.get() == SECOND
            warm = asyncio.create_task(read_metadata(sources))
            assert await asyncio.wait_for(authorized.get(), 5) == FIRST
            assert await asyncio.wait_for(asyncio.shield(warm), 1) is cached
            assert not cold.done() and not release.is_set()
            assert len(authority.leases) == 1 and calls == 2
        finally:
            release.set()
            tasks = [cold] if warm is None else [cold, warm]
            await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), 5)
        assert not authority.leases

    asyncio.run(exercise())


@pytest.mark.parametrize("second_file", [FIRST, SECOND])
def test_cold_metadata_scans_remain_serialized_and_coalesced(
    metadata_boundary: tuple[
        ArtifactVectorSourceResolver, FileAuthority, asyncio.Queue[str]
    ],
    monkeypatch: pytest.MonkeyPatch,
    second_file: str,
) -> None:
    """Keep a second miss queued and reuse metadata when both requests name one file.

    Args:
        metadata_boundary: Real resolver and observable authorized source scopes.
        monkeypatch: Pause native scans at their existing execution boundary.
        second_file: Same identity for coalescing or another identity for serialization.
    """
    sources, authority, authorized = metadata_boundary

    async def exercise() -> None:
        """Observe both admissions while only the first native scan is allowed to run."""
        release = asyncio.Event()
        calls = 0

        async def scan(
            target: Callable[..., None],
            arguments: tuple[Any, ...],
            timeout_seconds: float | None,
        ) -> tuple[Any, ...]:
            """Count native scans and block the first until the test releases it.

            Args:
                target: Existing native metadata reader.
                arguments: Retained original-file arguments.
                timeout_seconds: Existing native deadline.

            Returns:
                One immutable metadata result per admitted native scan.
            """
            nonlocal calls
            calls += 1
            if calls == 1:
                await release.wait()
            return METADATA

        monkeypatch.setattr(artifact_sources, "run_bounded_process", scan)
        first = asyncio.create_task(read_metadata(sources))
        second: asyncio.Task[ArtifactVectorLayer] | None = None
        try:
            assert await asyncio.wait_for(authorized.get(), 5) == FIRST
            second = asyncio.create_task(read_metadata(sources, second_file))
            assert await asyncio.wait_for(authorized.get(), 5) == second_file
            assert calls == 1 and not first.done() and not second.done()
            assert len(authority.leases) == 2
            release.set()
            first_result, second_result = await asyncio.wait_for(
                asyncio.gather(first, second), 5
            )
            assert calls == (1 if second_file == FIRST else 2)
            assert (first_result is second_result) == (second_file == FIRST)
        finally:
            release.set()
            tasks = [first] if second is None else [first, second]
            await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), 5)
        assert not authority.leases

    asyncio.run(exercise())


def test_cached_metadata_preserves_authorization_delivery_and_expiry_cleanup(
    metadata_boundary: tuple[
        ArtifactVectorSourceResolver, FileAuthority, asyncio.Queue[str]
    ],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep cached values behind source access checks and explicit lifetime eviction.

    Args:
        metadata_boundary: Real resolver with controlled ownership and expiry.
        monkeypatch: Replace the native read with fixed immutable metadata.
    """
    sources, authority, _ = metadata_boundary
    calls = 0

    async def scan(
        target: Callable[..., None],
        arguments: tuple[Any, ...],
        timeout_seconds: float | None,
    ) -> tuple[Any, ...]:
        """Count native cache fills without changing source authorization.

        Args:
            target: Existing native metadata reader.
            arguments: Retained original-file arguments.
            timeout_seconds: Existing native deadline.

        Returns:
            Immutable source metadata.
        """
        nonlocal calls
        calls += 1
        return METADATA

    monkeypatch.setattr(artifact_sources, "run_bounded_process", scan)

    async def exercise() -> None:
        """Reject foreign and expired hits, recheck delivery and evict expired metadata."""
        cached = await read_metadata(sources)
        assert await read_metadata(sources) is cached
        for file, owner in ((FIRST, "foreign"), ("d" * 32, "owner")):
            with pytest.raises(SourceFileError) as denied:
                await read_metadata(sources, file, owner)
            assert denied.value.status == 404
        with monkeypatch.context() as patch:
            patch.setattr(sources.files, "open", authority.files().open)
            with pytest.raises(SourceFileError, match="not a supported vector") as mime:
                await read_metadata(sources)
            assert mime.value.status == 422
        with pytest.raises(SourceFileError, match="expired"):
            async with sources.open_layer("owner", PRIVATE["jobId"], FIRST) as result:
                assert result is cached and authority.leases
                authority.ready = False
        with pytest.raises(SourceFileError, match="expired"):
            await read_metadata(sources)
        assert calls == 1 and not authority.leases
        assert sources.list_cached_references() == ((PRIVATE["jobId"], FIRST),)
        sources.forget_metadata(PRIVATE["jobId"], FIRST)
        assert sources.list_cached_references() == ()

    asyncio.run(exercise())


@pytest.mark.parametrize("cancelled_read", ["waiting", "running"])
def test_cancelled_metadata_reads_release_leases_after_native_exit(
    metadata_boundary: tuple[
        ArtifactVectorSourceResolver, FileAuthority, asyncio.Queue[str]
    ],
    monkeypatch: pytest.MonkeyPatch,
    cancelled_read: str,
) -> None:
    """Cancel queued or active scans without releasing native capacity or leases early.

    Args:
        metadata_boundary: Real resolver and observable renewable source leases.
        monkeypatch: Hold the native execution boundary through cancellation cleanup.
        cancelled_read: Whether to cancel the queued request or the running scan.
    """
    sources, authority, authorized = metadata_boundary

    async def exercise() -> None:
        """Keep a source retained until its controlled native cancellation has finished."""
        release, stopping, stopped = (asyncio.Event() for _ in range(3))
        calls = 0

        async def scan(
            target: Callable[..., None],
            arguments: tuple[Any, ...],
            timeout_seconds: float | None,
        ) -> tuple[Any, ...]:
            """Retain the first scan's native work until explicit completion or exit.

            Args:
                target: Existing native metadata reader.
                arguments: Retained original-file arguments.
                timeout_seconds: Existing native deadline.

            Returns:
                Immutable metadata after ordinary completion.

            Raises:
                asyncio.CancelledError: After the controlled native reader exits.
            """
            nonlocal calls
            calls += 1
            if calls == 1:
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    stopping.set()
                    await stopped.wait()
                    raise
            return METADATA

        monkeypatch.setattr(artifact_sources, "run_bounded_process", scan)
        first = asyncio.create_task(read_metadata(sources))
        second: asyncio.Task[ArtifactVectorLayer] | None = None
        try:
            assert await asyncio.wait_for(authorized.get(), 5) == FIRST
            second = asyncio.create_task(read_metadata(sources, SECOND))
            assert await asyncio.wait_for(authorized.get(), 5) == SECOND
            cancelled = second if cancelled_read == "waiting" else first
            cancelled.cancel()
            if cancelled_read == "running":
                await asyncio.wait_for(stopping.wait(), 5)
                assert len(authority.leases) == 2 and calls == 1
                assert not first.done() and not second.done()
                stopped.set()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(cancelled, 5)
            if cancelled_read == "waiting":
                assert len(authority.leases) == 1 and calls == 1
                assert not first.done()
                release.set()
                await asyncio.wait_for(first, 5)
                remaining_file = FIRST
            else:
                await asyncio.wait_for(second, 5)
                assert calls == 2
                remaining_file = SECOND
            assert sources.list_cached_references() == (
                (PRIVATE["jobId"], remaining_file),
            )
        finally:
            release.set()
            stopped.set()
            tasks = [first] if second is None else [first, second]
            await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), 5)
        assert not authority.leases

    asyncio.run(exercise())
