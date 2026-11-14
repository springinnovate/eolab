"""Exercise concurrent pgSTAC ingestion against an explicitly disposable database."""

from __future__ import annotations

from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import os
import json
from pathlib import Path
import time
from typing import Any, Iterator
from uuid import uuid4
from urllib.parse import parse_qs, urlsplit

import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb
import pytest

MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "catalog/migrations/0007_partition_maintenance_locking.sql"
)
BASE_TIME = datetime(2020, 1, 1, tzinfo=timezone.utc)
UNSAFE_NOTICES = {"40P01", "23514"}
CONTROLLER_APPLICATION_NAME = "catalog-barrier-controller"


@dataclass(frozen=True)
class CatalogDatabase:
    """Identify the disposable database and its original public function contracts.

    Attributes:
        dsn: Explicit connection string whose database name passed the safety guard.
        original_contracts: Signatures, privileges and execution attributes before
            applying the application migration.
    """

    dsn: str
    original_contracts: list[tuple[Any, ...]]


@dataclass(frozen=True)
class IngestionResult:
    """Record one real SQL ingestion outcome and every server warning it emitted.

    Attributes:
        application_name: Unique writer identity visible in PostgreSQL diagnostics.
        error: SQLSTATE and message when PostgreSQL rejected the transaction.
        notices: SQLSTATE and message pairs delivered by the connection notice handler.
    """

    application_name: str
    error: tuple[str | None, str] | None
    notices: tuple[tuple[str | None, str | None], ...]


def function_contracts(connection: psycopg.Connection[Any]) -> list[tuple[Any, ...]]:
    """Return the existing ingestion functions' signatures and execution privileges.

    Args:
        connection: Open connection to the guarded test database.

    Returns:
        Stable catalog rows for the existing functions the migration may replace.
    """
    return connection.execute("""
        SELECT p.proname, pg_get_function_identity_arguments(p.oid),
               pg_get_function_result(p.oid), p.prosecdef, p.provolatile,
               p.proisstrict, p.proparallel, p.proconfig, p.proacl::text, p.proowner
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'pgstac'
          AND p.proname IN (
              'check_partition', 'items_staging_triggerfunc', 'get_tstz_constraint'
          )
        ORDER BY p.proname
        """).fetchall()


@pytest.fixture(scope="session")
def catalog_database() -> CatalogDatabase:
    """Apply the fix twice only to an explicitly selected disposable pgSTAC database.

    Returns:
        Guarded connection details and the original ingestion function contracts.

    Raises:
        pytest.fail.Exception: If either the requested or connected database is unsafe,
            the pinned pgSTAC version is absent, or the fix file is missing.
    """
    dsn = os.environ.get("EOLAB_CATALOG_TEST_DSN")
    if dsn is None:
        pytest.skip("Run scripts/test_catalog_postgres.py for real pgSTAC tests")
    if (
        not psycopg.conninfo.conninfo_to_dict(dsn)
        .get("dbname", "")
        .startswith("eolab_catalog_test_")
    ):
        pytest.fail("Catalog tests require an explicit eolab_catalog_test_ database")
    with psycopg.connect(dsn, autocommit=True) as connection:
        if not connection.info.dbname.startswith("eolab_catalog_test_"):
            pytest.fail("The connected catalog database must be disposable")
        assert connection.execute("SELECT pgstac.get_version()").fetchone() == (
            "0.9.12",
        )
        contracts = function_contracts(connection)
        assert len(contracts) == 3
        if not MIGRATION.is_file():
            pytest.fail(f"Missing catalog migration: {MIGRATION.name}")
        migration = MIGRATION.read_text(encoding="utf-8")
        connection.execute(migration, prepare=False)
        connection.execute(migration, prepare=False)
    return CatalogDatabase(dsn, contracts)


@contextmanager
def collection(database: CatalogDatabase, *, monthly: bool = False) -> Iterator[str]:
    """Create and remove one test-owned STAC collection after its connections close.

    Args:
        database: Guarded disposable database containing pgSTAC.
        monthly: Partition observations by month for the mixed maintenance case.

    Yields:
        Unique collection identity used by the real pgSTAC ingestion functions.
    """
    identifier = "catalog-ingestion-" + uuid4().hex
    document = {
        "type": "Collection",
        "stac_version": "1.0.0",
        "id": identifier,
        "description": "Disposable concurrent ingestion fixture",
        "license": "other",
        "extent": {
            "spatial": {"bbox": [[0, 0, 1, 1]]},
            "temporal": {"interval": [[None, None]]},
        },
        "links": [],
    }
    with psycopg.connect(database.dsn, autocommit=True) as connection:
        connection.execute("SET search_path TO pgstac, public")
        connection.execute("SELECT pgstac.create_collection(%s)", (Jsonb(document),))
        if monthly:
            connection.execute(
                "UPDATE pgstac.collections SET partition_trunc='month' WHERE id=%s",
                (identifier,),
            )
    try:
        yield identifier
    finally:
        with psycopg.connect(database.dsn, autocommit=True) as connection:
            connection.execute("SELECT pgstac.delete_collection(%s)", (identifier,))


