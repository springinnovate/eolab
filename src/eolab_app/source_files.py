"""Keep authorized immutable files available until their readers have stopped."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol


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
    """Authorize file reads and renew cleanup protection for long-running readers.

    Storage callbacks check access and manage leases. Short reads use resolve()
    without a lease; open() protects the file until the reader finishes.
    Published contents and metadata are immutable and are not reverified.
    """

    def __init__(
        self,
        acquire: Callable[[str, str, str], Awaitable[LeasedSourceFile]],
        release: Callable[[str], Awaitable[bool]],
        check: Callable[[str, str, str], Awaitable[None]],
        renew: Callable[[str], Awaitable[bool]],
        *,
        renewal_seconds: float = 10,
        resolve: Callable[[str, str, str], Awaitable[ResolvedSourceFile]] | None = None,
    ) -> None:
        """Configure storage callbacks for authorization and temporary read leases.

        Args:
            acquire: Authorize owner and opaque source identities, acquiring a lease.
            release: Release a lease after all owned native work stops.
            check: Reauthorize the file's ownership and availability before delivery.
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

    @asynccontextmanager
    async def open(
        self, owner: str, run_id: str, file_id: str
    ) -> AsyncIterator[LeasedSourceFile]:
        """Retain and reauthorize one immutable file around a complete consumer read.

        Consumers must finish or stop their native work before leaving this scope.
        Renewal failure cancels the consumer; successful delivery rechecks access.
        The consumer owns its read limits and reports actual file-read failures.

        Args:
            owner: Requesting session hash, never a client-supplied owner name.
            run_id: Opaque run identity.
            file_id: Opaque immutable file identity.

        Yields:
            Published immutable file protected by a renewable lease.

        Raises:
            SourceFileError: If the lease is lost or the consumer cannot read the file.
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
            yield source
            # A consumer may shield its final native cleanup from cancellation.
            # Renewal loss still forbids delivery even if that cleanup consumed
            # the cancellation raised by the heartbeat.
            if lease_lost:
                raise SourceFileError("The source file is no longer available.")
            await self.check(owner, run_id, file_id)
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
