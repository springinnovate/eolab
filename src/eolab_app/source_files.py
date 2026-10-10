"""Keep authorized immutable files available until their readers have stopped."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
import hashlib
from pathlib import Path
from typing import Any, Protocol

from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
    run_bounded_process,
)


class LeasedSourceFile(Protocol):
    """An immutable file held available by its owning storage service."""

    path: Path
    size: int
    sha256: str
    media_type: str
    lease_id: str


class SourceFileError(Exception):
    """Authorized source access failed without exposing private storage details."""

    def __init__(
        self, message: str, status: int = 409, *, code: str | None = None
    ) -> None:
        """Keep a public explanation and delivery status.

        Args:
            message: Path-free explanation of the failure.
            status: HTTP status used by delivery adapters.
            code: Optional stable failure code supplied by the source authority.
        """
        super().__init__(message)
        self.status = status
        self.code = code


def file_identity(path: Path) -> tuple[int, int, int, int, int]:
    """Read metadata that can reveal replacement or mutation of an immutable file.

    Args:
        path: Authorized source path.

    Returns:
        Device, inode, byte size, modification time and metadata-change time.

    Raises:
        OSError: If the file is no longer readable.
    """
    stat = path.stat()
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


def verify_source_file(writer: Any, path: Path, size: int, sha256: str) -> None:
    """Verify a file's published bytes within the supervising process deadline.

    Args:
        writer: Supervisor's one-result pipe writer.
        path: Confined source path supplied by its authority.
        size: Published byte count.
        sha256: Published immutable checksum.
    """
    try:
        before = file_identity(path)
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            while block := stream.read(1024 * 1024):
                digest.update(block)
        valid = before[2] == size and digest.hexdigest() == sha256
        writer.put(before if valid and before == file_identity(path) else None)
    except OSError:
        writer.put(None)


async def finish_source_task(task: asyncio.Task[Any]) -> None:
    """Wait through repeated cancellation until source work or cleanup has finished.

    Args:
        task: Owned task whose completion must precede file release.
    """
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            continue
        except Exception:
            break
    if not task.cancelled():
        task.exception()


class LeasedSourceFiles:
    """Scope immutable file access through injected ownership and retention operations."""

    def __init__(
        self,
        acquire: Callable[[str, str, str], Awaitable[LeasedSourceFile]],
        release: Callable[[str], Awaitable[bool]],
        check: Callable[[str, str, str], Awaitable[tuple[int, str, str]]],
        renew: Callable[[str], Awaitable[bool]],
        *,
        renewal_seconds: float = 10,
    ) -> None:
        """Connect file authority without importing any storage or job implementation.

        Args:
            acquire: Authorize owner and opaque source identities, acquiring a lease.
            release: Release a lease after all owned native work stops.
            check: Reauthorize and return current size, checksum and media type.
            renew: Extend a live lease; false means it was lost.
            renewal_seconds: Interval shorter than the owning lease lifetime.

        Raises:
            ValueError: If renewal timing is not positive.
        """
        if renewal_seconds <= 0:
            raise ValueError("Source renewal interval must be positive")
        self.acquire, self.release, self.check, self.renew = (
            acquire,
            release,
            check,
            renew,
        )
        self.renewal_seconds = renewal_seconds
        self._verification_slots = asyncio.Semaphore(2)

    async def _acquire(self, owner: str, run_id: str, file_id: str) -> LeasedSourceFile:
        """Release a late lease if cancellation races its asynchronous acquisition.

        Args:
            owner: Requesting session hash.
            run_id: Opaque run identity.
            file_id: Opaque published file identity.

        Returns:
            Owner-authorized retained source.

        Raises:
            Exception: An authorization or storage failure from the owner.
            asyncio.CancelledError: After releasing any late-acquired lease.
        """
        task = asyncio.create_task(self.acquire(owner, run_id, file_id))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            await finish_source_task(task)
            if not task.cancelled() and task.exception() is None:
                await finish_source_task(
                    asyncio.create_task(self.release(task.result().lease_id))
                )
            raise

    @asynccontextmanager
    async def open(
        self, owner: str, run_id: str, file_id: str
    ) -> AsyncIterator[LeasedSourceFile]:
        """Verify, retain and reauthorize one file around a complete consumer read.

        Consumers must finish or stop their native work before leaving this scope.
        Checksums have two verification slots and a 30-second hard deadline.
        Renewal failure cancels the consumer; successful delivery rechecks access
        and metadata. There is no shared authorization or checksum cache.

        Args:
            owner: Requesting session hash, never a client-supplied owner name.
            run_id: Opaque run identity.
            file_id: Opaque immutable file identity.

        Yields:
            Checksum-verified file protected by a renewable lease.

        Raises:
            SourceFileError: On mutation, verification capacity/deadline or lease loss.
            Exception: On source-owner authorization failure.
            asyncio.CancelledError: After the consumer and lease cleanup finish.
        """
        source = await self._acquire(owner, run_id, file_id)
        consumer = asyncio.current_task()
        lost = False

        async def keep_available() -> None:
            """Cancel the consumer if its file can no longer be retained."""
            nonlocal lost
            try:
                while True:
                    await asyncio.sleep(self.renewal_seconds)
                    if not await self.renew(source.lease_id):
                        raise SourceFileError("The source file is no longer available.")
            except Exception:
                lost = True
                consumer.cancel()

        heartbeat = asyncio.create_task(keep_available())
        try:
            if self._verification_slots.locked():
                raise SourceFileError("Source checks are busy. Try again shortly.", 429)
            async with self._verification_slots:
                try:
                    identity = await run_bounded_process(
                        verify_source_file,
                        (source.path, source.size, source.sha256),
                        30,
                    )
                except ProcessDeadlineError as error:
                    raise SourceFileError(
                        "The source check took too long. Try a smaller file.", 504
                    ) from error
            if identity is None:
                raise SourceFileError(
                    "The source file changed and is no longer valid.", 422
                )
            yield source
            # A consumer may shield its final native cleanup from cancellation.
            # Renewal loss still forbids delivery even if that cleanup consumed
            # the cancellation raised by the heartbeat.
            if lost:
                raise SourceFileError("The source file is no longer available.")
            current = await self.check(owner, run_id, file_id)
            if (
                current != (source.size, source.sha256, source.media_type)
                or file_identity(source.path) != identity
            ):
                raise SourceFileError(
                    "The source file changed while it was being read.", 422
                )
        except asyncio.CancelledError:
            if lost:
                raise SourceFileError(
                    "The source file is no longer available."
                ) from None
            raise
        except OSError as error:
            raise SourceFileError(
                "The source file is no longer available.", 410
            ) from error
        finally:
            heartbeat.cancel()
            await finish_source_task(heartbeat)
            await finish_source_task(asyncio.create_task(self.release(source.lease_id)))
