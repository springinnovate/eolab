"""Queue wakeup races, fallback, reconnect and shutdown at the worker boundary."""

import asyncio
from unittest.mock import AsyncMock, Mock

import psycopg
import pytest

from eolab_app.processing.job_notifications import PostgresJobWakeup
from eolab_app.processing.worker import serve


class Connection:
    """Controllable notification transport, independent of job-store decisions."""

    def __init__(self) -> None:
        """Create a transport with observable registration and closure."""
        self.messages = asyncio.Queue()
        self.execute = AsyncMock()
        self.close = AsyncMock()

    async def notifies(self):
        """Yield test hints or simulate a broken database connection.

        Yields:
            Opaque hints, never interpreted as permission to execute a job.
        """
        while True:
            value = await self.messages.get()
            if isinstance(value, Exception):
                raise value
            yield value


def test_listener_registers_before_check_and_retains_racing_hints(monkeypatch):
    """Cover a notification between an empty claim and entry into idle wait.

    Args:
        monkeypatch: Replace the database transport, not the worker workflow.
    """

    async def scenario():
        """Exercise the composed worker against an asynchronous transport."""
        connection = Connection()
        connect = AsyncMock(return_value=connection)
        monkeypatch.setattr(psycopg.AsyncConnection, "connect", connect)
        wakeup = PostgresJobWakeup()
        checked = 0

        async def claim():
            """Simulate a commit racing with the first empty queue check."""
            nonlocal checked
            connection.execute.assert_awaited_once()
            checked += 1
            if checked == 1:
                await connection.messages.put(object())
                return False
            raise asyncio.CancelledError

        worker = Mock(cleanup=AsyncMock(), run_once=claim)
        with pytest.raises(asyncio.CancelledError):
            async with asyncio.timeout(0.5):
                await serve(worker, wakeup)
        assert checked == 2
        assert wakeup.reader is None
        assert connection.close.await_count >= 1
        assert connect.call_args.kwargs["autocommit"] is True

    asyncio.run(scenario())


def test_notifications_coalesce_and_missing_hints_time_out(monkeypatch):
    """Drain bursts during work without retaining payloads or spinning afterwards.

    Args:
        monkeypatch: Replace the asynchronous PostgreSQL connection.
    """

    async def scenario():
        """Verify one pending wakeup and the fallback polling timeout."""
        connection = Connection()
        monkeypatch.setattr(
            psycopg.AsyncConnection, "connect", AsyncMock(return_value=connection)
        )
        wakeup = PostgresJobWakeup()
        await wakeup.arm()
        try:
            for _ in range(100):
                connection.messages.put_nowait(object())
            await asyncio.sleep(0)
            assert connection.messages.empty()
            assert await wakeup.wait(0.01)
            await wakeup.arm()
            assert not await wakeup.wait(0.01)
            assert wakeup.reader is not None and not wakeup.reader.done()
        finally:
            await wakeup.close()

    asyncio.run(scenario())


def test_listener_failure_keeps_polling_and_reconnects(monkeypatch):
    """Both failed startup and a dropped listener leave bounded polling usable.

    Args:
        monkeypatch: Control connection establishment and failure.
    """

    async def scenario():
        """Fail, poll, reconnect, disconnect, then register again."""
        first, second = Connection(), Connection()
        connect = AsyncMock(
            side_effect=[psycopg.OperationalError("unavailable"), first, second]
        )
        monkeypatch.setattr(psycopg.AsyncConnection, "connect", connect)
        wakeup = PostgresJobWakeup()
        await wakeup.arm()
        assert not await wakeup.wait(0.01)
        await wakeup.arm()
        assert connect.await_count == 1, "reconnects must be rate limited"
        wakeup.retry_after = 0
        await wakeup.arm()
        first.messages.put_nowait(psycopg.OperationalError("connection lost"))
        assert await wakeup.wait(0.5)
        await wakeup.arm()
        assert connect.await_count == 2
        wakeup.retry_after = 0
        await wakeup.arm()
        assert connect.await_count == 3
        await second.messages.put(object())
        assert await wakeup.wait(0.5)
        await wakeup.close()
        assert first.close.await_count >= 1 and second.close.await_count >= 1

    asyncio.run(scenario())


@pytest.mark.parametrize("during_registration", [False, True])
def test_shutdown_closes_even_before_reader_starts(monkeypatch, during_registration):
    """Cancellation must not leak a connection before the reader's first await.

    Args:
        monkeypatch: Replace the asynchronous PostgreSQL connection.
        during_registration: Cancel LISTEN or close immediately after registration.
    """

    async def scenario():
        """Stop at either connection ownership handoff."""
        connection = Connection()
        if during_registration:
            connection.execute.side_effect = asyncio.CancelledError
        monkeypatch.setattr(
            psycopg.AsyncConnection, "connect", AsyncMock(return_value=connection)
        )
        wakeup = PostgresJobWakeup()
        if during_registration:
            with pytest.raises(asyncio.CancelledError):
                await wakeup.arm()
        else:
            await wakeup.arm()
        await wakeup.close()
        connection.close.assert_awaited_once()

    asyncio.run(scenario())


def test_worker_drains_queued_work_serially_and_only_waits_when_idle():
    """Hints cannot create extra execution slots or skip durable claims."""

    async def scenario():
        """Drain two jobs, then exercise fallback without a real two-second delay."""
        wakeup = Mock(
            arm=AsyncMock(),
            wait=AsyncMock(side_effect=asyncio.CancelledError),
            close=AsyncMock(),
        )
        worker = Mock(
            cleanup=AsyncMock(), run_once=AsyncMock(side_effect=[True, True, False])
        )
        with pytest.raises(asyncio.CancelledError):
            await serve(worker, wakeup)
        assert worker.run_once.await_count == 3
        assert wakeup.arm.await_count == 3
        wakeup.wait.assert_awaited_once_with(2)
        wakeup.close.assert_awaited_once()

    asyncio.run(scenario())
