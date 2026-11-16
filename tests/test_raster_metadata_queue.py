"""Verify bounded metadata admission through original-source and HTTP lifetimes."""

import asyncio
from collections.abc import Callable
import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI
import pytest

from eolab_app.raster.source_access import RasterSourceAccess
from eolab_app.raster.source_models import RunArtifactReference
from eolab_app.routes.raster_analysis import create_raster_analysis_router
from eolab_app.source_files import SourceFileError, finish_source_task
from test_raster_source_access import (
    PRIVATE,
    CatalogAuthority,
    FileAuthority,
    write_source,
)


class MetadataReaders:
    """Hold supervised metadata reads while real source leases and queues operate."""

    def __init__(self, path: Path) -> None:
        """Compose the production source boundary with observable native work.

        Args:
            path: Completed immutable fixture raster.
        """
        self.authority = FileAuthority(path)
        self.sources = RasterSourceAccess(
            CatalogAuthority(path), self.authority.files()
        )
        self.release = asyncio.Event()
        self.started = asyncio.Event()
        self.calls = 0
        self.active = 0
        self.maximum_active = 0

    async def read(self, reader: Callable[..., Any], *arguments: Any) -> Any:
        """Gate native completion, then execute the actual metadata reader.

        Args:
            reader: Production metadata function selected by source access.
            arguments: Its authorized original and optional projection.

        Returns:
            The original reader's metadata.

        Raises:
            asyncio.CancelledError: If this controlled native operation is canceled.
        """
        self.calls += 1
        self.active += 1
        self.maximum_active = max(self.maximum_active, self.active)
        if self.active == 2:
            self.started.set()
        try:
            await self.release.wait()
            return reader(*arguments)
        finally:
            self.active -= 1


async def wait_for_pending(sources: RasterSourceAccess, count: int) -> None:
    """Synchronize a test with queued admission without acquiring its source.

    Args:
        sources: Production metadata admission under test.
        count: Expected pending requests before the test changes their lifecycle.

    Raises:
        TimeoutError: If the expected queue state is never reached.
    """
    async with asyncio.timeout(5):
        while sources._waiting_metadata != count:
            await asyncio.sleep(0)