def items(identifier: str, prefix: str, first: int, last: int) -> list[dict[str, Any]]:
    """Create 100 distinct valid STAC Items spanning the requested relative hours.

    Args:
        identifier: Owning collection identity.
        prefix: Unique prefix for this batch's item identifiers.
        first: Earliest hour relative to January 1, 2020 UTC.
        last: Latest hour relative to January 1, 2020 UTC.

    Returns:
        One complete batch with precise UTC timestamps and a simple valid footprint.
    """
    return [
        {
            "type": "Feature",
            "stac_version": "1.0.0",
            "id": f"{prefix}-{index:03}",
            "collection": identifier,
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
            },
            "bbox": [0, 0, 1, 1],
            "properties": {
                "datetime": (
                    BASE_TIME + timedelta(hours=first + (last - first) * index / 99)
                ).isoformat()
            },
            "assets": {},
            "links": [],
        }
        for index in range(100)
    ]


def ingest(
    database: CatalogDatabase,
    application_name: str,
    batch: list[dict[str, Any]],
    *,
    use_queue: bool = False,
) -> IngestionResult:
    """Execute one actual pgSTAC upsert transaction and retain warnings and failures.

    Args:
        database: Guarded disposable database.
        application_name: Writer identity for coordinating test-only SQL barriers.
        batch: Complete STAC batch, including collection and unique item identities.
        use_queue: Defer upstream's optional index and statistics maintenance.

    Returns:
        The transaction's SQL error, if any, and its synchronous server notices.
    """
    notices: list[tuple[str | None, str | None]] = []

    def notice(diagnostic: psycopg.errors.Diagnostic) -> None:
        """Retain a server notice before its connection-owned diagnostic expires.

        Args:
            diagnostic: Server-provided SQLSTATE and primary message.
        """
        notices.append((diagnostic.sqlstate, diagnostic.message_primary))

    error = None
    with psycopg.connect(
        database.dsn, application_name=application_name, autocommit=True
    ) as connection:
        connection.add_notice_handler(notice)
        connection.execute("SET statement_timeout='20s'")
        connection.execute("SET deadlock_timeout='100ms'")
        connection.execute(
            "SELECT set_config('pgstac.use_queue', %s, false)",
            ("true" if use_queue else "false",),
        )
        try:
            connection.execute("SELECT pgstac.upsert_items(%s)", (Jsonb(batch),))
        except psycopg.Error as failure:
            error = failure.sqlstate, str(failure)
        connection.execute("SELECT pg_stat_force_next_flush()")
    return IngestionResult(application_name, error, tuple(notices))


def wait_for_writers(
    connection: psycopg.Connection[Any],
    names: list[str],
    blocker: str | None = None,
    *,
    any_writer: bool = False,
) -> None:
    """Wait for the selected writers to block at a real SQL lock boundary.

    Args:
        connection: Independent autocommit observer connection.
        names: Writer application names that must all be waiting on locks.
        blocker: Optional writer name that must appear among their blockers.
        any_writer: Return when any named writer reaches the requested blocker.

    Raises:
        AssertionError: If the required SQL schedule is not reached in ten seconds.
    """
    deadline = time.monotonic() + 10
    rows: list[tuple[Any, ...]] = []
    while time.monotonic() < deadline:
        connection.execute("SELECT pg_stat_clear_snapshot()")
        rows = connection.execute(
            """
            SELECT a.application_name, a.wait_event_type,
                   ARRAY(SELECT b.application_name FROM pg_stat_activity b
                         WHERE b.pid = ANY(pg_blocking_pids(a.pid)))
            FROM pg_stat_activity a WHERE a.application_name = ANY(%s)
            """,
            (names,),
        ).fetchall()
        matches = [
            row[1] == "Lock" and (blocker is None or blocker in row[2]) for row in rows
        ]
        if (any_writer and any(matches)) or (len(rows) == len(names) and all(matches)):
            return
        time.sleep(0.01)
    raise AssertionError(f"Writers did not reach the required lock schedule: {rows}")


@contextmanager
def statistics_barriers(
    database: CatalogDatabase, names: list[str]
) -> Iterator[tuple[psycopg.Connection[Any], list[int]]]:
    """Pause selected writers after the real partition-statistics statement locks rows.

    The test trigger changes no production function or data semantics. Statement
    triggers also run when an ON CONFLICT statement changes zero rows, which lets
    the schedule expose the original no-op statistics-row lock inversion.

    Args:
        database: Guarded disposable database.
        names: Writer identities paused on corresponding controller-owned keys.

    Yields:
        Autocommit controller and advisory keys that release the selected writers.
    """
    suffix = uuid4().hex
    function = "pause_stats_" + suffix
    keys = [int(suffix[:12], 16) + index for index in range(len(names))]
    with psycopg.connect(
        database.dsn,
        application_name=CONTROLLER_APPLICATION_NAME,
        autocommit=True,
    ) as control:
        clauses = "\n".join(
            f"IF current_setting('application_name') = {sql.Literal(name).as_string(control)} THEN PERFORM pg_advisory_xact_lock({key}); END IF;"
            for name, key in zip(names, keys, strict=True)
        )
        control.execute("CREATE SCHEMA IF NOT EXISTS catalog_test")
        control.execute(
            sql.SQL(
                "CREATE FUNCTION catalog_test.{}() RETURNS trigger LANGUAGE plpgsql "
                "AS $body$ BEGIN " + clauses + " RETURN NULL; END; $body$"
            ).format(sql.Identifier(function))
        )
        control.execute(
            sql.SQL(
                "CREATE TRIGGER {} AFTER INSERT ON pgstac.partition_stats "
                "FOR EACH STATEMENT EXECUTE FUNCTION catalog_test.{}()"
            ).format(sql.Identifier(function), sql.Identifier(function))
        )
        for key in keys:
            control.execute("SELECT pg_advisory_lock(%s)", (key,))
        try:
            yield control, keys
        finally:
            control.execute("SELECT pg_advisory_unlock_all()")
            control.execute(
                sql.SQL("DROP TRIGGER {} ON pgstac.partition_stats").format(
                    sql.Identifier(function)
                )
            )
            control.execute(
                sql.SQL("DROP FUNCTION catalog_test.{}()").format(
                    sql.Identifier(function)
                )
            )


