"""Submit operations to the Job service and monitor, cancel or delete their jobs."""

import asyncio
import json
import logging
import math
import re
from typing import Any, Literal
from uuid import UUID, uuid4

import httpx2
from pydantic import BaseModel, JsonValue

JOBS_URL = "http://jobs:8080/api/jobs"
MAX_REQUEST_BYTES = 65536
MAX_RESPONSE_BYTES = 512 * 1024
CLEANUP_SECONDS = 5
CLEANUP_RETRY_MAX_SECONDS = 2
# Poll every 100 ms so short outline jobs can appear promptly in the viewer.
POLL_SECONDS = 0.1
TERMINAL = frozenset({"succeeded", "failed", "cancelled", "timed_out", "expired"})
logger = logging.getLogger(__name__)


def _admission_was_rejected(error: httpx2.HTTPStatusError, *, uncertain: bool) -> bool:
    """Identify an admission response proving this request has no active job.

    Args:
        error: Error from the original submission or its identical-key recovery.
        uncertain: Whether an earlier reply was lost. Later authorization failures
            cannot rule out earlier admission; a capacity rejection can because
            the Jobs service checks existing idempotency keys before capacity.

    Returns:
        Whether cleanup can stop without retaining caller resources.
    """
    status = error.response.status_code
    if not uncertain and 400 <= status < 500 and status != 408:
        return True
    if status == 503:
        try:
            return error.response.json()["error"]["code"] == "capacity"
        except (ValueError, KeyError, TypeError):
            pass
    return False


class JobSnapshot(BaseModel):
    """Validate a server reply's job UUID, known status and optional error object.

    model_validate() converts the decoded JSON object into this typed snapshot
    and rejects missing or invalid fields. Extra server metadata is ignored.
    This does not validate an operation's result; that remains caller-owned.
    """

    jobId: UUID
    status: Literal[
        "queued",
        "running",
        "cancelling",
        "succeeded",
        "failed",
        "cancelled",
        "timed_out",
        "expired",
    ]
    error: dict[str, JsonValue] | None = None


class JobResult(BaseModel):
    """A job identifier and its JSON result, which the calling operation validates."""

    jobId: UUID
    value: JsonValue


class JobFailed(RuntimeError):
    """An unsuccessful terminal state, retained in snapshot for caller handling."""

    def __init__(self, snapshot: JobSnapshot) -> None:
        """Capture failure without reflecting submitted inputs.

        Args:
            snapshot: Terminal state returned by the service.
        """
        self.snapshot = snapshot
        super().__init__(f"Job {snapshot.jobId} ended with status {snapshot.status}")


