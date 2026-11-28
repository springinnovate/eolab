"""Serve the restricted Jobs supervisor's private ticket and lease endpoints."""

from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
import hmac
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Body, Depends, FastAPI, Header, HTTPException
from pydantic import AwareDatetime, BaseModel, Field
import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from eolab_jobs.executor_tickets import ExecutorReplaced, ExecutorTickets
from eolab_jobs.worker_claim import lock_job_queue


class Activation(BaseModel):
    """Replace the observed executor instance after its container and children have stopped."""

    previous: UUID | None


class Ticket(BaseModel):
    """An opaque Jobs request with its original admission time and queue deadline."""

    submitted_at: AwareDatetime
    expires_at: AwareDatetime


class ClaimRequest(BaseModel):
    """Claim one eligible ticket, replaying the same sequence and token after a lost reply."""

    sequence: Annotated[int, Field(gt=0, le=2**63 - 1)]
    attempt: UUID
    priorities: Annotated[
        dict[UUID, Annotated[int, Field(ge=-1000, le=1000)]], Field(max_length=10_000)
    ]


class Grant(BaseModel):
    """The ticket authorized to start and the interval for confirming its lease."""

    job_id: UUID
    heartbeat_seconds: float
    may_start: bool


def create_executor_router(
    *,
    token: str,
    scope: str,
    operation: str,
    worker_count: int,
    lease_seconds: int,
    conninfo: str = "",
) -> APIRouter:
    """Serve one restricted supervisor's queue operations without exposing database access.

    The deployment installs the operation, executor scope and global slot count.
    Only opaque IDs, eligibility and timing cross this interface. The caller keeps
    its private inputs, API owners and results. Every successful response follows
    commit. Retry an unanswered claim with its original sequence and attempt.

    Args:
        token: Dedicated service credential, separate from public Jobs caller tokens.
        scope: Stable deployment identity of the single replaceable supervisor.
        operation: Installed operation its native children may run.
        worker_count: Same global slot count used by Processing.
        lease_seconds: Shared worker lease duration.
        conninfo: PostgreSQL connection settings. By default use the host's PG environment.

    Returns:
        Service-authenticated routes with a lifespan-owned database pool.
    """
    pool = ConnectionPool(
        conninfo,
        min_size=0,
        max_size=2,
        max_waiting=8,
        timeout=3,
        open=False,
        kwargs={
            "row_factory": dict_row,
            "connect_timeout": 3,
            "options": "-c statement_timeout=5000 -c lock_timeout=3000",
        },
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        """Keep database connections available while this router serves requests.

        Args:
            _: Hosting ASGI application.

        Yields:
            Control until all private requests have finished.
        """
        pool.open()
        try:
            yield
        finally:
            pool.close()

    def authenticate(authorization: Annotated[str | None, Header()] = None) -> None:
        """Require the deployment's scheduler credential before accessing executor state.

        Args:
            authorization: HTTP Authorization header from the supervisor.

        Raises:
            HTTPException: If the bearer credential is missing or incorrect.
        """
        if not authorization or not hmac.compare_digest(
            authorization.encode(), f"Bearer {token}".encode()
        ):
            raise HTTPException(403, "Scheduler credential required")

    router = APIRouter(
        prefix="/_internal/jobs/executor",
        dependencies=[Depends(authenticate)],
        include_in_schema=False,
        lifespan=lifespan,
    )

    @contextmanager
    def transaction(
        instance: UUID | None = None,
    ) -> Iterator[ExecutorTickets]:
        """Lock the common queue and fence calls from a replaced executor.

        Args:
            instance: Required active supervisor generation, except during activation.

        Yields:
            Ticket operations committed before the reply is returned.

        Raises:
            HTTPException: If this supervisor was replaced or storage is unavailable.
        """
        try:
            with pool.connection() as connection, connection.cursor() as cursor:
                lock_job_queue(cursor)
                tickets = ExecutorTickets(
                    cursor, scope, operation, worker_count, lease_seconds
                )
                if instance is not None and tickets.current_instance() != instance:
                    raise ExecutorReplaced("Executor instance was replaced")
                yield tickets
        except ExecutorReplaced as error:
            raise HTTPException(409, str(error)) from error
        except psycopg.Error as error:
            raise HTTPException(
                503, "Job scheduler is temporarily unavailable"
            ) from error

    @router.get("/session")
    def current_instance() -> UUID | None:
        """Read the supervisor generation before replacing a stopped container.

        Returns:
            Its generation, or None if this is the first activation.
        """
        with transaction() as tickets:
            return tickets.current_instance()

    @router.put("/session/{instance}", status_code=204)
    def activate(instance: UUID, activation: Activation) -> None:
        """Recover this executor's slots after its old container and children exited.

        Args:
            instance: New supervisor generation, stable across retries.
            activation: Previously observed generation that this process replaces.

        Raises:
            HTTPException: If another replacement has already taken ownership.
        """
        with transaction() as tickets:
            tickets.replace_stopped_instance(instance, activation.previous)

    @router.put("/{instance}/tickets/{job_id}", status_code=204)
    def admit(instance: UUID, job_id: UUID, ticket: Ticket) -> None:
        """Admit one transient request without publishing its inputs in Processing history.

        Args:
            instance: Active executor generation.
            job_id: Opaque ID assigned by Jobs admission, reused on a retry.
            ticket: Original arrival and deadline for this request.
        """
        with transaction(instance) as tickets:
            tickets.admit(job_id, ticket.submitted_at, ticket.expires_at)

    @router.post("/{instance}/claim")
    def claim(instance: UUID, request: ClaimRequest) -> Grant | None:
        """Return a committed claim, or recover the exact unanswered claim before starting a child.

        Args:
            instance: Active executor generation.
            request: Ordered claim attempt and currently eligible tickets with API priorities.

        Returns:
            The claimed ticket and renewal interval, or None when no ticket can start.
        """
        with transaction(instance) as tickets:
            claimed = tickets.claim(
                request.sequence, request.attempt, request.priorities
            )
            if claimed is None:
                return None
            return Grant(
                job_id=claimed.job_id,
                heartbeat_seconds=lease_seconds / 3,
                may_start=claimed.may_start,
            )

    @router.post("/{instance}/withdraw", status_code=204)
    def withdraw(
        instance: UUID, identifiers: Annotated[list[UUID], Body(max_length=10_000)]
    ) -> None:
        """Discard cancelled or expired waiting tickets without releasing a claimed child.

        Args:
            instance: Active executor generation.
            identifiers: Tickets whose local Jobs requests stopped waiting.
        """
        with transaction(instance) as tickets:
            tickets.withdraw(identifiers)

    @router.put("/{instance}/tickets/{job_id}/attempts/{attempt}")
    def heartbeat(instance: UUID, job_id: UUID, attempt: UUID) -> bool:
        """Renew the running child ticket while its attempt and lease remain current.

        Args:
            instance: Active executor generation.
            job_id: Claimed transient ticket.
            attempt: Fencing token returned by this claim.

        Returns:
            Whether the child still has a live lease.
        """
        with transaction(instance) as tickets:
            return tickets.renew(job_id, attempt)

    @router.delete("/{instance}/tickets/{job_id}/attempts/{attempt}")
    def release(instance: UUID, job_id: UUID, attempt: UUID) -> bool:
        """Release only the confirmed stopped native attempt, including after a lost acknowledgement.

        Args:
            instance: Active executor generation.
            job_id: Transient ticket whose child has exited or never started.
            attempt: Exact attempt the supervisor has reaped.

        Returns:
            Whether completion was fenced by a live lease, including after a lost reply.
        """
        with transaction(instance) as tickets:
            return tickets.release_stopped_attempt(job_id, attempt)

    return router