def deadlocks(connection: psycopg.Connection[Any]) -> int:
    """Return a fresh deadlock counter for this disposable database.

    Args:
        connection: Observer connection after writer statistics have been flushed.

    Returns:
        PostgreSQL's database-level deadlock count, including caught deadlocks.
    """
    connection.execute("SELECT pg_stat_clear_snapshot()")
    row = connection.execute(
        "SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()"
    ).fetchone()
    assert row is not None
    return int(row[0])


def assert_complete(
    database: CatalogDatabase,
    identifier: str,
    batches: list[list[dict[str, Any]]],
    results: list[IngestionResult],
    initial_deadlocks: int,
    *,
    deferred_constraints: bool = False,
) -> None:
    """Require committed items, validated constraints and no hidden concurrency failures.

    Args:
        database: Guarded disposable database.
        identifier: Collection whose complete expected item set is checked.
        batches: Every batch that should have committed, including seed data.
        results: Real SQL outcomes from the concurrent writers.
        initial_deadlocks: Counter measured before running these writers.
        deferred_constraints: Check queued maintenance and published partition identity
            instead of requiring optional CHECK maintenance to have run already.
    """
    diagnostics = [
        (
            result.application_name,
            result.error,
            tuple(
                notice
                for notice in result.notices
                if notice[0] in UNSAFE_NOTICES
                or "Issue Altering Constraints" in (notice[1] or "")
            ),
        )
        for result in results
    ]
    if any(error is not None or notices for _, error, notices in diagnostics):
        print(f"Catalog ingestion failures: {diagnostics!r}", flush=True)
    assert all(result.error is None for result in results), results
    assert not [
        (result.application_name, notice)
        for result in results
        for notice in result.notices
        if notice[0] in UNSAFE_NOTICES
        or "Issue Altering Constraints" in (notice[1] or "")
    ], results
    with psycopg.connect(database.dsn, autocommit=True) as connection:
        assert deadlocks(connection) == initial_deadlocks
        expected = {item["id"] for batch in batches for item in batch}
        actual = {
            row[0]
            for row in connection.execute(
                "SELECT id FROM pgstac.items WHERE collection=%s", (identifier,)
            )
        }
        assert actual == expected
        if deferred_constraints:
            assert (
                connection.execute(
                    "SELECT count(*) FROM pgstac.partition_stats WHERE collection=%s",
                    (identifier,),
                ).fetchone()[0]
                > 0
            )
            assert (
                connection.execute(
                    "SELECT count(*) FROM pgstac.query_queue"
                ).fetchone()[0]
                > 0
            )
            return
        constraints = connection.execute(
            """
            SELECT c.conname, c.convalidated
            FROM pgstac.partition_stats ps
            JOIN pg_class r ON r.relname=ps.partition
            JOIN pg_namespace n ON n.oid=r.relnamespace AND n.nspname='pgstac'
            JOIN pg_constraint c ON c.conrelid=r.oid AND c.contype='c'
            WHERE ps.collection=%s
            """,
            (identifier,),
        ).fetchall()
        partition_count = connection.execute(
            "SELECT count(*) FROM pgstac.partition_stats WHERE collection=%s",
            (identifier,),
        ).fetchone()[0]
        assert len(constraints) >= partition_count > 0
        assert all(validated for _, validated in constraints), constraints


def test_migration_repeats_without_changing_ingestion_contracts(
    catalog_database: CatalogDatabase,
) -> None:
    """Keep upstream signatures and privileges while replaying the migration twice.

    Args:
        catalog_database: Database whose fixture applied the migration twice.
    """
    with psycopg.connect(catalog_database.dsn, autocommit=True) as connection:
        assert function_contracts(connection) == catalog_database.original_contracts
        public_definers = connection.execute("""
            SELECT p.proname FROM pg_proc p
            JOIN pg_namespace n ON n.oid=p.pronamespace
            CROSS JOIN LATERAL aclexplode(
                coalesce(p.proacl, acldefault('f', p.proowner))) a
            WHERE n.nspname='pgstac' AND p.prosecdef
              AND a.grantee=0 AND a.privilege_type='EXECUTE'
            """).fetchall()
        assert public_definers == []


