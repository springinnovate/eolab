"""Neutral ASGI disconnect coordination for cancellable HTTP work."""

import asyncio
from collections.abc import Awaitable
from typing import TypeVar

from fastapi import Request


_Result = TypeVar("_Result")


class HttpClientDisconnectedError(Exception):
    """Signal that the request client disconnected before work completed."""


async def wait_for_http_disconnect(request: Request) -> None:
    """Wait until the ASGI server reports that the client disconnected.

    Args:
        request: Incoming request whose connection owns cancellable work.

    Returns:
        None after an ``http.disconnect`` message arrives.
    """
    while (message := await request.receive())["type"] != "http.disconnect":
        pass


async def run_until_http_disconnect(
    request: Request,
    operation: Awaitable[_Result],
) -> _Result:
    """Return cancellable work unless its requesting client disconnects first.

    Args:
        request: Incoming request whose connection owns the work.
        operation: Awaitable operation to cancel after a disconnect.

    Returns:
        The operation result when it completes before disconnection.

    Raises:
        HttpClientDisconnectedError: If the request connection closes first.
    """
    operation_task = asyncio.ensure_future(operation)
    disconnect_task = asyncio.create_task(wait_for_http_disconnect(request))
    try:
        completed_tasks, _ = await asyncio.wait(
            (operation_task, disconnect_task),
            return_when=asyncio.FIRST_COMPLETED,
        )
        if operation_task in completed_tasks:
            return operation_task.result()
        raise HttpClientDisconnectedError
    finally:
        disconnect_task.cancel()
        operation_task.cancel()
        await asyncio.gather(
            operation_task,
            disconnect_task,
            return_exceptions=True,
        )
