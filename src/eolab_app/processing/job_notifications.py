"""PostgreSQL queue-change hints; durable admission and claims remain in storage."""

import asyncio
from collections.abc import Callable
import logging
import time

import psycopg
from psycopg import sql

LOGGER = logging.getLogger(__name__)
JOB_QUEUE_CHANNEL = "eolab_processing_jobs"
JOB_CHANGE_CHANNEL = "eolab_processing_job_changes"


class PostgresNotifications:
    """Bounded PostgreSQL listener shared by queue wakeup and owned-job updates."""

    def __init__(
        self, channel: str, receive: Callable[[str | None], None], conninfo: str = ""
    ) -> None:
        """Configure a listener without opening a connection.

        Args:
            channel: Processing-owned notification channel.
            receive: Consume payloads synchronously; None signals a disconnect.
            conninfo: Processing database connection, or the deployment PG* settings.
        """
        self.conninfo = conninfo
        self.channel = channel
        self.receive = receive
        self.reader: asyncio.Task[None] | None = None
        self.connection: psycopg.AsyncConnection | None = None
        self.retry_after = 0.0

    async def ensure_connected(self) -> bool:
        """Commit LISTEN before the caller checks durable state.

        Connection failures leave polling available and retry at most every five
        seconds. A hint arriving after this call remains set throughout the claim.

        Returns:
            True only when a new connection was registered successfully.
        """
        if self.reader is not None:
            if not self.reader.done():
                return False
            await self.reader
            self.reader = None
        if time.monotonic() < self.retry_after:
            return False
        connection = None
        try:
            async with asyncio.timeout(3):
                connection = await psycopg.AsyncConnection.connect(
                    self.conninfo,
                    autocommit=True,
                    connect_timeout=3,
                    options="-c statement_timeout=3000",
                )
                await connection.execute(
                    sql.SQL("LISTEN {}").format(sql.Identifier(self.channel))
                )
            self.connection = connection
            self.reader = asyncio.create_task(self._listen(connection))
            connection = None  # The reader now owns and closes this connection.
            return True
        except (psycopg.Error, OSError, TimeoutError):
            self._retry_later()
        finally:
            if connection is not None:
                await connection.close()
        return False

    def _retry_later(self) -> None:
        """Rate-limit reconnects without logging connection strings or payloads."""
        self.retry_after = time.monotonic() + 5
        LOGGER.warning("Processing notifications unavailable; using polling")

    async def _listen(self, connection: psycopg.AsyncConnection) -> None:
        """Drain hints continuously, including while the worker executes a job.

        Args:
            connection: Dedicated autocommit connection with LISTEN committed.
        """
        try:
            async for notification in connection.notifies():
                self.receive(getattr(notification, "payload", ""))
        except (psycopg.Error, OSError):
            self._retry_later()
        finally:
            await connection.close()
            self.receive(None)

    async def close(self) -> None:
        """Join the notification reader and close its connection on shutdown."""
        if self.reader is not None:
            self.reader.cancel()
            await asyncio.gather(self.reader, return_exceptions=True)
            self.reader = None
        # Cancellation can happen before the reader's coroutine starts.
        if self.connection is not None:
            await self.connection.close()
            self.connection = None


class PostgresJobWakeup(PostgresNotifications):
    """Keep the existing worker's coalesced queue hint and polling fallback."""

    def __init__(self, conninfo: str = "") -> None:
        """Configure the worker listener without opening a connection.

        Args:
            conninfo: Processing database connection or deployment PG* settings.
        """
        self.pending = asyncio.Event()
        super().__init__(JOB_QUEUE_CHANNEL, lambda _: self.pending.set(), conninfo)

    async def arm(self) -> None:
        """Clear old hints before registration and the durable claim check."""
        self.pending.clear()
        await self.ensure_connected()

    async def wait(self, timeout: float) -> bool:
        """Wait for a queue hint, falling back to bounded polling.

        Args:
            timeout: Maximum idle seconds before checking durable admission.

        Returns:
            True for a hint/disconnect, False for a polling timeout.
        """
        try:
            async with asyncio.timeout(timeout):
                await self.pending.wait()
            return True
        except TimeoutError:
            return False