def test_existing_ingest_role_can_create_and_widen_partitions(
    catalog_database: CatalogDatabase,
) -> None:
    """Keep cold creation and widening available through the existing ingestion role.

    Args:
        catalog_database: Guarded disposable database containing the migration.
    """
    with collection(catalog_database) as identifier:
        batches = [
            items(identifier, "initial", 10, 20),
            items(identifier, "wider", 0, 30),
        ]
        notices: list[tuple[str | None, str | None]] = []

        def notice(diagnostic: psycopg.errors.Diagnostic) -> None:
            """Retain warnings emitted while the connection acts as pgstac_ingest.

            Args:
                diagnostic: Server-provided warning SQLSTATE and primary message.
            """
            notices.append((diagnostic.sqlstate, diagnostic.message_primary))

        with psycopg.connect(catalog_database.dsn, autocommit=True) as connection:
            initial = deadlocks(connection)
            connection.add_notice_handler(notice)
            connection.execute("SET ROLE pgstac_ingest")
            for batch in batches:
                connection.execute("SELECT pgstac.upsert_items(%s)", (Jsonb(batch),))
            connection.execute("RESET ROLE")
            connection.execute("SELECT pg_stat_force_next_flush()")
        result = IngestionResult("pgstac_ingest", None, tuple(notices))
        assert_complete(catalog_database, identifier, batches, [result], initial)


def test_parallel_cold_ingestion(catalog_database: CatalogDatabase) -> None:
    """Reproduce cold-partition stale bounds with four real 100-item writers.

    Args:
        catalog_database: Guarded disposable database containing the migration.
    """
    with collection(catalog_database) as identifier:
        prefix = uuid4().hex
        names = [f"{prefix}-{letter}" for letter in "abcd"]
        batches = [
            items(identifier, "a", 10, 19),
            items(identifier, "b", 0, 9),
            items(identifier, "c", 20, 29),
            items(identifier, "d", 30, 39),
        ]
        with statistics_barriers(catalog_database, names[:2]) as (control, keys):
            initial = deadlocks(control)
            scheduling_failure: AssertionError | None = None
            with ThreadPoolExecutor(max_workers=4) as pool:
                futures = [pool.submit(ingest, catalog_database, names[0], batches[0])]
                try:
                    wait_for_writers(control, names[:1], CONTROLLER_APPLICATION_NAME)
                    futures.append(
                        pool.submit(ingest, catalog_database, names[1], batches[1])
                    )
                    wait_for_writers(control, names[1:2], names[0])
                    control.execute("SELECT pg_advisory_unlock(%s)", (keys[0],))
                    wait_for_writers(control, names[1:2], CONTROLLER_APPLICATION_NAME)
                    # B's stale constraint failure releases its inner DDL lock.
                    # Fresh C/D now attempt existing-partition maintenance while
                    # B still holds the real statistics row lock.
                    futures.extend(
                        pool.submit(ingest, catalog_database, name, batch)
                        for name, batch in zip(names[2:], batches[2:], strict=True)
                    )
                    wait_for_writers(control, names[2:], names[1], any_writer=True)
                except AssertionError as failure:
                    # A deadlock victim can exit before the next barrier probe.
                    # Preserve all real SQL outcomes before reporting the schedule.
                    scheduling_failure = failure
                finally:
                    control.execute("SELECT pg_advisory_unlock_all()")
                results = [future.result(timeout=25) for future in futures]
            observed_deadlocks = deadlocks(control) - initial
            if scheduling_failure is not None:
                print(
                    f"Cold ingestion schedule failed: {scheduling_failure}; "
                    f"database_deadlocks={observed_deadlocks}; "
                    f"writer_errors={[(result.application_name, result.error) for result in results]!r}",
                    flush=True,
                )
            assert_complete(catalog_database, identifier, batches, results, initial)
            if scheduling_failure is not None:
                raise scheduling_failure


def test_parallel_widening_preserves_committed_bounds(
    catalog_database: CatalogDatabase,
) -> None:
    """Widen one existing partition using fresh committed bounds after waiting.

    Args:
        catalog_database: Guarded database containing the reviewed migration.
    """
    with collection(catalog_database) as identifier:
        seed = items(identifier, "seed", 20, 29)
        assert ingest(catalog_database, "seed", seed).error is None
        batches = [
            items(identifier, str(index), index * 10, index * 10 + 9)
            for index in range(4)
        ]
        names = [f"{uuid4().hex}-{index}" for index in range(4)]
        with psycopg.connect(catalog_database.dsn, autocommit=True) as control:
            initial = deadlocks(control)
            partition = control.execute(
                "SELECT partition FROM pgstac.partition_stats WHERE collection=%s",
                (identifier,),
            ).fetchone()[0]
            control.execute("BEGIN")
            control.execute(
                sql.SQL("LOCK TABLE pgstac.{} IN SHARE MODE").format(
                    sql.Identifier(partition)
                )
            )
            with ThreadPoolExecutor(max_workers=4) as pool:
                futures = [
                    pool.submit(ingest, catalog_database, name, batch)
                    for name, batch in zip(names, batches, strict=True)
                ]
                try:
                    wait_for_writers(control, names)
                finally:
                    control.execute("ROLLBACK")
                results = [future.result(timeout=25) for future in futures]
            assert_complete(
                catalog_database, identifier, [seed, *batches], results, initial
            )


