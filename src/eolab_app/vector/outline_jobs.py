"""Vector-owned adapter for map display outlines executed by the Job service.

An outline is a visual aid: analysis continues if drawing it fails. That
independence does not mean the user must opt in to seeing the border.
"""

import asyncio
import logging
from typing import Any
from uuid import UUID, uuid4

import httpx2

from eolab_app.catalog_selection import CatalogSelection
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.outline_operation import OutlineResult

JOBS_URL = "http://jobs:8080/api/jobs"
REPLY_BYTES = 512 * 1024
TERMINAL = {"succeeded", "failed", "cancelled", "timed_out", "expired"}
POLL_SECONDS = 0.1
logger = logging.getLogger(__name__)


class OutlineJobs:
    """Submit and observe one outline per call without owning a second queue."""

    def __init__(self, client: httpx2.AsyncClient, token: str) -> None:
        """Bind server-held caller credentials to the fixed internal Jobs URL.

        Args:
            client: Composition-owned HTTP client.
            token: Configured Jobs bearer credential, never sent to the browser.
        """
        self.client = client
        self.token = token

    async def _request(self, method: str, suffix: str, **kwargs: Any) -> dict[str, Any]:
        """Exchange bounded JSON with the fixed Job service.

        Args:
            method: Internal HTTP action.
            suffix: Internal path built only from validated job IDs.
            **kwargs: JSON body or idempotency header supplied by this adapter.

        Returns:
            A validated JSON object.

        Raises:
            ValueError: For malformed or oversized responses.
            httpx2.HTTPError: If the service rejects or cannot serve the request.
        """
        headers = {"Authorization": f"Bearer {self.token}", **kwargs.pop("headers", {})}
        async with self.client.stream(
            method, JOBS_URL + suffix, headers=headers, **kwargs
        ) as response:
            response.raise_for_status()
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > REPLY_BYTES:
                    raise ValueError("Oversized Jobs response")
            import json

            result = json.loads(body) if body else {}
            if not isinstance(result, dict):
                raise ValueError("Invalid Jobs response")
            return result

    async def __call__(self, selection: CatalogSelection) -> dict[str, Any]:
        """Return a map outline; cancel abandoned work and release records.

        The shielded submission yields a job ID even if its browser disconnects.
        A lost response is retried with the same idempotency key during cleanup.
        Cleanup is bounded; service-side deadlines/retention cover an outage.

        Args:
            selection: Current path-free immutable selection.

        Returns:
            Existing geometry/bbox outline response.

        Raises:
            VectorConflictError: If the map outline operation is unavailable.
            asyncio.CancelledError: When the requesting client disconnects.
        """
        key = str(uuid4())
        payload = {
            "operation": "vector.outline.v1",
            "inputs": {"selection": selection.model_dump(mode="json", by_alias=True)},
            "priority": -10,
            "executionTimeoutSeconds": 15,
            "queueTimeoutSeconds": 10,
        }

        async def submit() -> dict[str, Any]:
            """Submit this immutable request, retaining its idempotency identity."""
            return await self._request(
                "POST", "", json=payload, headers={"Idempotency-Key": key}
            )

        submission = asyncio.create_task(submit())
        job_id: str | None = None
        terminal = False
        try:
            async with asyncio.timeout(40):
                snapshot = await asyncio.shield(submission)
                job_id = str(UUID(snapshot["jobId"]))
                while snapshot.get("status") not in TERMINAL:
                    await asyncio.sleep(POLL_SECONDS)
                    snapshot = await self._request("GET", f"/{job_id}")
                terminal = True
                if snapshot["status"] != "succeeded":
                    raise ValueError("Outline job did not succeed")
                result = await self._request("GET", f"/{job_id}/result")
                return OutlineResult.model_validate(result["value"]).model_dump(
                    mode="json"
                )
        except (httpx2.HTTPError, ValueError, KeyError, TimeoutError) as error:
            raise VectorConflictError(
                "The map outline is unavailable; retry the selection."
            ) from error
        finally:

            async def cleanup() -> None:
                """Recover uncertain admission and cancel/delete owned work."""
                nonlocal job_id, terminal
                try:
                    async with asyncio.timeout(5):
                        if job_id is None:
                            try:
                                snapshot = await asyncio.shield(submission)
                            except (httpx2.HTTPError, ValueError):
                                snapshot = await submit()
                            job_id = str(UUID(snapshot["jobId"]))
                            terminal = snapshot.get("status") in TERMINAL
                        if not terminal:
                            snapshot = await self._request("POST", f"/{job_id}/cancel")
                            terminal = snapshot.get("status") in TERMINAL
                        while not terminal:
                            await asyncio.sleep(POLL_SECONDS)
                            snapshot = await self._request("GET", f"/{job_id}")
                            terminal = snapshot.get("status") in TERMINAL
                        if terminal:
                            await self._request("DELETE", f"/{job_id}")
                except (httpx2.HTTPError, ValueError, KeyError, TimeoutError):
                    logger.warning(
                        "Outline job cleanup unavailable; Jobs deadlines/retention remain active"
                    )
                finally:
                    if not submission.done():
                        submission.cancel()
                    await asyncio.gather(submission, return_exceptions=True)

            cleanup_task = asyncio.create_task(cleanup())
            try:
                await asyncio.shield(cleanup_task)
            except asyncio.CancelledError:
                await cleanup_task
                raise
