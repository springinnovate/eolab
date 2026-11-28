"""Authenticated control of transient tickets in the shared PostgreSQL worker queue."""

from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
import hmac
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Body, Depends, FastAPI, Header, HTTPException
from pydantic import AwareDatetime, BaseModel, Field
import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from eolab_jobs.job_notifications import JOB_QUEUE_CHANNEL
from eolab_jobs.worker_claim import claim_next_job, lock_job_queue, renew_job_lease


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
    ) -> Iterator[psycopg.Cursor[dict[str, Any]]]:
        """Lock the common queue and fence calls from a replaced executor.

        Args:
            instance: Required active supervisor generation, except during activation.

        Yields:
            A cursor committed before the reply is returned.

        Raises:
            HTTPException: If this supervisor was replaced or storage is unavailable.
        """
        try:
            with pool.connection() as connection, connection.cursor() as cursor:
                lock_job_queue(cursor)
                if instance is not None:
                    cursor.execute(
                        "SELECT FROM processing.executor_sessions WHERE scope=%s AND instance=%s",
                        (scope, instance),
                    )
                    if cursor.fetchone() is None:
                        raise HTTPException(409, "Executor instance was replaced")
                yield cursor
        except psycopg.Error as error:
            raise HTTPException(
                503, "Job scheduler is temporarily unavailable"
            ) from error

    def notify_capacity(cursor: psycopg.Cursor[Any]) -> None:
        """Wake waiting workers after deleting a reaped attempt's transient ticket.

        Args:
            cursor: Cursor in the transaction releasing the slot.
        """
        cursor.execute("SELECT pg_notify(%s, '')", (JOB_QUEUE_CHANNEL,))

    @router.get("/session")
    def current_instance() -> UUID | None:
        """Read the supervisor generation before replacing a stopped container.

        Returns:
            Its generation, or None if this is the first activation.
        """
        with transaction() as cursor:
            cursor.execute(
                "SELECT instance FROM processing.executor_sessions WHERE scope=%s",
                (scope,),
            )
            row = cursor.fetchone()
            return row["instance"] if row else None

    @router.put("/session/{instance}", status_code=204)
    def activate(instance: UUID, activation: Activation) -> None:
        """Recover this executor's slots after its old container and children exited.

        Args:
            instance: New supervisor generation, stable across retries.
            activation: Previously observed generation that this process replaces.

        Raises:
            HTTPException: If another replacement has already taken ownership.
        """
        with transaction() as cursor:
            cursor.execute(
                "SELECT instance FROM processing.executor_sessions WHERE scope=%s",
                (scope,),
            )
            row = cursor.fetchone()
            previous = row["instance"] if row else None
            if previous == instance:
                return
            if previous != activation.previous:
                raise HTTPException(
                    409, "Executor generation changed during replacement"
                )
            cursor.execute(
                "DELETE FROM processing.jobs WHERE executor_scope=%s", (scope,)
            )
            if cursor.rowcount:
                notify_capacity(cursor)
            cursor.execute(
                "INSERT INTO processing.executor_sessions(scope,instance) VALUES (%s,%s) "
                "ON CONFLICT(scope) DO UPDATE SET instance=excluded.instance, claim_sequence=0, stopped_attempt=NULL, stopped_with_lease=false",
                (scope, instance),
            )

    @router.put("/{instance}/tickets/{job_id}", status_code=204)
    def admit(instance: UUID, job_id: UUID, ticket: Ticket) -> None:
        """Admit one transient request without publishing its inputs in Processing history.

        Args:
            instance: Active executor generation.
            job_id: Opaque ID assigned by Jobs admission, reused on a retry.
            ticket: Original arrival and deadline for this request.
        """
        identifier = str(job_id)
        with transaction(instance) as cursor:
            cursor.execute(
                "INSERT INTO processing.jobs(id,operation,executor_scope,status,created_at,expires_at,reserved_bytes) "
                "VALUES (%s,%s,%s,'queued',%s,%s,0) ON CONFLICT(id) DO NOTHING",
                (identifier, operation, scope, ticket.submitted_at, ticket.expires_at),
            )
            if cursor.rowcount:
                cursor.execute(
                    "INSERT INTO processing.job_subscribers(id,job_id,owner,request_key,created_at) "
                    "VALUES (%s,%s,%s,%s,%s)",
                    (
                        identifier,
                        identifier,
                        f"executor:{scope}",
                        identifier,
                        ticket.submitted_at,
                    ),
                )

    @router.post("/{instance}/claim")
    def claim(instance: UUID, request: ClaimRequest) -> Grant | None:
        """Return a committed claim, or recover the exact unanswered claim before starting a child.

        Args:
            instance: Active executor generation.
            request: Ordered claim attempt and currently eligible tickets with API priorities.

        Returns:
            The claimed ticket and renewal interval, or None when no ticket can start.
        """
        attempt = request.attempt.hex
        with transaction(instance) as cursor:
            cursor.execute(
                "UPDATE processing.executor_sessions SET claim_sequence=%s WHERE scope=%s AND claim_sequence<%s",
                (request.sequence, scope, request.sequence),
            )
            fresh = bool(cursor.rowcount)
            cursor.execute(
                "SELECT id,attempt_id FROM processing.jobs WHERE executor_scope=%s "
                "AND status IN ('running','cancelling')",
                (scope,),
            )
            active = cursor.fetchone()
            may_start = True
            if active:
                if active["attempt_id"] != attempt:
                    return None
                # A replay can arrive late. Only confirmation of native exit may free this slot.
                may_start = renew_job_lease(
                    cursor,
                    job_id=active["id"],
                    attempt_id=attempt,
                    lease_seconds=lease_seconds,
                    progress={},
                )
                identifier = active["id"]
            elif fresh and request.priorities:
                job = claim_next_job(
                    cursor,
                    worker_count=worker_count,
                    lease_seconds=lease_seconds,
                    supported_operations=[operation],
                    attempt_id=attempt,
                    executor_scope=scope,
                    priorities={
                        str(job_id): value
                        for job_id, value in request.priorities.items()
                    },
                )
                if job is None:
                    return None
                identifier = job["id"]
            else:
                return None
            return Grant(
                job_id=UUID(identifier),
                heartbeat_seconds=lease_seconds / 3,
                may_start=may_start,
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
        with transaction(instance) as cursor:
            cursor.execute(
                "DELETE FROM processing.jobs WHERE executor_scope=%s AND status='queued' "
                "AND id=ANY(%s)",
                (scope, [str(identifier) for identifier in identifiers]),
            )

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
        with transaction(instance) as cursor:
            cursor.execute(
                "SELECT FROM processing.jobs WHERE id=%s AND executor_scope=%s",
                (str(job_id), scope),
            )
            return cursor.fetchone() is not None and renew_job_lease(
                cursor,
                job_id=str(job_id),
                attempt_id=attempt.hex,
                lease_seconds=lease_seconds,
                progress={},
            )

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
        with transaction(instance) as cursor:
            cursor.execute(
                "DELETE FROM processing.jobs WHERE id=%s AND executor_scope=%s AND attempt_id=%s "
                "RETURNING lease_until > clock_timestamp() AS live",
                (str(job_id), scope, attempt.hex),
            )
            stopped = cursor.fetchone()
            if stopped is not None:
                cursor.execute(
                    "UPDATE processing.executor_sessions SET stopped_attempt=%s, stopped_with_lease=%s WHERE scope=%s",
                    (attempt, stopped["live"], scope),
                )
                notify_capacity(cursor)
                return stopped["live"]
            cursor.execute(
                "SELECT stopped_with_lease FROM processing.executor_sessions WHERE scope=%s AND stopped_attempt=%s",
                (scope, attempt),
            )
            acknowledged = cursor.fetchone()
            return bool(acknowledged and acknowledged["stopped_with_lease"])

    return router