def test_covered_batches_keep_four_writers_without_a_maintenance_gate(
    catalog_database: CatalogDatabase,
) -> None:
    """Allow four covered-range writers to reach their existing statistics-row wait.

    Args:
        catalog_database: Guarded database containing the reviewed migration.
    """
    with collection(catalog_database) as identifier:
        seed = items(identifier, "seed", 0, 100)
        assert ingest(catalog_database, "seed", seed).error is None
        batches = [
            items(identifier, str(index), index * 10, index * 10 + 9)
            for index in range(4)
        ]
        names = [f"{uuid4().hex}-{index}" for index in range(4)]
        with statistics_barriers(catalog_database, names[:1]) as (control, _):
            initial = deadlocks(control)
            with ThreadPoolExecutor(max_workers=4) as pool:
                futures = [pool.submit(ingest, catalog_database, names[0], batches[0])]
                try:
                    wait_for_writers(control, names[:1], CONTROLLER_APPLICATION_NAME)
                    futures.extend(
                        pool.submit(ingest, catalog_database, name, batch)
                        for name, batch in zip(names[1:], batches[1:], strict=True)
                    )
                    wait_for_writers(control, names)
                    strong_locks = control.execute(
                        """
                        SELECT a.application_name, l.mode FROM pg_locks l
                        JOIN pg_stat_activity a ON a.pid=l.pid
                        WHERE a.application_name=ANY(%s)
                          AND l.relation='pgstac.items'::regclass
                          AND l.mode NOT IN ('AccessShareLock','RowShareLock','RowExclusiveLock')
                        """,
                        (names,),
                    ).fetchall()
                    assert strong_locks == []
                finally:
                    control.execute("SELECT pg_advisory_unlock_all()")
                results = [future.result(timeout=25) for future in futures]
            assert_complete(
                catalog_database, identifier, [seed, *batches], results, initial
            )


def test_mixed_existing_and_new_partitions_take_the_parent_lock_first(
    catalog_database: CatalogDatabase,
) -> None:
    """Avoid upgrading the parent lock after locking an existing monthly partition.

    Args:
        catalog_database: Guarded database containing the reviewed migration.
    """
    with collection(catalog_database, monthly=True) as identifier:
        january = items(identifier, "january", 24, 48)
        february = items(identifier, "february", 32 * 24, 34 * 24)
        for seed in (january, february):
            assert ingest(catalog_database, "seed", seed).error is None
        batches = [
            [
                *items(identifier, "widen", 0, 72),
                *items(identifier, "new", 61 * 24, 62 * 24),
            ],
            *[
                items(identifier, f"covered-{index}", 32 * 24 + index, 33 * 24 + index)
                for index in range(3)
            ],
        ]
        names = [f"{uuid4().hex}-{index}" for index in range(4)]
        with statistics_barriers(catalog_database, names[:1]) as (control, _):
            initial = deadlocks(control)
            with ThreadPoolExecutor(max_workers=4) as pool:
                futures: list[Future[IngestionResult]] = [
                    pool.submit(ingest, catalog_database, names[0], batches[0])
                ]
                try:
                    wait_for_writers(control, names[:1], CONTROLLER_APPLICATION_NAME)
                    futures.extend(
                        pool.submit(ingest, catalog_database, name, batch)
                        for name, batch in zip(names[1:], batches[1:], strict=True)
                    )
                    wait_for_writers(control, names[1:], names[0])
                finally:
                    control.execute("SELECT pg_advisory_unlock_all()")
                results = [future.result(timeout=25) for future in futures]
            assert_complete(
                catalog_database,
                identifier,
                [january, february, *batches],
                results,
                initial,
            )


def test_existing_partition_publishes_its_missing_statistics_identity(
    catalog_database: CatalogDatabase,
) -> None:
    """Keep an existing physical partition searchable when its identity is unpublished.

    Args:
        catalog_database: Guarded disposable database containing the migration.
    """
    with collection(catalog_database) as identifier:
        seed = items(identifier, "seed", 0, 100)
        assert ingest(catalog_database, "seed", seed).error is None
        with psycopg.connect(catalog_database.dsn, autocommit=True) as connection:
            initial = deadlocks(connection)
            connection.execute(
                "DELETE FROM pgstac.partition_stats WHERE collection=%s",
                (identifier,),
            )
        batch = items(identifier, "covered", 10, 20)
        result = ingest(catalog_database, "publish-identity", batch)
        assert_complete(catalog_database, identifier, [seed, batch], [result], initial)


def test_queued_maintenance_still_publishes_concurrent_items(
    catalog_database: CatalogDatabase,
) -> None:
    """Publish partition identities and items while optional maintenance stays queued.

    Args:
        catalog_database: Guarded disposable database containing the migration.
    """
    with collection(catalog_database) as identifier:
        batches = [
            items(identifier, str(index), index * 10, index * 10 + 9)
            for index in range(4)
        ]
        names = [f"{uuid4().hex}-{index}" for index in range(4)]
        with statistics_barriers(catalog_database, names[:1]) as (control, _):
            initial = deadlocks(control)
            with ThreadPoolExecutor(max_workers=4) as pool:
                futures = [
                    pool.submit(
                        ingest, catalog_database, names[0], batches[0], use_queue=True
                    )
                ]
                try:
                    wait_for_writers(control, names[:1], CONTROLLER_APPLICATION_NAME)
                    futures.extend(
                        pool.submit(
                            ingest, catalog_database, name, batch, use_queue=True
                        )
                        for name, batch in zip(names[1:], batches[1:], strict=True)
                    )
                    wait_for_writers(control, names[1:], names[0])
                finally:
                    control.execute("SELECT pg_advisory_unlock_all()")
                results = [future.result(timeout=25) for future in futures]
            assert_complete(
                catalog_database,
                identifier,
                batches,
                results,
                initial,
                deferred_constraints=True,
            )


