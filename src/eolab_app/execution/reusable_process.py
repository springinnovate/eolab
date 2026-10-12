"""Reuse a child process for sequential native operations with per-call deadlines."""

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from multiprocessing import get_context
from multiprocessing.connection import Connection
import pickle
import os
import signal
import sys
import time
from typing import Any

from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
    run_bounded_process,
    stop_if_parent_dies,
)


class _CapturedProcessResult:
    """Hold an operation's result until the function and its cleanup have finished."""

    def __init__(self) -> None:
        """Start with no emitted result."""
        self.values: list[Any] = []

    def put(self, value: Any) -> None:
        """Store the operation's single result for delivery after it returns.

        Args:
            value: Picklable operation result.

        Raises:
            RuntimeError: If the operation already supplied a result.
        """
        if self.values:
            raise RuntimeError("A native operation must return exactly one result")
        self.values.append(value)


def _run_target_and_collect_result(
    target: Callable[..., None], arguments: tuple[Any, ...]
) -> Any:
    """Call the operation and return its emitted result after its cleanup finishes.

    Args:
        target: Registered function accepting a result writer as its first argument.
        arguments: Operation arguments passed after the result writer.

    Returns:
        The value emitted by the operation through its result writer.

    Raises:
        RuntimeError: If the operation emits zero or more than one result.
    """
    result = _CapturedProcessResult()
    target(result, *arguments)
    if len(result.values) != 1:
        raise RuntimeError("Native operation returned no result")
    return result.values[0]


def _memory_exceeded(limit: int) -> bool:
    """Check this Linux worker's peak resident memory, excluding its parent.

    Linux getrusage() can carry the parent's peak RSS through fork/exec into a
    fresh interpreter. /proc/self/status reports the current program's VmHWM,
    so a large supervisor does not force a small worker to recycle every job.

    Args:
        limit: Peak resident bytes after which this process should be replaced.

    Returns:
        Whether this worker's peak RSS exceeds the recycling threshold. False
        on other platforms, which do not provide this Linux memory measurement.

    Raises:
        OSError: If Linux process-memory information cannot be read.
        ValueError: If the expected peak-memory field is absent or malformed.
    """
    if sys.platform != "linux":
        return False
    with open("/proc/self/status", encoding="ascii") as status:
        for line in status:
            if line.startswith("VmHWM:"):
                _, peak_kib, unit = line.split()
                if unit != "kB":
                    raise ValueError("Unexpected Linux peak-memory unit")
                return int(peak_kib) * 1024 > limit
    raise ValueError("Linux process status has no peak-memory field")


def _serve_process_requests(
    connection: Connection,
    targets: tuple[Callable[..., None], ...],
    recycle_bytes: int,
    address_space_bytes: int | None,
    parent_pid: int,
) -> None:
    """Execute requests sequentially in the child and send each completed result.

    Args:
        connection: Child-only endpoint; parent death produces EOF while idle.
        targets: Fixed preloaded entry points; requests select an index only.
        recycle_bytes: Linux peak-RSS threshold for between-job replacement.
        address_space_bytes: Optional Linux address-space ceiling including native
            libraries and preparation; other platforms retain container limits.
        parent_pid: Supervisor identity used to stop orphaned Linux native work.
    """
    try:
        stop_if_parent_dies(parent_pid)
        if address_space_bytes is not None and sys.platform == "linux":
            import resource

            _, hard = resource.getrlimit(resource.RLIMIT_AS)
            ceiling = (
                address_space_bytes
                if hard == resource.RLIM_INFINITY
                else min(address_space_bytes, hard)
            )
            resource.setrlimit(resource.RLIMIT_AS, (ceiling, ceiling))
        connection.send("ready")
        while True:
            sequence, index, arguments, deadline = connection.recv()
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return
                if hasattr(signal, "setitimer"):
                    signal.signal(signal.SIGALRM, signal.SIG_DFL)
                    signal.setitimer(signal.ITIMER_REAL, remaining)
            value = _run_target_and_collect_result(targets[index], arguments)
            recycle = _memory_exceeded(recycle_bytes)
            payload = pickle.dumps((sequence, value, recycle))
            del value, arguments
            connection.send_bytes(payload)
            del payload
            if hasattr(signal, "setitimer"):
                signal.setitimer(signal.ITIMER_REAL, 0)
            if recycle:
                return
    except (EOFError, BrokenPipeError):
        pass
    finally:
        connection.close()


