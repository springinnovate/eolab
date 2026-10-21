"""PostgreSQL adapter for atomic job admission, leases, and owned processing state.

Operation owners validate and serialize their specifications, summaries, and
resource estimates before calling this adapter. Storage never interprets raster
grids, AOI geometry, or any other operation-specific input fields.
"""

from contextlib import contextmanager
from dataclasses import asdict
from datetime import datetime
from importlib.resources import files
import json
from typing import Any, Iterator
from uuid import uuid4
from eolab_app.processing.artifact_manifest import read_artifact_manifest, PublishedFile

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool
from eolab_app.processing.job_notifications import JOB_QUEUE_CHANNEL

from eolab_app.processing.models import (
    Artifact,
    PreparedJobPlan,
    JobSubmission,
    ProcessingError,
    ProcessingLimits,
    JobInputFile,
)

# Processing owns this key in PostgreSQL's single-bigint, database-wide advisory
# lock namespace. It serializes schema migration and shared admission, job-state,
# storage, and transfer decisions; it is never held during native execution.
# The integer is an assigned identifier, not a limit or a generated random value.
# Keep it stable across releases so all Processing transactions use the same lock.
# Other components using this database must allocate a different advisory key.
PROCESSING_ADVISORY_LOCK_ID = 7_610_329
UNFINISHED = ("queued", "running", "cancelling")


def serialize_retained_metadata(value: dict[str, object] | None) -> Jsonb | None:
    """Check retained job details and convert them to PostgreSQL JSON.

    Args:
        value: Operation details already validated by the calling service, or None.

    Returns:
        A PostgreSQL JSON value of at most 192 KiB, or None. This leaves room for
        the final result or error within the database's combined 256 KiB limit.

    Raises:
        ProcessingError: If the details exceed the size limit or contain non-JSON values.
    """
    if value is None:
        return None
    try:
        if len(json.dumps(value, allow_nan=False).encode("utf-8")) > 192 * 1024:
            raise ValueError("Metadata too large")
    except (ValueError, TypeError) as error:
        raise ProcessingError(
            "metadata_size", "This run exceeds its retained metadata limit.", 413
        ) from error
    return Jsonb(value)