def curated_search_item(collection_id: str, item_id: str) -> dict[str, Any]:
    """Return the contract producer's spatial Item in a disposable collection.

    Args:
        collection_id: Test-owned collection created by the guarded fixture.
        item_id: Unique identity for this test's copy of the published fixture.

    Returns:
        The canonical raster Item with its real footprint and complete public
        Item/Asset annotation envelopes. No nonspatial geometry is fabricated.
    """
    fixture = Path(__file__).parent / "fixtures/catalog_descriptors/public-items.json"
    document = json.loads(fixture.read_text(encoding="utf-8"))[0]["item"]
    document["id"] = item_id
    document["collection"] = collection_id
    return document


def curated_text_filter(text: str) -> dict[str, Any]:
    """Build the browser's case-insensitive literal predicate for curated text.

    Args:
        text: Literal search value, including any percent or underscore characters.

    Returns:
        Standard CQL2 predicate over the registered curated-text queryable.
    """
    literal = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return {
        "op": "like",
        "args": [
            {"op": "casei", "args": [{"property": "eolab_metadata_text"}]},
            {"op": "casei", "args": [f"%{literal}%"]},
        ],
    }


def search_curated_items(
    database: CatalogDatabase,
    collection_id: str,
    predicate: dict[str, Any],
    *,
    limit: int = 20,
    token: str | None = None,
    datetime_range: str | None = None,
) -> dict[str, Any]:
    """Execute actual pgSTAC search with exact counts in a disposable collection.

    Args:
        database: Guarded database containing application migrations.
        collection_id: Test-owned collection to isolate matching Items.
        predicate: Standard CQL2 filter emitted by Catalog search.
        limit: Requested page size.
        token: Optional opaque token returned by the preceding search.
        datetime_range: Optional standard STAC observation interval.

    Returns:
        Hydrated STAC ItemCollection with actual matching count and paging links.

    Raises:
        psycopg.Error: If the real search/queryable contract is rejected.
    """
    request: dict[str, Any] = {
        "collections": [collection_id],
        "filter-lang": "cql2-json",
        "filter": predicate,
        "limit": limit,
        "conf": {"context": "on"},
    }
    if token is not None:
        request["token"] = token
    if datetime_range is not None:
        request["datetime"] = datetime_range
    with psycopg.connect(database.dsn, autocommit=True) as connection:
        connection.execute("SET search_path TO pgstac, public")
        connection.execute("SET pgstac.context = 'on'")
        return connection.execute(
            "SELECT pgstac.search(%s)", (Jsonb(request),)
        ).fetchone()[0]


def test_curated_item_and_asset_search_uses_public_values_once(
    catalog_database: CatalogDatabase,
) -> None:
    """Find supplied fields and Asset-only notes without indexing private metadata.

    Args:
        catalog_database: Guarded pgSTAC database with the curated search migration.
    """
    with collection(catalog_database) as identifier:
        document = curated_search_item(identifier, "curated")
        document["assets"]["observations"]["eolab:metadata"]["annotations"]["notes"] = [
            "Unique supporting note: 50%_confidence"
        ]
        document["assets"]["observations"]["eolab:metadata"]["risks"] = [
            "Coastal inundation outlook"
        ]
        document["assets"]["second-table"] = deepcopy(
            document["assets"]["observations"]
        )
        document["properties"]["eolab:private_path"] = "hidden-location-needle"
        document["assets"]["data"]["href"] = "file:///hidden-href-needle"
        document["properties"]["eolab:metadata"]["publications"][0][
            "id"
        ] = "internal-id-needle"
        for private_key in (
            "eolab:temporal-source",
            "eolab:vector-field-values",
            "eolab:asset-source",
            "eolab:descriptor-source",
        ):
            document["assets"][private_key] = {
                "title": "private-title-needle",
                "description": "private-description-needle",
                "eolab:metadata": {
                    "version": 1,
                    "annotations": {"notes": "private-envelope-needle"},
                    "categories": ["private-label-needle"],
                },
            }
            document["properties"]["eolab:metadata"]["annotations"][private_key] = {
                "notes": "public-nested-needle"
            }
            document["assets"]["observations"]["eolab:metadata"]["annotations"][
                "notes"
            ].append({"nested": [{private_key: "public-array-needle"}]})
            document["properties"]["eolab:metadata"]["publications"][0].setdefault(
                "annotations", {}
            )[private_key] = "public-publication-needle"
        assert ingest(catalog_database, "curated", [document]).error is None
        for term in (
            "10.1234/example-flood-dataset",
            "A. Researcher",
            "Compare observed",
            "partial_or_processed",
            "paper-009",
            "Coastal inundation outlook",
            "metres",
            "supporting note",
            "50%_confidence",
            "public-nested-needle",
            "public-array-needle",
            "public-publication-needle",
        ):
            result = search_curated_items(
                catalog_database, identifier, curated_text_filter(term)
            )
            assert [item["id"] for item in result["features"]] == ["curated"], term
            assert result["numberMatched"] == 1
        assert (
            search_curated_items(
                catalog_database,
                identifier,
                {
                    "op": "like",
                    "args": [{"property": "eolab_metadata_text"}, "%metres%"],
                },
            )["numberMatched"]
            == 1
        )
        for term in (
            "hidden-location-needle",
            "hidden-href-needle",
            "internal-id-needle",
            "missing_note",
            "private-title-needle",
            "private-description-needle",
            "private-envelope-needle",
            "private-label-needle",
        ):
            assert (
                search_curated_items(
                    catalog_database, identifier, curated_text_filter(term)
                )["numberMatched"]
                == 0
            ), term
        assert (
            search_curated_items(
                catalog_database,
                identifier,
                {
                    "op": "a_contains",
                    "args": [
                        {"property": "eolab_categories"},
                        ["private-label-needle"],
                    ],
                },
            )["numberMatched"]
            == 0
        )
        with psycopg.connect(catalog_database.dsn, autocommit=True) as connection:
            text = connection.execute(
                "SELECT pgstac.eolab_item_metadata_text(%s)", (Jsonb(document),)
            ).fetchone()[0]
            assert {"0", "false", "true"}.issubset(text.splitlines())
            assert "null" not in text.splitlines()


