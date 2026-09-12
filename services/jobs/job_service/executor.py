"""One supervised subprocess invocation with bounded transfer and hard stopping."""

import asyncio
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from pydantic import JsonValue

from job_service.models import JobStatus
from job_service.runner import MAX_MESSAGE_BYTES


@dataclass(frozen=True)
class ExecutionResult:
    """Terminal execution status and value after the child has been reaped.

    This internal result includes cancellation/failure. The public JobResult in
    models.py instead represents a retained successful result with a job ID."""

    status: JobStatus
    value: JsonValue = None


async def run_job(
    payload: bytes, cancel: asyncio.Event, timeout: float
) -> ExecutionResult:
    """Execute one installed operation, returning only after process exit.

    Args:
        payload: Validated serialized operation invocation.
        cancel: Supervisor cancellation signal; cancellation wins while observed
            before completion is published.
        timeout: Deadline including process startup and result transfer.

    Returns:
        Succeeded, failed, cancelled or timed_out outcome. No raw child errors.

    Raises:
        asyncio.CancelledError: If the supervisor task itself is cancelled;
            child cleanup still completes before propagating cancellation.
    """
    process = None
    exchange_task = None
    cancel_task = None
    spawn_task = None
    try:
        async with asyncio.timeout(timeout):
            # Strip service credentials from the child. The operation has no
            # source mounts, networking API, or configurable executable path.
            environment = {
                key: value
                for key, value in os.environ.items()
                if key in {"PATH", "SystemRoot", "WINDIR", "LANG", "LC_ALL"}
            }
            environment["PYTHONDONTWRITEBYTECODE"] = "1"
            spawn_task = asyncio.create_task(
                asyncio.create_subprocess_exec(
                    sys.executable,
                    "-m",
                    "job_service.runner",
                    cwd=Path(__file__).resolve().parent.parent,
                    env=environment,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                )
            )
            process = await asyncio.shield(spawn_task)

            async def exchange() -> bytes:
                """Send bounded input and read one bounded reply through EOF.

                Returns:
                    Reply bytes after successful process exit.

                Raises:
                    ValueError: For oversized output or nonzero exit.
                """
                process.stdin.write(payload)
                await process.stdin.drain()
                process.stdin.close()
                output = bytearray()
                while chunk := await process.stdout.read(
                    MAX_MESSAGE_BYTES + 1 - len(output)
                ):
                    output.extend(chunk)
                    if len(output) > MAX_MESSAGE_BYTES:
                        raise ValueError("Oversized operation output")
                if await process.wait() != 0:
                    raise ValueError("Invalid operation output")
                return bytes(output)

            exchange_task = asyncio.create_task(exchange())
            cancel_task = asyncio.create_task(cancel.wait())
            await asyncio.wait(
                (exchange_task, cancel_task), return_when=asyncio.FIRST_COMPLETED
            )
            if cancel.is_set():
                return ExecutionResult("cancelled")
            reply = json.loads(exchange_task.result())
            if not isinstance(reply, dict) or reply.get("ok") is not True:
                return ExecutionResult("failed")
            return ExecutionResult("succeeded", reply["value"])
    except TimeoutError:
        return ExecutionResult("cancelled" if cancel.is_set() else "timed_out")
    except Exception:
        return ExecutionResult("failed")
    finally:
        # Hard stop is appropriate for the installed diagnostic operation. A
        # slot is never released on a cancellation request alone.
        if process is None and spawn_task is not None:
            # A deadline can fire while the OS creates the process. Recover the
            # handle even then, so an incompletely awaited spawn cannot orphan it.
            try:
                process = await asyncio.shield(spawn_task)
            except Exception:
                pass
        if process is not None:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            await process.wait()
        for task in (exchange_task, cancel_task):
            if task is not None:
                task.cancel()
        await asyncio.gather(
            *(task for task in (exchange_task, cancel_task) if task is not None),
            return_exceptions=True,
        )
