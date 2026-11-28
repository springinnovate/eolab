"""Submit opaque diagnostic tickets to EOLab's shared worker scheduler."""

import asyncio
from datetime import datetime, timedelta
from uuid import UUID, uuid4

import httpx2
from pydantic import BaseModel, Field


class WorkerGrant(BaseModel):
    """A centrally claimed ticket and its required heartbeat interval."""

    job_id: UUID
    heartbeat_seconds: float = Field(gt=0)
    may_start: bool


class SchedulerClient:
    """Control one replaceable Jobs supervisor through the private scheduler interface.

    Calls use the service credential. Public caller tokens, inputs and results
    never cross this connection. The supervisor serializes activation and claims.
    """

    def __init__(self, http: httpx2.AsyncClient) -> None:
        """Identify this execution process once across network failures.

        Args:
            http: Composition-owned client for the authenticated private endpoint.
        """
        self.http = http
        self.instance = uuid4()
        self.active = False
        self.activation_lock = asyncio.Lock()
        self.previous: dict[str, str | None] | None = None
        self.sequence = 0
        self.unanswered: UUID | None = None

    async def activate(self) -> None:
        """Recover only the stopped predecessor observed when this instance first connects.

        Raises:
            httpx2.HTTPError: If the scheduler is unavailable or another instance replaced it.
        """
        async with self.activation_lock:
            if self.active:
                return
            if self.previous is None:
                response = await self.http.get("session")
                response.raise_for_status()
                self.previous = {"previous": response.json()}
            response = await self.http.put(
                f"session/{self.instance}", json=self.previous
            )
            response.raise_for_status()
            self.active = True

    async def admit(
        self, job_id: UUID, submitted: datetime, queue_seconds: float
    ) -> None:
        """Register a transient ticket before acknowledging public admission.

        Args:
            job_id: Opaque ticket supplied by this supervisor.
            submitted: Time the Jobs API admitted the request.
            queue_seconds: Maximum time between submission and native start.

        Raises:
            httpx2.HTTPError: If admission cannot be confirmed.
        """
        await self.activate()
        response = await self.http.put(
            f"{self.instance}/tickets/{job_id}",
            json={
                "submitted_at": submitted.isoformat(),
                "expires_at": (
                    submitted + timedelta(seconds=queue_seconds)
                ).isoformat(),
            },
        )
        response.raise_for_status()

    async def claim(
        self, priorities: dict[str, int]
    ) -> tuple[WorkerGrant, UUID] | None:
        """Claim a compatible ticket or recover the same attempt after an unanswered request.

        Args:
            priorities: Currently eligible public IDs and their latest caller-set priorities.

        Returns:
            Grant and fencing token for native execution, or None when the shared pool is full.

        Raises:
            httpx2.HTTPError: If the claim result is unknown. Retry before starting any child.
        """
        if self.unanswered is None:
            self.unanswered = uuid4()
            self.sequence += 1
        attempt = self.unanswered
        response = await self.http.post(
            f"{self.instance}/claim",
            json={
                "attempt": str(attempt),
                "sequence": self.sequence,
                "priorities": priorities,
            },
        )
        response.raise_for_status()
        value = response.json()
        grant = WorkerGrant.model_validate(value) if value is not None else None
        self.unanswered = None
        return (grant, attempt) if grant is not None else None

    async def renew(self, job_id: UUID, attempt: UUID) -> bool:
        """Confirm the native attempt's lease while the child is running.

        Args:
            job_id: Claimed ticket.
            attempt: This child's fencing token.

        Returns:
            Whether the scheduler still authorizes this attempt.

        Raises:
            httpx2.HTTPError: If the lease cannot be confirmed.
        """
        response = await self.http.put(
            f"{self.instance}/tickets/{job_id}/attempts/{attempt}"
        )
        response.raise_for_status()
        return response.json() is True

    async def withdraw(self, identifiers: set[UUID]) -> None:
        """Remove cancelled or expired waiting tickets without affecting active claims.

        Args:
            identifiers: IDs that the local API will no longer offer for execution.

        Raises:
            httpx2.HTTPError: If withdrawal has not been confirmed.
        """
        response = await self.http.post(
            f"{self.instance}/withdraw", json=[str(value) for value in identifiers]
        )
        response.raise_for_status()

    async def release(self, job_id: UUID, attempt: UUID) -> bool:
        """Acknowledge native exit, safely repeating an unanswered release.

        Args:
            job_id: Claimed ticket.
            attempt: Token of the stopped or never-started attempt.

        Returns:
            Whether the reaped attempt had a live lease at completion.

        Raises:
            httpx2.HTTPError: If release has not been confirmed.
        """
        response = await self.http.delete(
            f"{self.instance}/tickets/{job_id}/attempts/{attempt}"
        )
        response.raise_for_status()
        return response.json() is True
