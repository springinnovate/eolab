"""Hard-deadline process boundary for untrusted GDAL operations."""

import asyncio
from multiprocessing import get_context
from multiprocessing.queues import Queue
from queue import Empty
from typing import Any, Literal

from eolab_app.temporary_aoi.errors import (
    TemporaryAoiError,
    TemporaryAoiRequestError,
    TemporaryAoiTooLargeError,
    TemporaryAoiValidationError,
)
from eolab_app.temporary_aoi.models import DatasetChoice
from eolab_app.temporary_aoi.validation import (
    discover_dataset_choices,
    read_browser_geometry,
)


ProcessingOperation = Literal["discover", "geometry"]


def _processing_worker(
    result_queue: Queue[Any],
    operation: ProcessingOperation,
    arguments: tuple[Any, ...],
) -> None:
    """Execute one picklable validation operation in an isolated process.

    Args:
        result_queue: Single-result queue owned by the parent process.
        operation: Explicit allowlisted validation operation.
        arguments: Picklable positional arguments for the operation.

    Returns:
        None after publishing one success or sanitized failure result.
    """
    try:
        if operation == "discover":
            value = discover_dataset_choices(*arguments)
        elif operation == "geometry":
            value = read_browser_geometry(*arguments)
        else:
            raise ValueError("Unsupported temporary AOI processing operation")
    except TemporaryAoiError as error:
        result_queue.put(("application-error", type(error).__name__, error.detail))
    except Exception:
        result_queue.put(("unexpected-error", "", ""))
    else:
        result_queue.put(("success", "", value))


async def run_bounded_operation(
    operation: ProcessingOperation,
    arguments: tuple[Any, ...],
    timeout_seconds: float,
) -> Any:
    """Run one GDAL operation and terminate it at a hard wall-time limit.

    A dedicated spawned process makes the processing deadline enforceable:
    cancelling a thread cannot stop native GDAL work or make immediate file
    cleanup safe, while terminating this isolated worker can.

    Args:
        operation: Explicit allowlisted validation operation.
        arguments: Picklable operation arguments.
        timeout_seconds: Positive hard wall-time limit including process start.

    Returns:
        Picklable validated operation result.

    Raises:
        TemporaryAoiValidationError: If processing times out, the worker exits
            without a result, or an unexpected validation dependency fails.
        TemporaryAoiRequestError: If the worker reports a request failure.
        TemporaryAoiTooLargeError: If the worker reports a resource failure.
    """
    if timeout_seconds <= 0:
        raise ValueError("Processing timeout must be greater than zero")
    process_context = get_context("spawn")
    result_queue = process_context.Queue(maxsize=1)
    process = process_context.Process(
        target=_processing_worker,
        args=(result_queue, operation, arguments),
        daemon=True,
    )
    process.start()
    try:
        try:
            status, error_type, payload = await asyncio.to_thread(
                result_queue.get,
                True,
                timeout_seconds,
            )
        except (Empty, EOFError, OSError) as error:
            process.terminate()
            await asyncio.to_thread(process.join)
            raise TemporaryAoiValidationError(
                f"AOI {operation} processing exceeded the "
                f"{timeout_seconds:g}-second limit"
            ) from error
        await asyncio.to_thread(process.join, 1)
        if process.is_alive():
            process.terminate()
            await asyncio.to_thread(process.join)
    finally:
        if process.is_alive():
            process.terminate()
            await asyncio.to_thread(process.join)
        result_queue.close()
        result_queue.join_thread()

    if status == "success":
        return payload
    known_errors: dict[str, type[TemporaryAoiError]] = {
        "TemporaryAoiRequestError": TemporaryAoiRequestError,
        "TemporaryAoiTooLargeError": TemporaryAoiTooLargeError,
        "TemporaryAoiValidationError": TemporaryAoiValidationError,
    }
    if status == "application-error" and error_type in known_errors:
        raise known_errors[error_type](payload)
    raise TemporaryAoiValidationError(
        "The uploaded AOI could not be processed safely"
    )
