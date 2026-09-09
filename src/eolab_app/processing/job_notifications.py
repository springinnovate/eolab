"""PostgreSQL queue-change hints; durable admission and claims remain in storage."""

import asyncio
import logging
import time

import psycopg
from psycopg import sql

LOGGER = logging.getLogger(__name__)
JOB_QUEUE_CHANNEL = "eolab_processing_jobs"


class PostgresJobWakeup:
    """Keep one dedicated listener and coalesce notifications into one wakeup bit."""

    def __init__(self, conninfo: str = "") -> None:
        """Configure a listener without opening a connection.

        Args:
            conninfo: Processing database connection, or the deployment PG* settings.
        """
        self.conninfo = conninfo
        self.pending = asyncio.Event()
        self.reader: asyncio.Task[None] | None = None
        self.connection: psycopg.AsyncConnection | None = None
        self.retry_after = 0.0

    async def arm(self) -> None:
        """Clear old hints and commit LISTEN before the next durable queue check.

        Connection failures leave polling available and retry at most every five
        seconds. A hint arriving after this call remains set throughout the claim.
        """
        self.pending.clear()
        if self.reader is not None:
            if not self.reader.done():
                return
            await self.reader
            self.reader = None
        if time.monotonic() < self.retry_after:
            return
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
                    sql.SQL("LISTEN {}").format(sql.Identifier(JOB_QUEUE_CHANNEL))
                )
            self.connection = connection
            self.reader = asyncio.create_task(self._listen(connection))
            connection = None  # The reader now owns and closes this connection.
        except (psycopg.Error, OSError, TimeoutError):
            self._retry_later()
        finally:
            if connection is not None:
                await connection.close()

    def _retry_later(self) -> None:
        """Rate-limit reconnects without logging connection strings or payloads."""
        self.retry_after = time.monotonic() + 5
        LOGGER.warning("Processing queue notifications unavailable; using polling")

    async def _listen(self, connection: psycopg.AsyncConnection) -> None:
        """Drain hints continuously, including while the worker executes a job.

        Args:
            connection: Dedicated autocommit connection with LISTEN committed.
        """
        try:
            async for _ in connection.notifies():
                self.pending.set()
        except (psycopg.Error, OSError):
            self._retry_later()
        finally:
            await connection.close()
            self.pending.set()

    async def wait(self, timeout: float) -> bool:
        """Wait for a queue hint, falling back to a bounded polling interval.

        Args:
            timeout: Maximum idle seconds before another durable claim check.

        Returns:
            True for a hint or listener disconnect; False for a polling timeout.
        """
        try:
            async with asyncio.timeout(timeout):
                await self.pending.wait()
            return True
        except TimeoutError:
            return False

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
