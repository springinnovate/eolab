"""Remember Catalog selections requested for Habitat input preparation.

These references outlive preparation jobs, but do not assert current cache
coverage. Catalog selections retain their existing source, layer and filter
identity; this module creates no separate named area or public identifier.
"""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Protocol, TYPE_CHECKING

from pydantic import ValidationError
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from eolab_app.catalog_selection import (
    CatalogSelection,
    CatalogSelectionReader,
    SelectionUnavailableError,
)
from eolab_app.processing.models import ProcessingError

if TYPE_CHECKING:
    from eolab_app.processing.habitat_earth_engine import HabitatCacheCoverage
    from eolab_app.processing.habitat_models import HabitatRequest
    from eolab_app.processing.ports import JobStore


class HabitatPreparationSelections(Protocol):
    """Remember exact Catalog selections independently of preparation-job retention."""

    def record(self, selection: CatalogSelection) -> None:
        """Record that an administrator requested inputs for this selection.

        Args:
            selection: Authorized Catalog source, layer and exact feature filter.

        Raises:
            ProcessingError: If persistence is unavailable.
        """
        ...

    def contains(self, selection: CatalogSelection) -> bool:
        """Check whether preparation was requested for this exact Catalog selection.

        Args:
            selection: Validated original-source descriptor and predicate.

        Returns:
            True when the selection has a preparation reference, regardless of coverage.

        Raises:
            ProcessingError: If persistence is unavailable.
        """
        ...

    def list(self) -> tuple[CatalogSelection, ...]:
        """Return Catalog selections referenced by preparation requests.

        Returns:
            Distinct validated selections in stable JSONB order, without new identities.

        Raises:
            ProcessingError: If persistence is unavailable or stored data is invalid.
        """
        ...


class PostgresHabitatPreparationSelections:
    """Persist preparation references to Catalog selections using PostgreSQL.

    Composition owns this small pool's lifetime. Processing's existing schema
    migration creates the reference table. Job expiry does not remove references.
    """

    def __init__(self, conninfo: str = "") -> None:
        """Configure database access without waiting for PostgreSQL readiness.

        Args:
            conninfo: Optional test DSN; production uses the existing PG* settings.
        """
        self._pool: ConnectionPool[psycopg.Connection[dict[str, Any]]] = ConnectionPool(
            conninfo,
            kwargs={
                "connect_timeout": 3,
                "row_factory": dict_row,
                "options": "-c statement_timeout=5000 -c lock_timeout=3000",
            },
            min_size=0,
            max_size=2,
            timeout=3,
            max_waiting=16,
            check=ConnectionPool.check_connection,
            open=False,
            name="habitat-preparation-selections",
        )

    def open(self) -> None:
        """Open the pool without waiting for database readiness.

        Raises:
            psycopg_pool.PoolClosed: If the pool was already closed.
        """
        self._pool.open()

    def close(self) -> None:
        """Release pooled connections after preparation-reference consumers stop."""
        self._pool.close()

    @contextmanager
    def _transaction(self) -> Iterator[psycopg.Cursor[dict[str, Any]]]:
        """Borrow a cursor and translate actual database or persisted-data failures.

        Yields:
            Exclusive cursor committed or rolled back before its connection is returned.

        Raises:
            ProcessingError: If storage is unavailable or returned metadata is invalid.
        """
        try:
            with self._pool.connection() as connection:
                with connection.cursor() as cursor:
                    yield cursor
        except (psycopg.Error, ValidationError) as error:
            raise ProcessingError(
                "habitat_preparation_selections_unavailable",
                "Catalog selections for prepared Ecosystem Condition inputs could not be read or saved. Try again later.",
                503,
            ) from error

    def record(self, selection: CatalogSelection) -> None:
        """Remember a preparation selection once, including concurrent requests.

        Writers serialize before exact JSONB comparison. Numeric 1 and 1.0 are
        the same predicate literal; strings and booleans remain distinct. The
        complete descriptor is not a B-tree key, so valid long filters are accepted.

        Args:
            selection: Authorized Catalog source, layer and feature predicate.

        Raises:
            ProcessingError: If persistence is unavailable.
        """
        document = Jsonb(selection.model_dump(mode="json", by_alias=True))
        with self._transaction() as cursor:
            cursor.execute(
                "LOCK TABLE processing.habitat_preparation_selections IN SHARE ROW EXCLUSIVE MODE"
            )
            cursor.execute(
                "INSERT INTO processing.habitat_preparation_selections (selection) "
                "SELECT %s WHERE NOT EXISTS ("
                "SELECT 1 FROM processing.habitat_preparation_selections WHERE selection=%s)",
                (document, document),
            )

    def contains(self, selection: CatalogSelection) -> bool:
        """Test exact selection membership without inspecting source files or cached tiles.

        Args:
            selection: Validated original Catalog source and predicate.

        Returns:
            Whether preparation has been requested for this selection.

        Raises:
            ProcessingError: If persistence is unavailable.
        """
        with self._transaction() as cursor:
            cursor.execute(
                "SELECT EXISTS (SELECT 1 FROM processing.habitat_preparation_selections "
                "WHERE selection=%s) AS recorded",
                (Jsonb(selection.model_dump(mode="json", by_alias=True)),),
            )
            return cursor.fetchone()["recorded"]

    def list(self) -> tuple[CatalogSelection, ...]:
        """Read original Catalog selections referenced by administrator preparations.

        Returns:
            Validated selections in stable JSONB order, independent of job expiry.

        Raises:
            ProcessingError: If persistence is unavailable or a stored selection is invalid.
        """
        with self._transaction() as cursor:
            cursor.execute(
                "SELECT selection FROM processing.habitat_preparation_selections ORDER BY selection"
            )
            return tuple(
                CatalogSelection.model_validate(row["selection"])
                for row in cursor.fetchall()
            )


