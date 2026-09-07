"""Spawn and supervise one native operation without depending on its owner."""

import asyncio
from collections.abc import Callable
from multiprocessing import get_context
from multiprocessing.connection import Connection
import signal
import time
from typing import Any


class ProcessDeadlineError(TimeoutError):
    """The child failed to deliver a result before its hard deadline."""


class ProcessResultWriter:
    """Queue-compatible one-result writer with no inherited parent write handle."""

    def __init__(self, connection: Connection) -> None:
        """Wrap the child-only sending endpoint.

        Args:
            connection: Writable end of the supervisor's one-way pipe.
        """
        self.connection = connection

    def put(self, value: Any) -> None:
        """Send a picklable result while the parent concurrently consumes it.

        Args:
            value: Owner-defined success or sanitized failure envelope.
        """
        self.connection.send(value)


def _run_target(
    target: Callable[..., None],
    connection: Connection,
    arguments: tuple[Any, ...],
    deadline: float,
) -> None:
    """Keep a Linux child deadline even if its supervising worker dies abruptly.

    Args:
        target: Importable native operation, independent of application services.
        connection: Child-owned result pipe endpoint.
        arguments: Picklable operation arguments.
        deadline: Parent's absolute monotonic deadline, including child startup.
    """
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        if hasattr(signal, "setitimer"):
            signal.signal(signal.SIGALRM, signal.SIG_DFL)
            signal.setitimer(signal.ITIMER_REAL, remaining)
        target(ProcessResultWriter(connection), *arguments)
    finally:
        connection.close()


async def run_bounded_process(
    target: Callable[..., None],
    arguments: tuple[Any, ...],
    timeout_seconds: float,
) -> Any:
    """Run a queue-writing target and reclaim the child before returning.

    The target receives a single-result writer before its supplied arguments.
    Its owner defines the result/error envelope. Read the queue before joining
    so even a large result cannot deadlock the child's pipe writer. Cancellation
    terminates native work and waits for exit before releasing capacity.

    Args:
        target: Importable, picklable lower-level native-operation target.
        arguments: Picklable target arguments, excluding the result queue.
        timeout_seconds: Positive deadline including process startup and exit.

    Returns:
        The target's picklable result envelope.

    Raises:
        ProcessDeadlineError: If the target times out or exits without a result.
        asyncio.CancelledError: After stopping the child on caller cancellation.
    """
    if timeout_seconds <= 0:
        raise ValueError("Processing timeout must be greater than zero")
    context = get_context("spawn")
    reader, writer = context.Pipe(duplex=False)
    deadline = time.monotonic() + timeout_seconds
    process = context.Process(
        target=_run_target, args=(target, writer, arguments, deadline), daemon=True
    )
    try:
        process.start()
        # The parent must not retain a sending endpoint: a child that dies
        # halfway through a payload must produce EOF, not an endless read.
        # The async deadline covers the entire payload receive.
        writer.close()
        try:
            async with asyncio.timeout(max(0, deadline - time.monotonic())):
                result = await asyncio.to_thread(reader.recv)
        except (TimeoutError, EOFError, OSError) as error:
            raise ProcessDeadlineError from error
        await asyncio.to_thread(
            process.join, min(1, max(0, deadline - time.monotonic()))
        )
        return result
    finally:
        # No await inside cleanup: an additional cancellation must not release
        # admission while the native child is still running. These joins have
        # bounded grace; SIGKILL follows SIGTERM if native code ignores it.
        if process.pid is not None:
            if process.is_alive():
                process.terminate()
                process.join(2)
            if process.is_alive():
                process.kill()
                process.join()
            process.close()
        writer.close()
        reader.close()