class JobsClient:
    """Submit and manage jobs through a caller-supplied HTTP client.

    Low-level methods leave job lifetime to the caller. run() owns one submission
    through completion and cancels abandoned work. No queue or background observer
    survives a completed run(). HTTP failures raise httpx2.HTTPError; invalid
    protocol responses raise ValueError. The calling feature translates these
    failures into its own user-facing errors.
    """

    def __init__(
        self,
        client: httpx2.AsyncClient,
        token: str,
    ) -> None:
        """Bind transport and credentials for the internal Compose Jobs service.

        Args:
            client: Dedicated HTTP pool, closed by its composition owner.
            token: Private caller credential, never an operation input.
        """
        self.client = client
        self._token = token

    async def _request(
        self,
        method: str,
        suffix: str,
        *,
        body: bytes | None = None,
        key: str | None = None,
    ) -> dict[str, Any]:
        """Send a Job service request and read at most MAX_RESPONSE_BYTES of JSON.

        Args:
            method: Client-selected HTTP method.
            suffix: Fixed suffix built from validated UUIDs.
            body: Serialized request bytes, or None for a request without a body.
            key: Stable submission retry identity.

        Returns:
            Decoded object, or an empty object for deletion.

        Raises:
            httpx2.HTTPError: For unavailable/rejected/redirected requests.
            ValueError: For malformed JSON or oversized responses.
        """
        headers = {"Authorization": f"Bearer {self._token}"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if key is not None:
            headers["Idempotency-Key"] = key
        async with self.client.stream(
            method,
            JOBS_URL + suffix,
            headers=headers,
            content=body,
            follow_redirects=False,
        ) as response:
            content = bytearray()
            async for chunk in response.aiter_bytes():
                if len(content) + len(chunk) > MAX_RESPONSE_BYTES:
                    raise ValueError("Oversized Jobs response")
                content.extend(chunk)
            if not response.is_success:
                # Keep the bounded error body available after closing the stream so
                # admission cleanup can distinguish queue rejection from an outage.
                httpx2.Response(
                    response.status_code,
                    headers=response.headers,
                    content=bytes(content),
                    request=response.request,
                ).raise_for_status()
            result = json.loads(content) if content else {}
            if not isinstance(result, dict):
                raise ValueError("Invalid Jobs response")
            return result

    async def _submit(self, body: bytes, key: str) -> JobSnapshot:
        """Submit frozen bytes with a stable identity.

        Args:
            body: Already bounded JSON bytes.
            key: Already validated idempotency key.

        Returns:
            Validated authoritative snapshot.

        Raises:
            httpx2.HTTPError: For HTTP failure.
            ValueError: For invalid protocol output.
        """
        return JobSnapshot.model_validate(
            await self._request("POST", "", body=body, key=key)
        )

    @staticmethod
    def _submission(payload: dict[str, JsonValue], key: str) -> bytes:
        """Freeze inputs before asynchronous work or retries observe mutations.

        Args:
            payload: Existing submit-job fields; schemas are service-validated.
            key: Caller-selected retry identity.

        Returns:
            Immutable compact UTF-8 JSON within the service request budget.

        Raises:
            ValueError: For invalid keys, nonfinite or oversized input.
            TypeError: For values that cannot be JSON encoded.
        """
        if not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", key):
            raise ValueError("Invalid Jobs idempotency key")
        body = json.dumps(payload, allow_nan=False, separators=(",", ":")).encode()
        if len(body) > MAX_REQUEST_BYTES:
            raise ValueError("Oversized Jobs submission")
        return body

    async def submit(
        self,
        payload: dict[str, JsonValue],
        *,
        idempotency_key: str,
    ) -> JobSnapshot:
        """Submit without automatic observation or cleanup.

        This public boundary accepts a dictionary and freezes/validates it once.
        The private _submit() sends those bytes and also serves run() recovery,
        which must resend the exact original body after an uncertain admission.
        Use run() instead when the client should own waiting and cancellation.

        Args:
            payload: Operation, inputs, priority and server deadline fields.
            idempotency_key: Reuse with identical inputs after an uncertain reply.

        Returns:
            Snapshot; the caller owns subsequent observation and cleanup.

        Raises:
            httpx2.HTTPError: For unavailable/rejected submission.
            ValueError: For bounded input or response validation failure.
            TypeError: For non-JSON input.
        """
        return await self._submit(
            self._submission(payload, idempotency_key), idempotency_key
        )

    async def status(self, job_id: UUID | str) -> JobSnapshot:
        """Read authoritative state without changing the job.

        Args:
            job_id: Validated owned job UUID.

        Returns:
            Snapshot for exactly that job.

        Raises:
            httpx2.HTTPError: For failure, including unavailable ownership.
            ValueError: For malformed or mismatched responses.
        """
        job_id = UUID(str(job_id))
        snapshot = JobSnapshot.model_validate(await self._request("GET", f"/{job_id}"))
        if snapshot.jobId != job_id:
            raise ValueError("Mismatched Jobs response identity")
        return snapshot

    async def result(self, job_id: UUID | str) -> JobResult:
        """Retrieve output without deleting the retained record.

        Args:
            job_id: Validated owned job UUID.

        Returns:
            Result whose value the operation caller must validate.

        Raises:
            httpx2.HTTPError: If unavailable or not successful.
            ValueError: For malformed or mismatched responses.
        """
        job_id = UUID(str(job_id))
        result = JobResult.model_validate(
            await self._request("GET", f"/{job_id}/result")
        )
        if result.jobId != job_id:
            raise ValueError("Mismatched Jobs result identity")
        return result

    async def cancel(self, job_id: UUID | str) -> JobSnapshot:
        """Request cancellation; process exit may still be pending.

        Args:
            job_id: Validated owned job UUID.

        Returns:
            Current state, potentially still cancelling.

        Raises:
            httpx2.HTTPError: For HTTP failure.
            ValueError: For malformed or mismatched responses.
        """
        job_id = UUID(str(job_id))
        snapshot = JobSnapshot.model_validate(
            await self._request("POST", f"/{job_id}/cancel")
        )
        if snapshot.jobId != job_id:
            raise ValueError("Mismatched Jobs cancellation identity")
        return snapshot

    async def delete(self, job_id: UUID | str) -> None:
        """Delete terminal state, result and idempotency reservation.

        Args:
            job_id: Validated owned job UUID; cancel active jobs first.

        Raises:
            httpx2.HTTPError: If unavailable or not yet terminal.
            ValueError: For an invalid response.
        """
        job_id = UUID(str(job_id))
        await self._request("DELETE", f"/{job_id}")

    async def _wait(self, snapshot: JobSnapshot) -> JobSnapshot:
        """Poll to terminal state inside a caller-owned deadline.

        Args:
            snapshot: Last authoritative snapshot.

        Returns:
            Terminal snapshot, including failures.

        Raises:
            httpx2.HTTPError: For HTTP failure.
            ValueError: For malformed protocol output.
        """
        while snapshot.status not in TERMINAL:
            await asyncio.sleep(POLL_SECONDS)
            snapshot = await self.status(snapshot.jobId)
        return snapshot

    async def _cleanup_until_terminal(
        self,
        submission: asyncio.Task[JobSnapshot],
        snapshot: JobSnapshot | None,
        body: bytes,
        key: str,
        delete_on_completion: bool,
    ) -> None:
        """Confirm native work has stopped before a caller releases its resources.

        Recover uncertain admission using the original request and retry unavailable
        cancellation or observation with capped backoff. A known job's absence or
        terminal state ends retention; failure to delete terminal metadata does not
        prolong it. An outage can leave this cleanup waiting indefinitely.

        Args:
            submission: Original admission task, protected from caller cancellation.
            snapshot: Last known job state, or None before admission is confirmed.
            body: Frozen original submission bytes for idempotent recovery.
            key: Original submission's idempotency key.
            delete_on_completion: Whether to attempt deletion after terminal state.
        """
        if snapshot is None:
            try:
                snapshot = await submission
            except httpx2.HTTPStatusError as error:
                if _admission_was_rejected(error, uncertain=False):
                    return
            except (httpx2.HTTPError, ValueError):
                pass

        delay = POLL_SECONDS
        while snapshot is None or snapshot.status not in TERMINAL:
            try:
                async with asyncio.timeout(CLEANUP_SECONDS):
                    if snapshot is None:
                        snapshot = await self._submit(body, key)
                    if snapshot.status not in TERMINAL:
                        snapshot = await self.cancel(snapshot.jobId)
                        snapshot = await self._wait(snapshot)
            except httpx2.HTTPStatusError as error:
                if snapshot is not None and error.response.status_code == 404:
                    return
                if snapshot is None and _admission_was_rejected(error, uncertain=True):
                    return
            except (httpx2.HTTPError, ValueError, TimeoutError):
                pass
            else:
                break
            await asyncio.sleep(delay)
            delay = min(delay * 2, CLEANUP_RETRY_MAX_SECONDS)

        if delete_on_completion:
            try:
                async with asyncio.timeout(CLEANUP_SECONDS):
                    await self.delete(snapshot.jobId)
            except (httpx2.HTTPError, ValueError, TimeoutError):
                logger.warning(
                    "Jobs terminal deletion unavailable; retention remains active"
                )

    async def run(
        self,
        payload: dict[str, JsonValue],
        *,
        timeout_seconds: float,
        delete_on_completion: bool,
        idempotency_key: str | None = None,
        require_terminal_cleanup: bool = False,
    ) -> JobResult:
        """Submit a job, wait for its result and cancel it if the caller stops waiting.

        Args:
            payload: Submission fields, frozen before the first await.
            timeout_seconds: Total client wait budget, excluding cleanup.
            delete_on_completion: True deletes terminal records; false retains
                them, including failed/cancelled jobs, until explicit deletion
                or server expiry. Abandoned work is cancelled in either mode.
                Use submit() for detached work.
            idempotency_key: Stable retry key, or a new UUID when omitted.
            require_terminal_cleanup: True waits through service outages and repeated
                cancellation until admitted work is terminal or confirmed absent.
                Use when releasing caller-owned resources while work may still run
                would be unsafe. False keeps the existing five-second cleanup budget.

        Returns:
            Inline result and job UUID; domain validation remains caller-owned.

        Raises:
            JobFailed: For unsuccessful terminal states; includes the snapshot.
            httpx2.HTTPError: For unavailable/rejected requests.
            ValueError: For invalid bounds, JSON or protocol responses.
            TypeError: For non-JSON input.
            TimeoutError: When the client wait budget expires.
            asyncio.CancelledError: After the requested cleanup on caller cancellation.
        """
        if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
            raise ValueError("Run deadline must be finite and positive")
        key = idempotency_key if idempotency_key is not None else str(uuid4())
        body = self._submission(payload, key)
        submission = asyncio.create_task(self._submit(body, key))
        # No server reply yet. Cleanup uses None to recognize an uncertain
        # admission and recover its job ID before requesting cancellation.
        snapshot: JobSnapshot | None = None
        try:
            async with asyncio.timeout(timeout_seconds):
                snapshot = await asyncio.shield(submission)
                snapshot = await self._wait(snapshot)
                if snapshot.status != "succeeded":
                    raise JobFailed(snapshot)
                return await self.result(snapshot.jobId)
        finally:

            async def cleanup() -> None:
                """Recover uncertain admission and settle this owned request."""
                nonlocal snapshot
                try:
                    if require_terminal_cleanup:
                        await self._cleanup_until_terminal(
                            submission, snapshot, body, key, delete_on_completion
                        )
                        return
                    async with asyncio.timeout(CLEANUP_SECONDS):
                        if snapshot is None:
                            try:
                                snapshot = await asyncio.shield(submission)
                            except (httpx2.HTTPError, ValueError):
                                snapshot = await self._submit(body, key)
                        if snapshot.status not in TERMINAL:
                            snapshot = await self.cancel(snapshot.jobId)
                            snapshot = await self._wait(snapshot)
                        if delete_on_completion:
                            await self.delete(snapshot.jobId)
                except (httpx2.HTTPError, ValueError, TimeoutError):
                    logger.warning(
                        "Jobs cleanup unavailable; server deadlines/retention remain active"
                    )
                finally:
                    if not submission.done():
                        submission.cancel()
                    await asyncio.gather(submission, return_exceptions=True)

            cleanup_task = asyncio.create_task(cleanup())
            interrupted = False
            while not cleanup_task.done():
                try:
                    await asyncio.shield(cleanup_task)
                except asyncio.CancelledError:
                    interrupted = True
            await cleanup_task
            if interrupted:
                raise asyncio.CancelledError