async def import_retained_habitat_preparation_selections(
    jobs: JobStore, store: HabitatPreparationSelections
) -> None:
    """Retain existing preparation selections before their job history expires.

    Import reads validated, unexpired preparation inputs through their owning
    history contract. Repeated worker startup does not duplicate references.

    Args:
        jobs: Existing paginated administrator job-history reader.
        store: Durable preparation references to original Catalog selections.

    Raises:
        ProcessingError: If history or preparation references cannot be read or saved.
        ValueError: If retained preparation metadata violates its persisted schema.
    """
    from eolab_app.processing.habitat_preparation import (
        get_retained_habitat_preparation_inputs,
    )
    from eolab_app.processing.habitat_preparation_models import (
        HABITAT_PREPARATION_OWNER,
        OPERATION,
    )

    before = None
    while True:
        rows = await asyncio.to_thread(
            jobs.list_session_jobs_page,
            HABITAT_PREPARATION_OWNER,
            (OPERATION,),
            100,
            before,
        )
        for row in rows:
            inputs = get_retained_habitat_preparation_inputs(row)
            if inputs is not None:
                await asyncio.to_thread(store.record, inputs.selection)
        if len(rows) < 100:
            return
        before = rows[-1]["created_at"], rows[-1]["id"]


async def get_habitat_preparation_coverage(
    selection: CatalogSelection,
    year: int,
    store: HabitatPreparationSelections | None,
    selections: CatalogSelectionReader | None,
    cache_directory: Path | None,
) -> HabitatCacheCoverage:
    """Inspect current coverage for a Catalog selection referenced by preparation.

    Args:
        selection: Validated original Catalog source, layer and exact filter.
        year: Assessment year checked by the existing scientific loader.
        store: Preparation-reference store, or None when unconfigured.
        selections: Original-source authorization reader, or None when unconfigured.
        cache_directory: Server-controlled input cache, or None when unconfigured.

    Returns:
        Current required, cached and missing acquisition-tile counts, including zero.

    Raises:
        ProcessingError: If services are unconfigured, preparation never referenced
            this selection, or coverage inspection fails.
        SelectionUnavailableError: If the original source is unavailable or unauthorized.
        asyncio.CancelledError: After the existing reader stops its native child.
    """
    if store is None or selections is None or cache_directory is None:
        raise ProcessingError(
            "habitat_preparation_selections_unavailable",
            "Catalog selections for prepared Ecosystem Condition inputs are not available on this server. Ask an administrator to check the service configuration.",
            503,
        )
    if not await asyncio.to_thread(store.contains, selection):
        raise ProcessingError(
            "habitat_preparation_selection_unavailable",
            "Choose one of the Catalog selections listed for prepared inputs. Ask an administrator to request preparation for another selection.",
            409,
        )
    from eolab_app.processing.habitat_cache import get_habitat_cache_coverage

    return await get_habitat_cache_coverage(
        selection, year, selections, cache_directory
    )


async def validate_habitat_preparation_selection(
    request: HabitatRequest,
    store: HabitatPreparationSelections | None,
    selections: CatalogSelectionReader | None,
    cache_directory: Path | None,
    *,
    coverage_lock: asyncio.Lock,
) -> None:
    """Require a preparation selection with nonzero current coverage for Earth Engine runs.

    Manual raster runs do not read preparation references or acquire the lock.
    Partial coverage is accepted and retains the existing NoData behavior;
    Reference sites remain independent. Cancellation holds the concurrency gate
    until the existing coverage reader stops its native child.

    Args:
        request: Validated model calculation inputs.
        store: Preparation-reference store, or None when unconfigured.
        selections: Original-source authorization reader, or None when unconfigured.
        cache_directory: Server-controlled input cache, or None when unconfigured.
        coverage_lock: Service-owned gate for native admission reads, without a work limit.

    Raises:
        ProcessingError: If Earth Engine inputs lack an eligible Catalog selection,
            have zero cached coverage, or cannot be authorized or inspected.
        asyncio.CancelledError: After the existing reader stops its native child.
    """
    from eolab_app.processing.habitat_models import HabitatEarthEngineStack

    if not isinstance(request.stack, HabitatEarthEngineStack):
        return
    if not isinstance(request.catalogSelection, CatalogSelection):
        raise ProcessingError(
            "habitat_preparation_selection_required",
            "Choose a Catalog selection listed for prepared inputs when using Original model inputs.",
            422,
        )
    async with coverage_lock:
        try:
            coverage = await get_habitat_preparation_coverage(
                request.catalogSelection,
                request.stack.year,
                store,
                selections,
                cache_directory,
            )
        except SelectionUnavailableError as error:
            raise ProcessingError("selection_unavailable", error.detail, 409) from error
    if coverage.cached_tiles == 0:
        raise ProcessingError(
            "habitat_inputs_not_prepared",
            "No Ecosystem Condition inputs are prepared for this selection and year. Ask an administrator to prepare them before running the model.",
            409,
        )