def test_metadata_burst_keeps_two_readers_and_bounds_waiting(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Admit a burst without opening queued files or exceeding native capacity.

    Args:
        tmp_path: Isolated immutable source directory.
        monkeypatch: Gate only the supervised native-read boundary.
    """
    readers = MetadataReaders(write_source(tmp_path / "source.tif"))
    monkeypatch.setattr(
        "eolab_app.raster.source_access.read_private_raster", readers.read
    )
    reference = RunArtifactReference(**PRIVATE)

    async def exercise() -> None:
        """Fill both readers and all waiting positions, then complete every request."""
        active = [
            asyncio.create_task(readers.sources.describe(reference, "owner"))
            for _ in range(2)
        ]
        await asyncio.wait_for(readers.started.wait(), 5)
        queued = [
            asyncio.create_task(readers.sources.describe(reference, "owner"))
            for _ in range(32)
        ]
        await wait_for_pending(readers.sources, 32)
        assert readers.authority.sequence == readers.calls == 2
        assert len(readers.authority.leases) == 2
        with pytest.raises(
            SourceFileError, match="Too many raster information"
        ) as full:
            await readers.sources.describe(reference, "owner")
        assert full.value.status == 429
        readers.release.set()
        results = await asyncio.wait_for(asyncio.gather(*active, *queued), 10)
        assert len(results) == readers.calls == readers.authority.sequence == 34
        assert all(
            result["source"] == PRIVATE and result["width"] == 4 for result in results
        )
        assert readers.maximum_active == 2
        assert not readers.authority.leases

    asyncio.run(exercise())


@pytest.mark.parametrize("stop", ["cancel", "timeout", "disconnect"])
def test_abandoned_metadata_wait_never_acquires_source(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    stop: str,
) -> None:
    """Remove abandoned queued work before authorization, leasing or native reading.

    Args:
        tmp_path: Isolated source directory.
        monkeypatch: Gate native work and shorten only the timeout case's deadline.
        stop: Task cancellation, waiting deadline or HTTP client disconnection.
    """
    readers = MetadataReaders(write_source(tmp_path / "source.tif"))
    monkeypatch.setattr(
        "eolab_app.raster.source_access.read_private_raster", readers.read
    )
    monkeypatch.setattr("eolab_app.raster.source_access.METADATA_QUEUE_CAPACITY", 1)
    reference = RunArtifactReference(**PRIVATE)

    async def exercise() -> None:
        """End the queued request and admit a replacement behind the active readers."""
        active = [
            asyncio.create_task(readers.sources.describe(reference, "owner"))
            for _ in range(2)
        ]
        await asyncio.wait_for(readers.started.wait(), 5)
        if stop == "timeout":
            monkeypatch.setattr(
                "eolab_app.raster.source_access.METADATA_QUEUE_WAIT_SECONDS", 0.02
            )
        messages: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        responses: list[dict[str, Any]] = []

        async def send(message: dict[str, Any]) -> None:
            """Capture the actual HTTP response to a disconnected metadata request.

            Args:
                message: ASGI response from the existing analysis route.
            """
            responses.append(message)

        if stop == "disconnect":
            app = FastAPI()
            app.include_router(
                create_raster_analysis_router(
                    None,
                    None,
                    source_access=readers.sources,
                    session_owner=lambda request, response: "owner",
                )
            )
            await messages.put(
                {
                    "type": "http.request",
                    "body": json.dumps({"source": PRIVATE}).encode(),
                    "more_body": False,
                }
            )
            scope = {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": "POST",
                "scheme": "http",
                "path": "/api/raster-analysis/sources",
                "query_string": b"",
                "headers": [(b"content-type", b"application/json")],
            }
            queued = asyncio.create_task(app(scope, messages.get, send))
        else:
            queued = asyncio.create_task(readers.sources.describe(reference, "owner"))
        await wait_for_pending(readers.sources, 1)
        assert readers.authority.sequence == readers.calls == 2
        if stop == "cancel":
            queued.cancel()
            with pytest.raises(asyncio.CancelledError):
                await queued
        elif stop == "timeout":
            with pytest.raises(SourceFileError, match="waited too long") as expired:
                await asyncio.wait_for(queued, 5)
            assert expired.value.status == 429
        else:
            await messages.put({"type": "http.disconnect"})
            await asyncio.wait_for(queued, 5)
            assert (
                next(
                    item["status"]
                    for item in responses
                    if item["type"] == "http.response.start"
                )
                == 499
            )
        assert readers.authority.sequence == readers.calls == 2
        monkeypatch.setattr(
            "eolab_app.raster.source_access.METADATA_QUEUE_WAIT_SECONDS", 30
        )
        replacement = asyncio.create_task(readers.sources.describe(reference, "owner"))
        await wait_for_pending(readers.sources, 1)
        readers.release.set()
        await asyncio.wait_for(asyncio.gather(*active, replacement), 5)
        assert readers.calls == readers.authority.sequence == 3
        assert not readers.authority.leases

    asyncio.run(exercise())


@pytest.mark.parametrize("unavailable", ["owner", "expired"])
def test_metadata_wait_rechecks_source_access_when_admitted(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    unavailable: str,
) -> None:
    """Keep authorization current when a request reaches the front of the queue.

    Args:
        tmp_path: Isolated original raster.
        monkeypatch: Gate only the supervised native reader.
        unavailable: Withdraw the queued owner's membership or expire the source.
    """
    readers = MetadataReaders(write_source(tmp_path / "source.tif"))
    monkeypatch.setattr(
        "eolab_app.raster.source_access.read_private_raster", readers.read
    )
    reference = RunArtifactReference(**PRIVATE)

    async def exercise() -> None:
        """Revoke access while work is waiting and reject before native reading."""
        readers.authority.owners.add("queued-owner")
        active = [
            asyncio.create_task(readers.sources.describe(reference, "owner"))
            for _ in range(2)
        ]
        await asyncio.wait_for(readers.started.wait(), 5)
        queued = asyncio.create_task(
            readers.sources.describe(reference, "queued-owner")
        )
        await wait_for_pending(readers.sources, 1)
        if unavailable == "owner":
            readers.authority.owners.remove("queued-owner")
        else:
            readers.authority.ready = False
        readers.release.set()
        results = await asyncio.gather(*active, queued, return_exceptions=True)
        assert isinstance(results[-1], SourceFileError)
        assert results[-1].status == (404 if unavailable == "owner" else 409)
        assert readers.calls == readers.authority.sequence == 2
        assert not readers.authority.leases
        readers.authority.ready = True
        assert (await readers.sources.describe(reference, "owner"))["width"] == 4

    asyncio.run(exercise())


def test_cancelled_metadata_reader_keeps_slot_and_lease_until_native_exit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Do not admit queued work while cancelled native reading still owns its file.

    Args:
        tmp_path: Isolated original raster.
        monkeypatch: Control native cancellation acknowledgement and exit.
    """
    readers = MetadataReaders(write_source(tmp_path / "source.tif"))
    reference = RunArtifactReference(**PRIVATE)

    async def exercise() -> None:
        """Cancel a reader twice, then release native cleanup before its queued peer."""
        stopping, exited = asyncio.Event(), asyncio.Event()
        first_call = True

        async def native(reader: Callable[..., Any], *arguments: Any) -> Any:
            """Delay the first native cancellation until its cleanup is permitted.

            Args:
                reader: Production metadata reader.
                arguments: Original file and projection arguments.

            Returns:
                Metadata for calls that complete normally.

            Raises:
                asyncio.CancelledError: After the first controlled native exit.
            """
            nonlocal first_call
            first = first_call
            first_call = False
            try:
                return await readers.read(reader, *arguments)
            except asyncio.CancelledError:
                if first:
                    stopping.set()
                    await finish_source_task(asyncio.create_task(exited.wait()))
                raise

        monkeypatch.setattr(
            "eolab_app.raster.source_access.read_private_raster", native
        )
        first = asyncio.create_task(readers.sources.describe(reference, "owner"))
        second = asyncio.create_task(readers.sources.describe(reference, "owner"))
        await asyncio.wait_for(readers.started.wait(), 5)
        queued = asyncio.create_task(readers.sources.describe(reference, "owner"))
        await wait_for_pending(readers.sources, 1)
        first.cancel()
        await asyncio.wait_for(stopping.wait(), 5)
        first.cancel()
        await asyncio.sleep(0)
        assert not first.done() and not queued.done()
        assert readers.calls == readers.authority.sequence == 2
        assert len(readers.authority.leases) == 2
        exited.set()
        with pytest.raises(asyncio.CancelledError):
            await first
        readers.release.set()
        await asyncio.wait_for(asyncio.gather(second, queued), 5)
        assert readers.calls == readers.authority.sequence == 3
        assert not readers.authority.leases

    asyncio.run(exercise())