def test_curated_category_and_text_combine_across_assets_and_keep_pagination(
    catalog_database: CatalogDatabase,
) -> None:
    """Combine an exact category with supplied annotation text across parent Assets.

    Args:
        catalog_database: Guarded database containing category and text queryables.
    """
    with collection(catalog_database) as identifier:
        documents = [
            curated_search_item(identifier, f"curated-{index}") for index in range(3)
        ]
        for document in documents:
            document["assets"]["observations"]["eolab:metadata"]["categories"] = [
                "Coastal protection"
            ]
            document["assets"]["publication"]["eolab:metadata"]["statuses"] = [
                "Reviewed"
            ]
        assert ingest(catalog_database, "labels", documents).error is None
        predicate = {
            "op": "and",
            "args": [
                {
                    "op": "a_contains",
                    "args": [{"property": "eolab_categories"}, ["coastal protection"]],
                },
                curated_text_filter("paper-009"),
                curated_text_filter("flood"),
                curated_text_filter("reviewed"),
            ],
        }
        first = search_curated_items(catalog_database, identifier, predicate, limit=2)
        assert first["numberMatched"] == 3
        assert len(first["features"]) == 2
        next_link = next(link for link in first["links"] if link["rel"] == "next")
        token = parse_qs(urlsplit(next_link["href"]).query)["token"][0]
        second = search_curated_items(
            catalog_database, identifier, predicate, limit=2, token=token
        )
        assert second["numberMatched"] == 3
        assert len(second["features"]) == 1
        assert len({item["id"] for item in first["features"] + second["features"]}) == 3
        assert (
            search_curated_items(
                catalog_database,
                identifier,
                {
                    "op": "a_contains",
                    "args": [{"property": "eolab_categories"}, ["coastal"]],
                },
            )["numberMatched"]
            == 0
        )


def test_curated_replacement_and_removal_do_not_leave_stale_matches(
    catalog_database: CatalogDatabase,
) -> None:
    """Maintain projected search when ordinary publication replaces or removes data.

    Args:
        catalog_database: Guarded database containing the expression indexes.
    """
    with collection(catalog_database) as identifier:
        document = curated_search_item(identifier, "changing")
        assert ingest(catalog_database, "initial", [document]).error is None
        assert (
            search_curated_items(
                catalog_database, identifier, curated_text_filter("metres")
            )["numberMatched"]
            == 1
        )
        document["assets"].pop("observations")
        document["properties"]["eolab:metadata"]["annotations"] = {
            "notes": "Replacement finding"
        }
        assert ingest(catalog_database, "replacement", [document]).error is None
        with psycopg.connect(catalog_database.dsn, autocommit=True) as connection:
            # The existing scanner invalidates authoritative count caches after publication.
            connection.execute("DELETE FROM pgstac.search_wheres")
        for old in ("metres", "partial_or_processed"):
            assert (
                search_curated_items(
                    catalog_database, identifier, curated_text_filter(old)
                )["numberMatched"]
                == 0
            )
        assert (
            search_curated_items(
                catalog_database, identifier, curated_text_filter("Replacement finding")
            )["numberMatched"]
            == 1
        )
        with psycopg.connect(catalog_database.dsn, autocommit=True) as connection:
            connection.execute(
                "DELETE FROM pgstac.items WHERE collection=%s AND id=%s",
                (identifier, document["id"]),
            )
            connection.execute("DELETE FROM pgstac.search_wheres")
        assert (
            search_curated_items(
                catalog_database, identifier, curated_text_filter("Replacement finding")
            )["numberMatched"]
            == 0
        )