def _exchange_process_request(
    connection: Connection, message: tuple[int, int, tuple[Any, ...], float | None]
) -> Any:
    """Send one operation request to the child and wait for its reply.

    Args:
        connection: Parent endpoint, exclusively held for this request.
        message: Request sequence, operation index, arguments and deadline.

    Returns:
        Child response after its target returned and request cleanup finished.
    """
    connection.send(message)
    return connection.recv()


@dataclass
class _ProcessConnection:
    """A child process, its communication pipe and the task waiting for readiness.

    Attributes:
        process: Spawned multiprocessing process running registered operations.
        connection: Parent endpoint of the bidirectional request/result pipe.
        startup: Task waiting for the child's initial readiness message.
    """

    process: Any
    connection: Connection
    startup: asyncio.Task[None] | None = None


class ReusableProcess:
    """Run one native operation at a time in a reusable child process.

    Concurrent calls are rejected rather than queued. Cancellation, failure or
    excessive memory use stops the child; a later call can use its replacement.
    """

    def __init__(
        self,
        targets: tuple[Callable[..., None], ...],
        *,
        recycle_bytes: int = 1024**3,
        startup_seconds: float = 15,
        address_space_bytes: int | None = None,
    ) -> None:
        """Configure registered operations and limits before starting a child.

        The process starts when warm() or run() is called.

        Args:
            targets: Fixed operation entry points imported before readiness.
            recycle_bytes: Linux peak-RSS recycling threshold, not an admission limit.
            startup_seconds: Maximum time to initialize a replacement process.
            address_space_bytes: Optional positive Linux address-space cap for
                every operation; None retains the existing OS limit.

        Raises:
            ValueError: If targets or process limits are invalid.
        """
        if not targets or recycle_bytes < 1 or startup_seconds <= 0:
            raise ValueError("Reusable process limits and targets must be positive")
        self.targets = targets
        self.recycle_bytes = recycle_bytes
        self.startup_seconds = startup_seconds
        if address_space_bytes is not None and address_space_bytes < 1:
            raise ValueError("Process address-space limit must be positive")
        self.address_space_bytes = address_space_bytes
        self.child: _ProcessConnection | None = None
        self.active: asyncio.Task | None = None
        self.closed = False
        self.sequence = 0

    def _stop_child_process(self, child: _ProcessConnection) -> None:
        """Stop this child and close its pipe before another operation can start.

        Args:
            child: Child to terminate and wait for; replaced children are ignored.
        """
        if self.child is not child:
            return
        self.child = None
        if child.startup and child.startup is not asyncio.current_task():
            child.startup.cancel()
        process = child.process
        if process.pid is not None:
            if process.is_alive():
                process.terminate()
                process.join(2)
            if process.is_alive():
                process.kill()
            process.join()
            process.close()
        child.connection.close()

    async def _wait_until_child_ready(self, child: _ProcessConnection) -> None:
        """Wait for the child's readiness message and stop it if startup fails.

        Args:
            child: Newly spawned process, exclusively owned until readiness.

        Raises:
            ProcessDeadlineError: If the child sends an unexpected startup message.
            TimeoutError: If startup takes longer than startup_seconds.
            EOFError: If the child closes its pipe before becoming ready.
            OSError: If the startup message cannot be read.
            asyncio.CancelledError: After stopping the child when startup is cancelled.
        """
        try:
            async with asyncio.timeout(self.startup_seconds):
                if await asyncio.to_thread(child.connection.recv) != "ready":
                    raise ProcessDeadlineError("Native process did not become ready")
        except BaseException:
            self._stop_child_process(child)
            raise

    def warm(self) -> None:
        """Prestart one child in the background without accepting any native work."""
        if self.closed or self.child is not None:
            return
        context = get_context("spawn")
        parent, child_pipe = context.Pipe(duplex=True)
        process = context.Process(
            target=_serve_process_requests,
            args=(
                child_pipe,
                self.targets,
                self.recycle_bytes,
                self.address_space_bytes,
                os.getpid(),
            ),
            daemon=True,
        )
        child = _ProcessConnection(process, parent)
        self.child = child
        try:
            process.start()
            child.startup = asyncio.create_task(self._wait_until_child_ready(child))
            # Background readiness failures are surfaced by run or replaced on
            # its next attempt; always retrieve them to avoid abandoned tasks.
            child.startup.add_done_callback(
                lambda task: None if task.cancelled() else task.exception()
            )
        except BaseException:
            self._stop_child_process(child)
            raise
        finally:
            child_pipe.close()

    async def run(
        self,
        target: Callable[..., None],
        arguments: tuple[Any, ...],
        timeout_seconds: float | None,
    ) -> Any:
        """Run a registered operation and stop its child if the call cannot finish.

        Args:
            target: One of the preloaded entry points.
            arguments: Immutable admitted operation inputs.
            timeout_seconds: Deadline including readiness, transfer and cleanup;
                None continues until completion, cancellation or process failure.

        Returns:
            The operation's result after its function and cleanup return.

        Raises:
            RuntimeError: If closed or another operation is using the child.
            ValueError: If the target or timeout is outside the configured contract.
            ProcessDeadlineError: If startup, transport or native execution fails.
            asyncio.CancelledError: Only after native exit is confirmed.
        """
        if self.closed or self.active is not None:
            raise RuntimeError("Native process lane is closed or already active")
        if target not in self.targets or (
            timeout_seconds is not None and timeout_seconds <= 0
        ):
            raise ValueError("Invalid native process target or deadline")
        self.active = asyncio.current_task()
        deadline = (
            None if timeout_seconds is None else time.monotonic() + timeout_seconds
        )
        child = None
        try:
            self.warm()
            child = self.child
            async with asyncio.timeout(timeout_seconds):
                await asyncio.shield(child.startup)
                self.sequence += 1
                response = await asyncio.to_thread(
                    _exchange_process_request,
                    child.connection,
                    (self.sequence, self.targets.index(target), arguments, deadline),
                )
                sequence, value, recycle = response
                if sequence != self.sequence:
                    raise ProcessDeadlineError(
                        "Native response did not match its request"
                    )
                if recycle:
                    self._stop_child_process(child)
                return value
        except asyncio.CancelledError:
            if child is not None:
                self._stop_child_process(child)
            raise
        except (TimeoutError, EOFError, OSError, ValueError) as error:
            if child is not None:
                self._stop_child_process(child)
            raise ProcessDeadlineError(
                "Native process failed or exceeded its deadline"
            ) from error
        except BaseException:
            if child is not None:
                self._stop_child_process(child)
            raise
        finally:
            self.active = None
            if not self.closed and self.child is None:
                asyncio.get_running_loop().call_soon(self.warm)

    async def close(self) -> None:
        """Stop startup or active work and prevent any replacement on shutdown."""
        self.closed = True
        active, child = self.active, self.child
        if active and active is not asyncio.current_task():
            active.cancel()
        if child is not None:
            self._stop_child_process(child)
        pending = [
            task
            for task in (active, child.startup if child else None)
            if task is not None and task is not asyncio.current_task()
        ]
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)


async def run_process(
    target: Callable[..., None],
    arguments: tuple[Any, ...],
    timeout_seconds: float | None,
    reusable: ReusableProcess | None = None,
) -> Any:
    """Run an operation in the supplied reusable process or a new child process.

    Args:
        target: Owner-supplied operation entry point.
        arguments: Admitted native inputs.
        timeout_seconds: Complete operation deadline, or None to run until
            completion, cancellation or process failure.
        reusable: Lifecycle-managed warm process supplied by composition, if any.

    Returns:
        The operation's emitted result after native cleanup.

    Raises:
        RuntimeError: If the supplied reusable process is closed or already active.
        ValueError: If the target or deadline is invalid.
        ProcessDeadlineError: If native execution fails or exceeds its deadline.
        asyncio.CancelledError: Only after native exit is confirmed.
    """
    if reusable is not None:
        return await reusable.run(target, arguments, timeout_seconds)
    return await run_bounded_process(target, arguments, timeout_seconds)
