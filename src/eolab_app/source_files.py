"""Keep authorized immutable files available until their readers have stopped."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
import hashlib
from pathlib import Path
from typing import Any, Protocol

from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
    run_bounded_process,
)


class LeasedSourceFile(Protocol):
    """An immutable file protected from cleanup by a temporary read lease.

    Attributes:
        path: Authorized original file path on the server.
        size: Published file size in bytes.
        sha256: Published SHA-256 checksum of the complete file.
        media_type: Published MIME type.
        lease_id: Identifier used to renew or release cleanup protection.
    """

    path: Path
    size: int
    sha256: str
    media_type: str
    lease_id: str


@dataclass(frozen=True)
class ResolvedSourceFile:
    """An authorized immutable file for a short read that may race cleanup.

    Attributes:
        path: Server-resolved confined original file.
        size: Published byte count.
        sha256: Checksum established when the original file was published.
        media_type: Published file format.
    """

    path: Path
    size: int
    sha256: str
    media_type: str


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
    """Read a file's checksum and report whether it matches its published metadata.

    The writer receives the file's stat identity if size, checksum and stat
    metadata agree before and after reading, or None if verification fails.
    The supervising process enforces the time limit for this complete-file read.

    Args:
        writer: Supervisor's one-result pipe writer.
        path: Confined source path supplied by its authority.
        size: Published byte count.
        sha256: Published immutable checksum.
    """
    try:
        identity_before_read = file_identity(path)
        checksum_hasher = hashlib.sha256()
        with path.open("rb") as stream:
            while block := stream.read(1024 * 1024):
                checksum_hasher.update(block)
        content_matches_publication = (
            identity_before_read[2] == size and checksum_hasher.hexdigest() == sha256
        )
        writer.put(
            identity_before_read
            if content_matches_publication
            and identity_before_read == file_identity(path)
            else None
        )
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


@dataclass
class _PendingVerification:
    """An unfinished checksum scan retained by its independently leased callers.

    Attributes:
        task: Supervised scan that stops native work before completing.
        callers: Admitted requests still waiting for this scan.
    """

    task: asyncio.Task[tuple[int, int, int, int, int] | None]
    callers: int = 0


class LeasedSourceFiles:
    """Authorize file reads and renew cleanup protection for long-running readers.

    Storage callbacks check access and manage leases. Short reads use resolve()
    without a lease; open() verifies the checksum and protects the file until
    the reader finishes.
    """

    def __init__(
        self,
        acquire: Callable[[str, str, str], Awaitable[LeasedSourceFile]],
        release: Callable[[str], Awaitable[bool]],
        check: Callable[[str, str, str], Awaitable[tuple[int, str, str]]],
        renew: Callable[[str], Awaitable[bool]],
        *,
        renewal_seconds: float = 10,
        resolve: Callable[[str, str, str], Awaitable[ResolvedSourceFile]] | None = None,
    ) -> None:
        """Configure storage callbacks for authorization and temporary read leases.

        Args:
            acquire: Authorize owner and opaque source identities, acquiring a lease.
            release: Release a lease after all owned native work stops.
            check: Reauthorize and return current size, checksum and media type.
            renew: Extend a live lease; false means it was lost.
            renewal_seconds: Interval shorter than the owning lease lifetime.
            resolve: Owner-checked file resolution for short reads without retention.

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
        self._resolve = resolve
        self._verification_slots = asyncio.Semaphore(2)
        self._pending_verifications: dict[tuple[object, ...], _PendingVerification] = {}

    async def resolve(
        self, owner: str, run_id: str, file_id: str
    ) -> ResolvedSourceFile:
        """Authorize a short read without hashing or retaining the entire file.

        The file's owner confines its path and checks current access and expiry.
        Consumers handle an unavailable file if cleanup races the subsequent read.

        Args:
            owner: Server-derived session hash.
            run_id: Opaque run identity.
            file_id: Opaque immutable file identity.

        Returns:
            Current original-file location and its publication metadata.

        Raises:
            SourceFileError: If short-read resolution or the file is unavailable.
        """
        if self._resolve is None:
            raise SourceFileError(
                "This source does not support interactive reads.", 404
            )
        return await self._resolve(owner, run_id, file_id)

    async def _acquire_read_lease(
        self, owner: str, run_id: str, file_id: str
    ) -> LeasedSourceFile:
        """Acquire a read lease and release it if the request is cancelled meanwhile.

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

    async def _verify(
        self, owner: str, run_id: str, file_id: str, source: LeasedSourceFile
    ) -> tuple[int, int, int, int, int]:
        """Share an unfinished checksum scan between matching authorized requests.

        Each caller retains its own admission slot and renewable lease. Completed
        scans are never reused. The final departing caller stops native work
        before releasing its slot; another caller's cancellation leaves the scan
        protected by the remaining caller's lease.

        Args:
            owner: Server-derived requesting session hash.
            run_id: Opaque run identity already authorized by the source owner.
            file_id: Opaque file identity already authorized by the source owner.
            source: Independently leased file and its publication metadata.

        Returns:
            File metadata established by a complete successful checksum scan.

        Raises:
            SourceFileError: If admission, verification or its deadline fails.
            OSError: If the original file is unavailable.
            asyncio.CancelledError: After detaching or stopping the final scan.
        """
        if self._verification_slots.locked():
            raise SourceFileError("Source checks are busy. Try again shortly.", 429)
        async with self._verification_slots:
            key = (
                owner,
                run_id,
                file_id,
                source.path,
                source.size,
                source.sha256,
                source.media_type,
                file_identity(source.path),
            )
            pending = self._pending_verifications.get(key)
            if pending is None or pending.task.done():
                pending = _PendingVerification(
                    asyncio.create_task(
                        run_bounded_process(
                            verify_source_file,
                            (source.path, source.size, source.sha256),
                            30,
                        )
                    )
                )
                self._pending_verifications[key] = pending
            pending.callers += 1
            try:
                verified_identity = await asyncio.shield(pending.task)
            except ProcessDeadlineError as error:
                raise SourceFileError(
                    "The source check took too long. Try a smaller file.", 504
                ) from error
            finally:
                pending.callers -= 1
                if pending.callers == 0:
                    if self._pending_verifications.get(key) is pending:
                        del self._pending_verifications[key]
                    if not pending.task.done():
                        pending.task.cancel()
                    await finish_source_task(pending.task)
            if verified_identity is None:
                raise SourceFileError(
                    "The source file changed and is no longer valid.", 422
                )
            return verified_identity

    @asynccontextmanager
    async def open(
        self, owner: str, run_id: str, file_id: str
    ) -> AsyncIterator[LeasedSourceFile]:
        """Verify, retain and reauthorize one file around a complete consumer read.

        Consumers must finish or stop their native work before leaving this scope.
        Checksums admit two requests and have a 30-second hard deadline.
        Matching requests can share an unfinished scan, with independent leases.
        Renewal failure cancels the consumer; successful delivery rechecks access
        and metadata. Authorization and completed checksum results are never cached.

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
        source = await self._acquire_read_lease(owner, run_id, file_id)
        reader_task = asyncio.current_task()
        lease_lost = False

        async def renew_lease_while_reading() -> None:
            """Renew cleanup protection periodically, cancelling the reader on failure."""
            nonlocal lease_lost
            try:
                while True:
                    await asyncio.sleep(self.renewal_seconds)
                    if not await self.renew(source.lease_id):
                        raise SourceFileError("The source file is no longer available.")
            except Exception:
                lease_lost = True
                reader_task.cancel()

        lease_renewal_task = asyncio.create_task(renew_lease_while_reading())
        try:
            verified_file_identity = await self._verify(owner, run_id, file_id, source)
            if file_identity(source.path) != verified_file_identity:
                raise SourceFileError(
                    "The source file changed and is no longer valid.", 422
                )
            yield source
            # A consumer may shield its final native cleanup from cancellation.
            # Renewal loss still forbids delivery even if that cleanup consumed
            # the cancellation raised by the heartbeat.
            if lease_lost:
                raise SourceFileError("The source file is no longer available.")
            current_file_metadata = await self.check(owner, run_id, file_id)
            if (
                current_file_metadata != (source.size, source.sha256, source.media_type)
                or file_identity(source.path) != verified_file_identity
            ):
                raise SourceFileError(
                    "The source file changed while it was being read.", 422
                )
        except asyncio.CancelledError:
            if lease_lost:
                raise SourceFileError(
                    "The source file is no longer available."
                ) from None
            raise
        except OSError as error:
            raise SourceFileError(
                "The source file is no longer available.", 410
            ) from error
        finally:
            lease_renewal_task.cancel()
            await finish_source_task(lease_renewal_task)
            await finish_source_task(asyncio.create_task(self.release(source.lease_id)))