def test_observation_dates_exclude_only_explicit_source_modified_times(
    catalog_database: CatalogDatabase,
) -> None:
    """Keep legacy dates and observation intervals while excluding marked file dates.

    Args:
        catalog_database: Guarded database with the timestamp-basis queryable.
    """
    with collection(catalog_database) as identifier:
        observation = curated_search_item(identifier, "observation")
        modified = curated_search_item(identifier, "modified")
        modified["properties"]["eolab:time_basis"] = "source-modified"
        legacy = items(identifier, "legacy", 0, 1)[0]
        legacy["properties"]["title"] = "Legacy searchable title"
        assert (
            ingest(
                catalog_database, "date-basis", [observation, modified, legacy]
            ).error
            is None
        )
        predicate = {
            "op": "or",
            "args": [
                {"op": "isnull", "args": [{"property": "eolab_time_basis"}]},
                {
                    "op": "<>",
                    "args": [{"property": "eolab_time_basis"}, "source-modified"],
                },
            ],
        }
        result = search_curated_items(
            catalog_database,
            identifier,
            predicate,
            datetime_range="2020-01-01T00:00:00Z/2020-12-31T23:59:59Z",
        )
        assert {item["id"] for item in result["features"]} == {
            "observation",
            legacy["id"],
        }
        assert result["numberMatched"] == 2
        title_filter = {
            "op": "like",
            "args": [
                {"op": "casei", "args": [{"property": "title"}]},
                {"op": "casei", "args": ["%LEGACY SEARCHABLE%"]},
            ],
        }
        assert (
            search_curated_items(catalog_database, identifier, title_filter)[
                "numberMatched"
            ]
            == 1
        )


def test_curated_search_migration_replays_and_indexes_selective_queries(
    catalog_database: CatalogDatabase,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Compare real selective query plans with and without index access.

    Report timings as evidence, without a flaky machine-dependent speed threshold.
    Both plans read the same Items and projection; the baseline disables index
    access locally rather than dropping live schema objects.

    Args:
        catalog_database: Guarded database containing all application migrations.
        capsys: Capture controller used to retain timing evidence in successful CI logs.
    """
    migration = (
        Path(__file__).resolve().parents[1]
        / "catalog/migrations/0009_curated_metadata_search.sql"
    )
    with psycopg.connect(catalog_database.dsn, autocommit=True) as connection:
        connection.execute(migration.read_text(), prepare=False)
        connection.execute(migration.read_text(), prepare=False)
    with collection(catalog_database) as identifier:
        base = items(identifier, "plan", 0, 1)[0]
        documents = []
        for index in range(2500):
            document = deepcopy(base)
            document["id"] = f"plan-{index:04}"
            document["properties"]["eolab:metadata"] = {
                "version": 1,
                "annotations": {"notes": f"Common record {index}"},
                "categories": ["Common"],
            }
            documents.append(document)
        documents[-1]["properties"]["eolab:metadata"] = {
            "version": 1,
            "annotations": {"notes": "Distinctive curated needle"},
            "categories": ["Distinctive category"],
        }
        assert ingest(catalog_database, "query-plan", documents).error is None
        with psycopg.connect(catalog_database.dsn, autocommit=True) as connection:
            connection.execute("SET search_path TO pgstac, public")
            partition = connection.execute(
                "SELECT tableoid::regclass::text FROM pgstac.items WHERE collection=%s LIMIT 1",
                (identifier,),
            ).fetchone()[0]
            connection.execute(
                sql.SQL("ANALYZE {}.{}").format(
                    sql.Identifier("pgstac"), sql.Identifier(partition.split(".")[-1])
                )
            )
            for predicate in (
                curated_text_filter("Distinctive curated needle"),
                {
                    "op": "a_contains",
                    "args": [
                        {"property": "eolab_categories"},
                        ["distinctive category"],
                    ],
                },
            ):
                where = connection.execute(
                    "SELECT pgstac.stac_search_to_where(%s)",
                    (
                        Jsonb(
                            {
                                "collections": [identifier],
                                "filter-lang": "cql2-json",
                                "filter": predicate,
                            }
                        ),
                    ),
                ).fetchone()[0]
                query = sql.SQL(
                    "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM pgstac.items WHERE {} "
                ).format(sql.SQL(where))
                with connection.transaction():
                    connection.execute(
                        "SET LOCAL enable_bitmapscan=off; SET LOCAL enable_indexscan=off; SET LOCAL enable_indexonlyscan=off"
                    )
                    baseline = connection.execute(query).fetchone()[0][0]
                with connection.transaction():
                    connection.execute("SET LOCAL enable_seqscan=off")
                    indexed = connection.execute(query).fetchone()[0][0]
                assert (
                    baseline["Plan"]["Actual Rows"]
                    == indexed["Plan"]["Actual Rows"]
                    == 1
                )
                indexed_plan = json.dumps(indexed["Plan"])
                assert "Bitmap Index Scan" in indexed_plan
                expression = (
                    "eolab_item_metadata_text"
                    if predicate["op"] == "like"
                    else "eolab_item_metadata_labels"
                )
                assert expression in indexed_plan
                with capsys.disabled():
                    print(
                        json.dumps(
                            {
                                "curated_query": predicate,
                                "rows": len(documents),
                                "baseline_ms": baseline["Execution Time"],
                                "indexed_ms": indexed["Execution Time"],
                                "baseline_plan": baseline["Plan"],
                                "indexed_plan": indexed["Plan"],
                            }
                        ),
                        flush=True,
                    )