class PostgresJobStore:
    """Own Processing transactions and a bounded, process-local connection pool.

    Composition opens the pool before use and closes it on shutdown. Connections
    are borrowed exclusively per transaction, never retained by jobs or callers.
    """

    def __init__(self, limits: ProcessingLimits, conninfo: str = "") -> None:
        """Configure the adapter without opening a startup-time connection.

        Args:
            limits: Shared deployment admission and lifecycle policy.
            conninfo: Optional test connection string; production uses PG* env.
        """
        self.limits = limits
        self.conninfo = conninfo
        self._pool: ConnectionPool[psycopg.Connection[dict[str, Any]]] = ConnectionPool(
            conninfo,
            kwargs={
                "connect_timeout": 3,
                "row_factory": dict_row,
                "options": "-c statement_timeout=5000 -c lock_timeout=3000",
            },
            min_size=2,
            max_size=8,
            timeout=3,
            max_waiting=64,
            check=ConnectionPool.check_connection,
            open=False,
            name="processing",
        )

    def open(self) -> None:
        """Start preparing reusable connections without waiting for the database.

        Transactions wait at most three seconds for an available connection;
        startup can therefore continue serving unrelated application capabilities.
        Calling this again while the pool is open has no effect.

        Raises:
            psycopg_pool.PoolClosed: If this store was already closed.
        """
        self._pool.open()

    def close(self) -> None:
        """Release idle connections and pool threads after consumers stop.

        A borrowed connection is closed when its transaction returns it. Calling
        this again is harmless; this store cannot be reopened after shutdown.
        """
        self._pool.close()

    @contextmanager
    def _transaction(
        self, acquire_lock: bool = False
    ) -> Iterator[psycopg.Cursor[dict[str, Any]]]:
        """Borrow a connection for one optionally locked transaction.

        Commit or roll back before returning the connection, releasing any
        transaction advisory lock. Broken connections are replaced by the pool.

        Args:
            acquire_lock: Acquire Processing's database-wide transaction advisory lock.

        Yields:
            Dictionary-row cursor; all operations are committed or rolled back.

        Raises:
            ProcessingError: If the pool is closed, saturated or unavailable,
                or a database operation fails or times out.
        """
        try:
            with self._pool.connection() as connection:
                with connection.cursor() as cursor:
                    if acquire_lock:
                        cursor.execute(
                            "SELECT pg_advisory_xact_lock(%s)",
                            (PROCESSING_ADVISORY_LOCK_ID,),
                        )
                    yield cursor
        except psycopg.Error as error:
            raise ProcessingError(
                "processing_unavailable",
                "Job processing is temporarily unavailable. Try again shortly.",
                503,
            ) from error

    def migrate(self) -> None:
        """Idempotently install the owned schema under the processing mutex.

        Raises:
            ProcessingError: If the database cannot apply the schema.
        """
        sql = files("eolab_app.processing").joinpath("schema.sql").read_text()
        with self._transaction(acquire_lock=True) as cursor:
            cursor.execute(sql)

    def interrupt_unfinished_jobs_on_restart(self) -> int:
        """Discard pending work before the restarted worker consumes new jobs.

        Call once at worker startup, after stopping the previous worker and its
        native processes. Queued, running and cancelling jobs become interrupted;
        completed results and cached values are unchanged. Keep attempt files and
        reservations until the worker's normal cleanup removes them. Existing
        job notifications tell browsers to read the interrupted status.

        Returns:
            Number of unfinished jobs interrupted by this restart.

        Raises:
            ProcessingError: If PostgreSQL cannot update the jobs.
        """
        with self._transaction(acquire_lock=True) as cursor:
            cursor.execute(
                "UPDATE processing.jobs SET status='interrupted',error=%s,"
                "updated_at=clock_timestamp() "
                "WHERE status IN ('queued','running','cancelling')",
                (
                    Jsonb(
                        {
                            "code": "worker_restarted",
                            "detail": "The application restarted before this job finished. Submit a new job to retry.",
                        }
                    ),
                ),
            )
            return cursor.rowcount

    def save_input(self, owner: str, checksum: str, payload: dict[str, Any]) -> str:
        """Retain a bounded private input for one day or until its owner releases it.

        Args:
            owner: Current Processing browser-session hash.
            checksum: Operation-owned content identity.
            payload: Validated JSON input without filesystem paths or credentials.

        Returns:
            Opaque identifier usable only by the same owner.

        Raises:
            ProcessingError: If the input or shared storage capacity is exceeded.
        """
        size = len(json.dumps(payload, allow_nan=False).encode("utf-8"))
        if size > 8 * 1024**2:
            raise ProcessingError(
                "input_size",
                "This processing input exceeds the 8 MiB storage limit.",
                413,
            )
        with self._transaction(acquire_lock=True) as cursor:
            cursor.execute("DELETE FROM processing.inputs WHERE expires_at <= now()")
            cursor.execute(
                "SELECT count(*) AS total, count(*) FILTER (WHERE owner=%s) AS owned, coalesce(sum(bytes),0) AS bytes FROM processing.inputs",
                (owner,),
            )
            count = cursor.fetchone()
            if (
                count["total"] >= 128
                or count["owned"] >= 32
                or count["bytes"] + size > 64 * 1024**2
            ):
                raise ProcessingError(
                    "input_capacity",
                    "Temporary processing input storage is full. Release an unused input or try again later.",
                    429,
                )
            identifier = uuid4().hex
            cursor.execute(
                "INSERT INTO processing.inputs VALUES (%s,%s,%s,%s,%s,now()+interval '1 day')",
                (identifier, owner, checksum, Jsonb(payload), size),
            )
            return identifier

    def get_input(self, owner: str, identifier: str, checksum: str) -> dict[str, Any]:
        """Read an unexpired input belonging to the current Processing session.

        Args:
            owner: Current browser-session hash.
            identifier: Opaque input ID returned by save_input.
            checksum: Expected immutable content identity.

        Returns:
            Stored JSON to validate at the operation boundary.

        Raises:
            ProcessingError: If the reference is expired, changed or belongs to someone else.
        """
        with self._transaction() as cursor:
            cursor.execute(
                "SELECT payload FROM processing.inputs WHERE id=%s AND owner=%s AND sha256=%s AND expires_at>now()",
                (identifier, owner, checksum),
            )
            row = cursor.fetchone()
        if row is None:
            raise ProcessingError(
                "input_unavailable",
                "This calculation area expired or is unavailable. Select the layer again.",
                409,
            )
        return row["payload"]

    def discard_input(self, owner: str, identifier: str) -> None:
        """Release an input after deselection; accepted jobs keep their own copy.

        Args:
            owner: Current browser-session hash.
            identifier: Input to delete, including an already deleted input.

        Raises:
            ProcessingError: If storage is unavailable.
        """
        with self._transaction(acquire_lock=True) as cursor:
            cursor.execute(
                "DELETE FROM processing.inputs WHERE id=%s AND owner=%s",
                (identifier, owner),
            )

    def find_request(self, owner: str, request_key: str) -> dict[str, Any] | None:
        """Recover a committed job after a lost submission response.

        Args:
            owner: Current session hash.
            request_key: Client idempotency key.

        Returns:
            Matching owned job, including a terminal tombstone, or None.
        """
        with self._transaction() as cursor:
            cursor.execute(
                "SELECT * FROM processing.subscribed_jobs WHERE owner=%s AND request_key=%s",
                (owner, request_key),
            )
            return cursor.fetchone()

    def _inspect_input_file(
        self, cursor: Any, owner: str, run_id: str, artifact_id: str
    ) -> tuple[dict[str, Any], JobInputFile]:
        """Read an owned, available manifest entry within a storage transaction.

        Args:
            cursor: Current transaction cursor; admission also holds the shared lock.
            owner: Requesting session hash.
            run_id: Parent public handle.
            artifact_id: Published file ID.

        Returns:
            Parent row and immutable published identity.

        Raises:
            ProcessingError: If ownership, expiry or publication denies access.
            ValueError: If persisted manifest data is malformed.
        """
        cursor.execute(
            "SELECT *,expires_at>now() AS available FROM processing.subscribed_jobs WHERE id=%s AND owner=%s",
            (run_id, owner),
        )
        row = cursor.fetchone()
        if row is None:
            raise ProcessingError(
                "job_not_found", "This input run is unavailable.", 404
            )
        if row["status"] != "ready" or not row["available"]:
            raise ProcessingError(
                "input_unavailable",
                "This raster result expired or was deleted. Choose another input.",
                409,
            )
        manifest = (row.get("artifact") or {}).get("manifest")
        file = (
            next(
                (
                    file
                    for file in read_artifact_manifest(manifest).files
                    if file.id == artifact_id
                ),
                None,
            )
            if manifest
            else None
        )
        if file is None:
            raise ProcessingError(
                "artifact_not_found", "This input file is unavailable.", 404
            )
        return row, JobInputFile(
            run_id, file.id, file.sha256, file.size, file.media_type, file.role
        )

    def inspect_input_file(
        self, owner: str, run_id: str, artifact_id: str
    ) -> JobInputFile:
        """Read an owned file's identity for a later atomic admission check.

        Args:
            owner: Requesting session hash.
            run_id: Parent public handle.
            artifact_id: Published file ID.

        Returns:
            Published identity; this inspection alone retains no file.

        Raises:
            ProcessingError: If the owned file is not currently available.
        """
        with self._transaction() as cursor:
            return self._inspect_input_file(cursor, owner, run_id, artifact_id)[1]

    def active_input_uploads(self) -> set[str]:
        """Return retained upload tokens still needed by unfinished computations.

        Returns:
            Tokens belonging to queued, running or cancelling jobs. The API
            serializes admission with upload cleanup before using this snapshot.

        Raises:
            ProcessingError: If the database cannot read the active jobs.
        """
        with self._transaction() as cursor:
            cursor.execute(
                "SELECT token FROM processing.jobs, "
                "LATERAL jsonb_each_text(input_uploads) AS uploads(upload_id,token) "
                "WHERE status IN ('queued','running','cancelling')"
            )
            return {row["token"] for row in cursor.fetchall()}

    def read_retained_input(
        self, identifier: str, attempt: str, run_id: str, artifact_id: str
    ) -> tuple[str, PublishedFile]:
        """Read a file under an accepted job grant instead of its parent's expiry.

        Args:
            identifier: Dependent computation ID.
            attempt: Current worker fencing token.
            run_id: Parent public handle recorded at admission.
            artifact_id: Published file ID recorded at admission.

        Returns:
            Parent storage attempt and immutable published file metadata.

        Raises:
            ProcessingError: If the job stopped, grant is absent or identity changed.
            ValueError: If the stored manifest is invalid.
        """
        with self._transaction() as cursor:
            cursor.execute(
                "SELECT p.attempt_id,p.artifact,i.sha256,i.bytes FROM processing.input_files i "
                "JOIN processing.jobs j ON j.id=i.job_id JOIN processing.jobs p ON p.id=i.parent_id "
                "WHERE j.id=%s AND j.attempt_id=%s AND j.status='running' AND j.lease_until>now() "
                "AND i.run_id=%s AND i.artifact_id=%s",
                (identifier, attempt, run_id, artifact_id),
            )
            row = cursor.fetchone()
            if row is None:
                raise ProcessingError(
                    "input_unavailable",
                    "This job no longer has access to its input file.",
                    409,
                )
            manifest = read_artifact_manifest(row["artifact"]["manifest"])
            file = next(
                (file for file in manifest.files if file.id == artifact_id), None
            )
            if (
                file is None
                or file.sha256 != row["sha256"]
                or file.size != row["bytes"]
            ):
                raise ProcessingError(
                    "source_changed",
                    "The retained input file changed. Run the parent model again.",
                    409,
                )
            return row["attempt_id"], file

    def submit(
        self, owner: str, request_key: str, expected: PreparedJobPlan, request_hash: str
    ) -> dict[str, Any]:
        """Admit one request using the same transaction as batch submissions.

        Args:
            owner: Current session hash.
            request_key: Stable retry identifier scoped to this owner.
            expected: Validated operation inputs and shared-work identity.
            request_hash: Complete request identity.

        Returns:
            Owned subscriber row, including an existing idempotent retry.

        Raises:
            ProcessingError: If admission or storage fails.
            ValueError: If the internal request hash is missing.
        """
        result = self.submit_batch(
            owner,
            [JobSubmission(request_key, request_hash, expected.operation, expected)],
        )[0]
        if isinstance(result, ProcessingError):
            raise result
        return result

    def submit_batch(
        self, owner: str, submissions: list[JobSubmission]
    ) -> list[dict[str, Any] | ProcessingError]:
        """Admit up to fifty requests with one capacity snapshot and transaction.

        The shared lock protects retry and work lookups, capacity decisions and
        inserts. In-memory counts include earlier acceptances in this batch.
        Duplicate work receives separate subscribers; duplicate retry keys reuse
        their original subscriber. Rejections do not discard accepted neighbors.

        Args:
            owner: Current browser-session hash.
            submissions: Validated operation inputs or sanitized resolution errors.

        Returns:
            Owned rows or rejections in input order, after accepted rows commit.

        Raises:
            ValueError: If batch length or an internal request hash is invalid.
            ProcessingError: If the database transaction fails. No partial commit
                is attempted; callers retry with the same per-item keys.
        """
        if not 1 <= len(submissions) <= 50:
            raise ValueError("Submit between one and fifty jobs per transaction")
        if any(not item.request_hash for item in submissions):
            raise ValueError("Direct jobs require a request hash")
        if any(
            isinstance(item.prepared, PreparedJobPlan)
            and len(item.prepared.input_files) > 16
            for item in submissions
        ):
            raise ValueError("A job can retain at most sixteen input files")
        work_keys = list(
            {
                item.prepared.work_key
                for item in submissions
                if isinstance(item.prepared, PreparedJobPlan) and item.prepared.work_key
            }
        )
        outcomes: list[str | ProcessingError] = []
        new_jobs: list[tuple[Any, ...]] = []
        new_subscribers: list[tuple[Any, ...]] = []
        new_inputs: list[tuple[Any, ...]] = []
        with self._transaction(acquire_lock=True) as cursor:
            with (cursor.connection.cursor() as work_cursor,):
                with cursor.connection.pipeline():
                    cursor.execute(
                        "SELECT * FROM processing.subscribed_jobs WHERE owner=%s AND request_key=ANY(%s)",
                        (owner, [item.request_key for item in submissions]),
                    )
                    work_cursor.execute(
                        "SELECT id,work_key,status,(status='queued' OR "
                        "(lease_until>now())) AS can_join "
                        "FROM processing.jobs WHERE work_key=ANY(%s) AND status IN ('queued','running')",
                        (work_keys,),
                    )
                existing_rows = cursor.fetchall()
                requests = {row["request_key"]: row for row in existing_rows}
                work = {row["work_key"]: row for row in work_cursor.fetchall()}
            for item in submissions:
                existing = requests.get(item.request_key)
                if existing:
                    if (
                        existing["request_hash"] != item.request_hash
                        or existing["operation"] != item.operation
                    ):
                        outcomes.append(
                            ProcessingError(
                                "request_conflict",
                                "That request ID already belongs to different job inputs.",
                                409,
                            )
                        )
                    else:
                        outcomes.append(existing["id"])
                    continue
                expected = item.prepared
                if isinstance(expected, ProcessingError):
                    outcomes.append(expected)
                    continue
                # Existing retries above retain their original grant even after expiry.
                try:
                    inputs = []
                    for captured in expected.input_files:
                        parent, current = self._inspect_input_file(
                            cursor, owner, captured.run_id, captured.artifact_id
                        )
                        if current != captured:
                            raise ProcessingError(
                                "source_changed",
                                "The input file changed before this job was accepted.",
                                409,
                            )
                        inputs.append((parent["job_id"], current))
                except ProcessingError as error:
                    outcomes.append(error)
                    continue
                shared = work.get(expected.work_key)
                if shared and not shared["can_join"]:
                    outcomes.append(
                        ProcessingError(
                            "previous_attempt_stopping",
                            "Waiting for the previous attempt to stop. Retrying shortly.",
                            429,
                        )
                    )
                    continue

                identifier = uuid4().hex
                job_id = shared["id"] if shared else identifier
                if not shared:
                    retained_seconds = (
                        max(
                            expected.minimum_retention_seconds,
                            self.limits.result_ttl_seconds,
                            self.limits.metadata_ttl_seconds,
                        )
                        if expected.minimum_retention_seconds is not None
                        else None
                    )
                    new_inputs.extend(
                        (
                            job_id,
                            parent,
                            file.run_id,
                            file.artifact_id,
                            file.sha256,
                            file.size,
                        )
                        for parent, file in inputs
                    )
                    new_jobs.append(
                        (
                            job_id,
                            self.limits.result_ttl_seconds,
                            Jsonb(expected.specification),
                            expected.reserved_bytes,
                            Jsonb(expected.summary),
                            expected.operation,
                            expected.work_key,
                            serialize_retained_metadata(expected.retained_metadata),
                            retained_seconds or self.limits.metadata_ttl_seconds,
                            retained_seconds,
                            Jsonb(expected.input_uploads),
                        )
                    )

                    if expected.work_key:
                        work[expected.work_key] = {
                            "id": job_id,
                            "status": "queued",
                            "can_join": True,
                        }
                new_subscribers.append(
                    (
                        identifier,
                        job_id,
                        owner,
                        item.request_key,
                        item.request_hash,
                        (
                            Jsonb(expected.presentation)
                            if expected.presentation is not None
                            else None
                        ),
                    )
                )
                requests[item.request_key] = {
                    "id": identifier,
                    "request_hash": item.request_hash,
                    "operation": item.operation,
                }

                outcomes.append(identifier)
            with cursor.connection.pipeline():
                if new_jobs:
                    cursor.executemany(
                        "INSERT INTO processing.jobs(id,expires_at,status,spec,reserved_bytes,summary,operation,work_key,retained_metadata,metadata_ttl_seconds,result_ttl_seconds,input_uploads) "
                        "VALUES (%s,now()+%s*interval '1 second','queued',%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                        new_jobs,
                    )
                if new_subscribers:
                    cursor.executemany(
                        "INSERT INTO processing.job_subscribers(id,job_id,owner,request_key,request_hash,presentation) "
                        "VALUES (%s,%s,%s,%s,%s,%s)",
                        new_subscribers,
                    )
                if new_inputs:
                    cursor.executemany(
                        "INSERT INTO processing.input_files(job_id,parent_id,run_id,artifact_id,sha256,bytes) VALUES (%s,%s,%s,%s,%s,%s)",
                        new_inputs,
                    )
                if new_jobs:
                    cursor.execute("SELECT pg_notify(%s, '')", (JOB_QUEUE_CHANNEL,))
                cursor.execute(
                    "SELECT * FROM processing.subscribed_jobs WHERE owner=%s AND id=ANY(%s)",
                    (owner, [item for item in outcomes if isinstance(item, str)]),
                )
            rows = {row["id"]: row for row in cursor.fetchall()}
        return [rows[item] if isinstance(item, str) else item for item in outcomes]

    def save_prepared_job(
        self,
        identifier: str,
        attempt: str,
        prepared: PreparedJobPlan,
    ) -> dict[str, Any]:
        """Save prepared inputs while the same worker still owns the running attempt.

        Args:
            identifier: Running computation ID.
            attempt: Current worker attempt token.
            prepared: Validated path-free inputs, display summary and retained run details.

        Returns:
            Updated running job without reserving disk or returning it to the queue.
            Historical reservation fields remain readable but are not admission limits.

        Raises:
            ProcessingError: If ownership was lost, cancellation won or storage failed.
        """
        with self._transaction(acquire_lock=True) as cursor:
            cursor.execute(
                "SELECT * FROM processing.jobs WHERE id=%s AND attempt_id=%s "
                "AND status='running' AND lease_until>now() FOR UPDATE",
                (identifier, attempt),
            )
            if cursor.fetchone() is None:
                raise ProcessingError(
                    "job_cancelled", "Job stopped during preparation.", 409
                )
            cursor.execute(
                "UPDATE processing.jobs SET spec=%s,summary=%s,retained_metadata=COALESCE(%s,retained_metadata),"
                "reserved_bytes=0,required_disk_bytes=0,progress=%s,updated_at=clock_timestamp() "
                "WHERE id=%s RETURNING *",
                (
                    Jsonb(prepared.specification),
                    Jsonb(prepared.summary),
                    serialize_retained_metadata(prepared.retained_metadata),
                    Jsonb({"phase": "calculating"}),
                    identifier,
                ),
            )
            return cursor.fetchone()

    def get(self, identifier: str, owner: str) -> dict[str, Any]:
        """Read one owned job without exposing another session's existence.

        Args:
            identifier: Opaque job ID.
            owner: Current session hash.

        Returns:
            Owned job record.

        Raises:
            ProcessingError: If no owned record exists.
        """
        with self._transaction() as cursor:
            cursor.execute(
                "SELECT * FROM processing.subscribed_jobs WHERE id=%s AND owner=%s",
                (identifier, owner),
            )
            row = cursor.fetchone()
        if not row:
            raise ProcessingError(
                "job_not_found", "This processing job is unavailable.", 404
            )
        return row

    def update_presentation(
        self, identifier: str, owner: str, changes: dict[str, Any]
    ) -> dict[str, Any]:
        """Update an owner's display settings without changing the shared calculation.

        Args:
            identifier: Public job handle belonging to this owner.
            owner: Current browser-session hash.
            changes: Display fields validated by their owning application service.

        Returns:
            The updated owned job, with its execution, files and creation time unchanged.

        Raises:
            ProcessingError: If the job is unowned, deleted or storage is unavailable.
        """
        with self._transaction(acquire_lock=True) as cursor:
            cursor.execute(
                "SELECT * FROM processing.subscribed_jobs WHERE id=%s AND owner=%s",
                (identifier, owner),
            )
            row = cursor.fetchone()
            if row is None:
                raise ProcessingError(
                    "job_not_found", "This processing job is unavailable.", 404
                )
            if row["status"] == "deleted":
                raise ProcessingError("job_deleted", "This run has been deleted.", 409)
            cursor.execute(
                "UPDATE processing.job_subscribers SET "
                "presentation=COALESCE(presentation,'{}'::jsonb)||%s,"
                "updated_at=clock_timestamp() WHERE id=%s AND owner=%s",
                (Jsonb(changes), identifier, owner),
            )
            cursor.execute(
                "SELECT * FROM processing.subscribed_jobs WHERE id=%s AND owner=%s",
                (identifier, owner),
            )
            return cursor.fetchone()

    def list_owned(
        self, owner: str, operations: tuple[str, ...] | None = None
    ) -> list[dict[str, Any]]:
        """Return the recent-job preview used by the existing clip/statistics UI.

        Older jobs remain readable by ID until normal retention removes them.
        Model history uses the separate paginated query instead of this preview.

        Args:
            owner: Hash of the requesting browser's Processing session cookie.
            operations: Optional job types to include before choosing the newest 50.
                None includes all types in the preview.

        Returns:
            Up to 50 matching jobs for this session, newest first.
        """
        with self._transaction() as cursor:
            cursor.execute(
                "SELECT * FROM processing.subscribed_jobs WHERE owner=%s AND status<>'deleted' "
                + ("AND operation=ANY(%s) " if operations is not None else "")
                + "ORDER BY subscribed_at DESC LIMIT 50",
                (owner, list(operations)) if operations is not None else (owner,),
            )
            return cursor.fetchall()

    def read_owned_jobs(
        self, owner: str, identifiers: list[str]
    ) -> list[dict[str, Any]]:
        """Read requested session-owned jobs in one database query.

        Args:
            owner: Current session hash.
            identifiers: Validated public job IDs, at most 100.

        Returns:
            Matching owned records, including deleted jobs, in unspecified order.
            Foreign and nonexistent IDs are omitted.
        """
        with self._transaction() as cursor:
            cursor.execute(
                "SELECT * FROM processing.subscribed_jobs WHERE owner=%s AND id=ANY(%s)",
                (owner, identifiers),
            )
            return cursor.fetchall()

    def list_session_jobs_page(
        self,
        owner: str,
        operations: tuple[str, ...],
        limit: int,
        before: tuple[datetime, str] | None = None,
    ) -> list[dict[str, Any]]:
        """Return one page of jobs belonging to the requesting browser session.

        The owner value is the hash of the browser's Processing cookie, not a user
        account ID. Filtering by it keeps another browser from listing these jobs.
        The continuation cursor chooses older entries but never grants access to them.

        Args:
            owner: Hash of the requesting browser's Processing session cookie.
            operations: Job types to include, such as ``model.run.v1``.
            limit: Number of rows to read, from one to 101. The caller may read one
                extra row to determine whether another page exists.
            before: Return jobs older than this creation-time and job-ID pair;
                None starts at the newest job.

        Returns:
            Matching, nondeleted jobs for this session, newest first. Equal creation
            times are ordered by job ID so page boundaries stay consistent.

        Raises:
            ValueError: If the page size or operation count is invalid.
            ProcessingError: If job storage is unavailable.
        """
        if not 1 <= limit <= 101 or not 1 <= len(operations) <= 16:
            raise ValueError("Invalid operation page limits")
        with self._transaction() as cursor:
            cursor.execute(
                "SELECT * FROM processing.subscribed_jobs WHERE owner=%s "
                "AND operation=ANY(%s) AND status<>'deleted' "
                + ("AND (created_at,id)<(%s,%s) " if before else "")
                + "ORDER BY created_at DESC,id DESC LIMIT %s",
                (owner, list(operations), *(before or ()), limit),
            )
            return cursor.fetchall()

    def cancel(
        self,
        identifier: str,
        owner: str,
        delete: bool = False,
        undo_seconds: int = 0,
    ) -> dict[str, Any]:
        """Cancel only this subscriber; stop computation when nobody needs it.

        Deleting a completed handle immediately removes that caller's access.
        Files remain while other subscribers, transfers or accepted dependent
        jobs need them. Deletion does not cancel those dependent jobs. An explicit
        Undo window retains the underlying completed job until dismissal or timeout.

        Args:
            identifier: Caller-owned public job handle.
            owner: Current session hash.
            delete: Delete a terminal handle instead of cancelling active work.
            undo_seconds: Optional deletion Undo window, from zero to sixty seconds.
                Retried deletion requests preserve the original window.

        Returns:
            Updated subscriber state, including cancelling while its last worker exits.

        Raises:
            ProcessingError: If the handle is unowned or deletion targets active work.
        """
        if not 0 <= undo_seconds <= 60 or undo_seconds and not delete:
            raise ProcessingError("invalid_deletion", "Invalid deletion Undo window.")
        with self._transaction(acquire_lock=True) as cursor:
            cursor.execute(
                "SELECT * FROM processing.subscribed_jobs WHERE id=%s AND owner=%s",
                (identifier, owner),
            )
            row = cursor.fetchone()
            if not row:
                raise ProcessingError(
                    "job_not_found", "This processing job is unavailable.", 404
                )
            if delete and row["status"] in UNFINISHED:
                raise ProcessingError(
                    "job_active",
                    "Cancel this job and wait for it to stop before deleting it.",
                    409,
                )
            if delete and row["status"] == "deleted":
                return row
            if delete or row["status"] in UNFINISHED:
                cursor.execute(
                    "UPDATE processing.job_subscribers SET status=%s,"
                    "status_before_deletion=status,deletion_id=%s,"
                    "deletion_undo_until=CASE WHEN %s>0 THEN clock_timestamp()+%s*interval '1 second' END,"
                    "updated_at=clock_timestamp() WHERE id=%s",
                    (
                        "deleted" if delete else "cancelled",
                        uuid4().hex if undo_seconds else None,
                        undo_seconds,
                        undo_seconds,
                        identifier,
                    ),
                )
                cursor.execute(
                    "UPDATE processing.jobs SET status=CASE "
                    "WHEN status='queued' THEN 'cancelled' WHEN status='running' THEN 'cancelling' "
                    "WHEN status='ready' THEN 'deleted' ELSE status END,updated_at=clock_timestamp() "
                    "WHERE id=%s AND NOT EXISTS (SELECT 1 FROM processing.job_subscribers WHERE job_id=%s "
                    "AND (status IS NULL OR deletion_undo_until>clock_timestamp())) RETURNING status",
                    (row["job_id"], row["job_id"]),
                )
                stopped = cursor.fetchone()
                if not delete and stopped and stopped["status"] == "cancelling":
                    cursor.execute(
                        "UPDATE processing.job_subscribers SET status='cancelling' WHERE id=%s",
                        (identifier,),
                    )
            cursor.execute(
                "SELECT * FROM processing.subscribed_jobs WHERE id=%s", (identifier,)
            )
            return cursor.fetchone()

    def resolve_deletion(
        self, identifier: str, owner: str, deletion_id: str, restore: bool
    ) -> dict[str, Any]:
        """Undo or finalize one exact deletion without changing result expiry.

        Args:
            identifier: Public job handle belonging to the requesting session.
            owner: Hash of the browser session.
            deletion_id: Identity returned by the deletion being acted on.
            restore: Restore access before the deadline; otherwise end Undo now.

        Returns:
            Current owned job state, including an idempotent repeated restoration.

        Raises:
            ProcessingError: If ownership, deletion identity or the Undo window fails.
        """
        with self._transaction(acquire_lock=True) as cursor:
            cursor.execute(
                "SELECT *,deletion_undo_until>clock_timestamp() AS can_undo "
                "FROM processing.job_subscribers WHERE id=%s AND owner=%s",
                (identifier, owner),
            )
            subscriber = cursor.fetchone()
            if subscriber is None:
                raise ProcessingError(
                    "job_not_found", "This processing job is unavailable.", 404
                )
            if subscriber["deletion_id"] != deletion_id:
                raise ProcessingError(
                    "deletion_changed",
                    "This deletion has changed. Refresh the run list.",
                    409,
                )
            if restore and subscriber["status"] == "deleted":
                if not subscriber["can_undo"]:
                    raise ProcessingError(
                        "undo_expired", "The time to undo this deletion has ended.", 409
                    )
                cursor.execute(
                    "UPDATE processing.job_subscribers SET status=status_before_deletion,"
                    "deletion_undo_until=NULL,updated_at=clock_timestamp() "
                    "WHERE id=%s AND deletion_undo_until>clock_timestamp() RETURNING id",
                    (identifier,),
                )
                if cursor.fetchone() is None:
                    raise ProcessingError(
                        "undo_expired", "The time to undo this deletion has ended.", 409
                    )
            elif not restore and subscriber["status"] == "deleted":
                cursor.execute(
                    "UPDATE processing.job_subscribers SET deletion_undo_until=NULL,"
                    "updated_at=clock_timestamp() WHERE id=%s",
                    (identifier,),
                )
                self._finalize_deleted_jobs(cursor)
            cursor.execute(
                "SELECT * FROM processing.subscribed_jobs WHERE id=%s AND owner=%s",
                (identifier, owner),
            )
            return cursor.fetchone()

    def _finalize_deleted_jobs(self, cursor: Any) -> None:
        """Release deletion holds whose Undo windows ended, within the lifecycle lock.

        Args:
            cursor: Cursor in the caller's locked Processing transaction.
        """
        cursor.execute(
            "UPDATE processing.job_subscribers SET deletion_undo_until=NULL,updated_at=clock_timestamp() "
            "WHERE deletion_undo_until<=clock_timestamp()"
        )
        cursor.execute(
            "UPDATE processing.jobs j SET status='deleted',updated_at=clock_timestamp() "
            "WHERE j.status='ready' AND EXISTS (SELECT 1 FROM processing.job_subscribers s "
            "WHERE s.job_id=j.id AND s.status='deleted' AND s.deletion_id IS NOT NULL) "
            "AND NOT EXISTS (SELECT 1 FROM processing.job_subscribers s WHERE s.job_id=j.id "
            "AND (s.status IS NULL OR s.deletion_undo_until>clock_timestamp()))"
        )

    def extend_result_lifetime(
        self, identifier: str, owner: str, seconds: int
    ) -> dict[str, Any]:
        """Keep an available result and its details until at least now plus a duration.

        Serialize renewal with deletion, expiry and cleanup. Existing later
        deadlines are preserved, and retained bytes and input grants are unchanged.
        The application owner chooses the duration; callers cannot revive expired
        results or details even while another reader still retains the files.

        Args:
            identifier: Caller-owned public job handle.
            owner: Hash of the requesting browser session.
            seconds: Positive retention duration, at most one year.

        Returns:
            The owned job with the same deadline for results and saved details.

        Raises:
            ProcessingError: If ownership, availability or the duration is invalid.
        """
        if not 1 <= seconds <= 31_536_000:
            raise ProcessingError("invalid_retention", "Invalid result lifetime.")
        with self._transaction(acquire_lock=True) as cursor:
            cursor.execute(
                "SELECT *, expires_at>clock_timestamp() AS available "
                "FROM processing.subscribed_jobs WHERE id=%s AND owner=%s",
                (identifier, owner),
            )
            row = cursor.fetchone()
            if row is None:
                raise ProcessingError(
                    "job_not_found", "This processing job is unavailable.", 404
                )
            if (
                row["status"] != "ready"
                or not row["available"]
                or row["artifact"] is None
                or row["retained_metadata"] is None
            ):
                raise ProcessingError(
                    "result_unavailable",
                    "Only a completed run with available files and details can be extended.",
                    409,
                )
            cursor.execute(
                "UPDATE processing.jobs SET "
                "expires_at=greatest(expires_at,metadata_expires_at,statement_timestamp()+%s*interval '1 second'),"
                "metadata_expires_at=greatest(expires_at,metadata_expires_at,statement_timestamp()+%s*interval '1 second'),"
                "updated_at=clock_timestamp() WHERE id=%s "
                "AND expires_at>statement_timestamp() AND metadata_expires_at>statement_timestamp() RETURNING id",
                (seconds, seconds, row["job_id"]),
            )
            if cursor.fetchone() is None:
                raise ProcessingError(
                    "result_unavailable",
                    "This run expired before it could be extended.",
                    409,
                )
            cursor.execute(
                "SELECT * FROM processing.subscribed_jobs WHERE id=%s AND owner=%s",
                (identifier, owner),
            )
            return cursor.fetchone()

    def claim_next_job(self) -> dict[str, Any] | None:
        """Claim the next session's queued job when a worker slot is available.

        Sessions are served by their most recent start, with newcomers first and FIFO
        order within each session. Shared work serves its subscribed sessions together.
        Running and cancelling jobs retain their slots until native exit is confirmed.
        A lost heartbeat never releases capacity. Container replacement interrupts
        unfinished jobs only after the previous worker and its native children stop.
        There is no execution deadline, memory reservation or disk admission gate.

        Returns:
            Claimed job with a new attempt token, or None when no worker slot/job is free.

        Raises:
            ProcessingError: If the database cannot complete the claim.
        """

        with self._transaction(acquire_lock=True) as cursor:
            cursor.execute(
                "SELECT count(*) AS active FROM processing.jobs WHERE status IN ('running','cancelling')"
            )
            if cursor.fetchone()["active"] >= self.limits.worker_count:
                return None
            cursor.execute(
                "SELECT waiting.id,waiting.owner FROM ("
                "SELECT DISTINCT ON (s.owner) j.id,s.owner,j.created_at FROM processing.jobs j "
                "JOIN processing.job_subscribers s ON s.job_id=j.id "
                "WHERE j.status='queued' AND s.status IS NULL "
                "ORDER BY s.owner,j.created_at,j.id) waiting "
                "LEFT JOIN LATERAL (SELECT j.started_at FROM processing.jobs j "
                "JOIN processing.job_subscribers s ON s.job_id=j.id "
                "WHERE s.owner=waiting.owner AND j.started_at IS NOT NULL "
                "ORDER BY j.started_at DESC LIMIT 1) served ON true "
                "ORDER BY served.started_at NULLS FIRST,waiting.created_at,waiting.id LIMIT 1",
            )
            row = cursor.fetchone()
            if not row:
                return None
            cursor.execute(
                "UPDATE processing.jobs SET status='running',attempt_id=%s,lease_until=now()+%s*interval '1 second',deadline_at=NULL,"
                "execution_memory_bytes=0,reserved_bytes=0,required_disk_bytes=0,"
                "started_at=clock_timestamp(),updated_at=now() WHERE id=%s RETURNING *",
                (
                    uuid4().hex,
                    self.limits.lease_seconds,
                    row["id"],
                ),
            )
            claimed = cursor.fetchone()
            claimed["owner"] = row["owner"]
            return claimed

    def heartbeat(
        self, identifier: str, attempt: str, progress: dict[str, Any]
    ) -> bool:
        """Renew one live attempt and report whether work should continue.

        Args:
            identifier: Running job.
            attempt: Current fencing token.
            progress: Bounded, owner-defined progress fields.

        Returns:
            False after cancellation, lost lease, or deadline expiration.
        """
        with self._transaction() as cursor:
            cursor.execute(
                "UPDATE processing.jobs SET lease_until=now()+%s*interval '1 second',progress=CASE WHEN %s::jsonb='{}'::jsonb THEN progress ELSE %s::jsonb END,updated_at=now() WHERE id=%s AND attempt_id=%s AND status='running' AND lease_until>now() RETURNING id",
                (
                    self.limits.lease_seconds,
                    Jsonb(progress),
                    Jsonb(progress),
                    identifier,
                    attempt,
                ),
            )
            return cursor.fetchone() is not None

    def finish(
        self,
        identifier: str,
        attempt: str,
        artifact: Artifact | None,
        error: dict[str, str] | None = None,
        reusable_results: dict[str, dict[str, object]] | None = None,
    ) -> bool:
        """Publish completed work and cache values only while this attempt owns the job.

        Results use the lifetime captured by the operation at admission, when
        supplied; ordinary jobs retain the deployment's result lifetime. Captured
        result and metadata deadlines start together on successful completion.

        Args:
            identifier: Running job.
            attempt: Execution fencing token.
            artifact: Atomically published immutable result, or None on failure.
                Manifest-backed results replace the working reservation with their
                exact retained byte count, including every file and the inventory.
            error: Sanitized reason for a failed or interrupted operation.
            reusable_results: Small completed values keyed by the operation's
                input hash. Stored only if this attempt becomes ready.

        Returns:
            True only if the still-current attempt reached the requested state.

        Raises:
            ProcessingError: If retained files exceed the admitted reservation or
                durable storage is unavailable.
            ValidationError: If the supplied manifest violates its storage contract.
        """
        with self._transaction(acquire_lock=True) as cursor:
            cursor.execute(
                "SELECT * FROM processing.jobs WHERE id=%s AND attempt_id=%s AND status IN ('running','cancelling') FOR UPDATE",
                (identifier, attempt),
            )
            row = cursor.fetchone()
            if not row:
                return False
            if artifact is not None:
                retained_bytes = artifact.size
                if artifact.manifest is not None:
                    retained_bytes = read_artifact_manifest(
                        artifact.manifest
                    ).total_bytes
                cursor.execute(
                    "UPDATE processing.jobs SET status='ready',artifact=%s,reserved_bytes=%s,expires_at=now()+%s*interval '1 second',updated_at=now(),progress=%s WHERE id=%s AND status='running' AND lease_until>now() RETURNING id",
                    (
                        Jsonb(asdict(artifact)),
                        retained_bytes,
                        row["result_ttl_seconds"] or self.limits.result_ttl_seconds,
                        Jsonb({"phase": "ready"}),
                        identifier,
                    ),
                )
                completed = cursor.fetchone() is not None
                if (
                    completed
                    and reusable_results
                    and self.limits.calculation_cache_capacity > 0
                ):
                    cursor.execute(
                        "DELETE FROM processing.calculation_results WHERE expires_at <= now()"
                    )
                    for key, payload in reusable_results.items():
                        # Leave oversized results uncached rather than failing a completed job.
                        if (
                            len(json.dumps(payload, allow_nan=False).encode("utf-8"))
                            > 32768
                        ):
                            continue
                        cursor.execute(
                            "INSERT INTO processing.calculation_results(cache_key,payload,expires_at) "
                            "VALUES (%s,%s,now()+%s*interval '1 second') ON CONFLICT DO NOTHING",
                            (
                                key,
                                Jsonb(payload),
                                self.limits.calculation_cache_ttl_seconds,
                            ),
                        )
                    cursor.execute(
                        "DELETE FROM processing.calculation_results WHERE cache_key IN "
                        "(SELECT cache_key FROM processing.calculation_results "
                        "ORDER BY created_at DESC,cache_key OFFSET %s)",
                        (self.limits.calculation_cache_capacity,),
                    )
                return completed
            status = (
                "cancelled"
                if row["status"] == "cancelling"
                else (
                    "interrupted"
                    if error and error.get("code") == "interrupted"
                    else "failed"
                )
            )
            cursor.execute(
                "UPDATE processing.jobs SET status=%s,error=%s,updated_at=now() WHERE id=%s",
                (status, Jsonb(error), identifier),
            )
            return True

    def get_cached_calculation_results(
        self, keys: list[str]
    ) -> dict[str, dict[str, object]]:
        """Read unexpired numerical results for operation-generated input hashes.

        Callers must authorize the current raster and area before using these
        shared values. This method returns no job IDs or download permissions.

        Args:
            keys: At most five hashes generated from validated calculation inputs.

        Returns:
            Matching payloads by hash; missing or expired entries are omitted.

        Raises:
            ProcessingError: If PostgreSQL is unavailable.
            ValueError: If more than five keys are requested.
        """
        if len(keys) > 5:
            raise ValueError("At most five cached calculations can be requested")
        if not keys or self.limits.calculation_cache_capacity <= 0:
            return {}
        with self._transaction() as cursor:
            cursor.execute(
                "SELECT cache_key,payload FROM processing.calculation_results "
                "WHERE cache_key=ANY(%s) AND expires_at>now()",
                (keys,),
            )
            return {row["cache_key"]: row["payload"] for row in cursor.fetchall()}

    def acquire_transfer(
        self, identifier: str, owner: str
    ) -> tuple[dict[str, Any], str]:
        """Atomically acquire a result lease before worker expiry can remove it.

        Args:
            identifier: Owned ready job.
            owner: Current session hash.

        Returns:
            Job metadata and renewable opaque transfer ID.

        Raises:
            ProcessingError: If the result is unavailable or transfer capacity is full.
        """
        with self._transaction(acquire_lock=True) as cursor:
            cursor.execute("DELETE FROM processing.transfers WHERE expires_at<=now()")
            cursor.execute(
                "SELECT * FROM processing.subscribed_jobs WHERE id=%s AND owner=%s",
                (identifier, owner),
            )
            row = cursor.fetchone()
            if not row:
                raise ProcessingError(
                    "job_not_found", "This processing job is unavailable.", 404
                )
            cursor.execute(
                "SELECT id FROM processing.jobs WHERE id=%s AND status='ready' AND expires_at>now()",
                (row["job_id"],),
            )
            if not cursor.fetchone() or row["status"] != "ready":
                raise ProcessingError(
                    "result_unavailable",
                    "This job result is not ready or its download has expired.",
                    409,
                )
            cursor.execute(
                "SELECT count(*) AS total, count(*) FILTER (WHERE job_id=%s) AS count FROM processing.transfers",
                (row["job_id"],),
            )
            transfers = cursor.fetchone()
            if transfers["count"] >= 4 or transfers["total"] >= 64:
                raise ProcessingError(
                    "download_busy",
                    "Too many downloads of this job result are already open.",
                    429,
                )
            lease = uuid4().hex
            cursor.execute(
                "INSERT INTO processing.transfers VALUES (%s,%s,now()+%s*interval '1 second')",
                (lease, row["job_id"], self.limits.transfer_seconds),
            )
            return row, lease

    def transfer_heartbeat(self, lease: str, release: bool = False) -> bool:
        """Renew or release a bounded download lease.

        Args:
            lease: Opaque transfer ID minted by acquire_transfer.
            release: Delete the lease after response completion/disconnection.

        Returns:
            Whether the transfer lease still exists.
        """
        with self._transaction() as cursor:
            if release:
                cursor.execute(
                    "DELETE FROM processing.transfers WHERE id=%s RETURNING id",
                    (lease,),
                )
            else:
                cursor.execute(
                    "UPDATE processing.transfers SET expires_at=now()+%s*interval '1 second' WHERE id=%s AND expires_at>now() RETURNING id",
                    (self.limits.transfer_seconds, lease),
                )
            return cursor.fetchone() is not None

    def available_result(self, identifier: str) -> dict[str, Any] | None:
        """Read current result metadata for trusted lifecycle reconciliation.

        This internal lookup does not authorize a user or grant file access.

        Args:
            identifier: Opaque result handle previously registered by the application.

        Returns:
            An unexpired ready result, or None after expiry, deletion or cleanup.

        Raises:
            ProcessingError: If the database is unavailable; callers must retry.
        """
        with self._transaction() as cursor:
            cursor.execute(
                "SELECT * FROM processing.subscribed_jobs WHERE id=%s AND status='ready' AND expires_at>now()",
                (identifier,),
            )
            return cursor.fetchone()

    def cleanup_candidates(self) -> list[dict[str, Any]]:
        """Prune old job records, expire inputs/results, and find removable files.

        Already-cleaned terminal jobs are forgotten seven days after their last
        update, once their saved metadata has also expired and no transfer is active.
        Pruning runs even when no files need removal; submission and individual
        cleanup acknowledgements do not prune.

        Returns:
            At most 100 rows with no active transfer or dependent job; budgets remain reserved
            until the worker confirms filesystem cleanup.

        Raises:
            ProcessingError: If the database cannot update expiration or read jobs.
        """
        with self._transaction(acquire_lock=True) as cursor:
            cursor.execute("DELETE FROM processing.inputs WHERE expires_at<=now()")
            cursor.execute("DELETE FROM processing.transfers WHERE expires_at<=now()")
            self._delete_old_job_records(cursor)
            self._finalize_deleted_jobs(cursor)
            cursor.execute(
                "UPDATE processing.jobs SET retained_metadata=NULL,retained_outcome=NULL "
                "WHERE metadata_expires_at<=now() AND retained_metadata IS NOT NULL"
            )
            cursor.execute(
                "UPDATE processing.jobs SET status='expired',updated_at=now() WHERE status='ready' AND expires_at<=now()"
            )
            cursor.execute(
                "SELECT j.* FROM processing.jobs j WHERE j.status NOT IN ('queued','running','cancelling','ready') AND (j.reserved_bytes>0 OR j.spec IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM processing.transfers t WHERE t.job_id=j.id) AND NOT EXISTS (SELECT 1 FROM processing.input_files i WHERE i.parent_id=j.id) ORDER BY j.updated_at LIMIT 100"
            )
            return cursor.fetchall()

    def cleaned(self, identifier: str) -> None:
        """Release storage and operation payloads only after successful file removal.

        Args:
            identifier: Terminal job with completed cleanup.
        """
        with self._transaction(acquire_lock=True) as cursor:
            cursor.execute(
                "UPDATE processing.jobs SET reserved_bytes=0,spec=NULL,artifact=NULL WHERE id=%s AND status NOT IN ('queued','running','cancelling','ready') AND NOT EXISTS (SELECT 1 FROM processing.transfers WHERE job_id=%s) AND NOT EXISTS (SELECT 1 FROM processing.input_files WHERE parent_id=jobs.id)",
                (identifier, identifier),
            )

    def _delete_old_job_records(self, cursor: Any) -> None:
        """Delete cleaned jobs once both retry history and saved metadata have expired.

        Retry records last seven days after the last update. A longer configured
        metadata lifetime keeps the record available until that deadline as well.
        An unexpired deletion Undo window retains the history row, without
        extending access to its already-expired metadata or files.

        Args:
            cursor: Cursor inside the worker maintenance transaction holding the
                Processing advisory lock.
        """

        cursor.execute(
            "DELETE FROM processing.jobs WHERE reserved_bytes=0 AND spec IS NULL "
            "AND status NOT IN ('queued','running','cancelling','ready') "
            "AND updated_at<now()-interval '7 days' "
            "AND (metadata_expires_at IS NULL OR metadata_expires_at<=now()) "
            "AND NOT EXISTS (SELECT 1 FROM processing.transfers WHERE job_id=jobs.id) "
            "AND NOT EXISTS (SELECT 1 FROM processing.input_files WHERE parent_id=jobs.id) "
            "AND NOT EXISTS (SELECT 1 FROM processing.job_subscribers WHERE job_id=jobs.id "
            "AND deletion_undo_until>clock_timestamp())"
        )

    def active_attempts(self) -> set[str]:
        """Read attempt IDs that still own files, including ready results.

        Returns:
            IDs retained for active, ready, or transfer-leased jobs.
        """
        with self._transaction() as cursor:
            cursor.execute(
                "SELECT attempt_id FROM processing.jobs WHERE attempt_id IS NOT NULL AND (reserved_bytes>0 OR status IN ('running','cancelling','ready'))"
            )
            return {row["attempt_id"] for row in cursor.fetchall()}
