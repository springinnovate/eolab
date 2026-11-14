"""Keep named Habitat preparation areas after their preparation jobs expire.

Area identity is derived only from a validated Catalog selection. The registry
stores no polygons, source paths, scientific readiness or preparation-job state.
"""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
import hashlib
from pathlib import Path
from typing import Annotated, Any, Iterator, Protocol, TYPE_CHECKING

from pydantic import BaseModel, ConfigDict, Field, ValidationError
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from eolab_app.catalog_selection import (
    CatalogSelection,
    CatalogSelectionReader,
    SelectionUnavailableError,
)
from eolab_app.processing.model_yaml import encode_canonical_json
from eolab_app.processing.models import ProcessingError

if TYPE_CHECKING:
    from eolab_app.processing.habitat_earth_engine import HabitatCacheCoverage
    from eolab_app.processing.habitat_models import HabitatRequest
    from eolab_app.processing.ports import JobStore


class HabitatPreparedArea(BaseModel):
    """Identify a saved administrator area by its exact immutable Catalog selection.

    Attributes:
        id: Stable opaque identity of the selection, independent of name and year.
        name: Administrator-supplied label shown in the model's area chooser.
        selection: Original Catalog source, layer, asset and exact feature filter.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    id: Annotated[str, Field(strict=True, pattern=r"^[a-f0-9]{64}$")]
    name: Annotated[str, Field(strict=True, min_length=1, max_length=80, pattern=r"\S")]
    selection: CatalogSelection


def get_habitat_prepared_area_id(selection: CatalogSelection) -> str:
    """Return a stable identity for a validated Catalog selection without reading files.

    Args:
        selection: Admitted source identity and feature predicate.

    Returns:
        SHA-256 of canonical selection metadata, excluding labels and years.
        Integral numeric literals use the same identity after browser JSON
        serialization, which represents both 1.0 and 1 as the number 1.
    """
    metadata = selection.model_dump(mode="json", by_alias=True)
    for rule in metadata["filter"]["rules"]:
        value = rule["value"]
        if isinstance(value, float) and value.is_integer():
            rule["value"] = int(value)
    return hashlib.sha256(encode_canonical_json(metadata)).hexdigest()


class HabitatPreparedAreaStore(Protocol):
    """Persist saved Catalog selections independently of job and report retention."""

    def register(self, name: str, selection: CatalogSelection) -> HabitatPreparedArea:
        """Save an administrator's area, updating its label on explicit preparation.

        Args:
            name: Administrator's current display label.
            selection: Validated exact Catalog selection.

        Returns:
            The saved area with its stable selection identity.

        Raises:
            ProcessingError: If persistence is unavailable or invalid.
            ValidationError: If the supplied label violates the area contract.
        """
        ...

    def import_retained(
        self, name: str, selection: CatalogSelection
    ) -> HabitatPreparedArea:
        """Import a retained preparation area without replacing an existing label.

        Args:
            name: Label captured in validated retained preparation inputs.
            selection: Exact selection captured in those inputs.

        Returns:
            Existing area or the newly imported definition.

        Raises:
            ProcessingError: If persistence is unavailable or invalid.
            ValidationError: If the supplied label violates the area contract.
        """
        ...

    def get(self, area_id: str) -> HabitatPreparedArea | None:
        """Return a saved area by opaque identity, or None when it is unknown.

        Args:
            area_id: Public prepared-area identifier.

        Returns:
            Validated persisted definition, or None.

        Raises:
            ProcessingError: If persistence is unavailable or invalid.
        """
        ...

    def find(self, selection: CatalogSelection) -> HabitatPreparedArea | None:
        """Return the saved definition of an exact selection, or None.

        Args:
            selection: Validated original Catalog identity and predicate.

        Returns:
            Matching definition, or None when this selection was never registered.

        Raises:
            ProcessingError: If persistence is unavailable or invalid.
        """
        ...

    def list(self) -> tuple[HabitatPreparedArea, ...]:
        """Return saved areas in display-name order with stable identity tie breaking.

        Returns:
            Validated definitions, independent of preparation-job lifetime.

        Raises:
            ProcessingError: If persistence is unavailable or invalid.
        """
        ...


class PostgresHabitatPreparedAreas:
    """Store Habitat area definitions using a small lifecycle-managed PostgreSQL pool.

    Composition opens and closes the pool. Processing's existing schema migration
    creates the table; this adapter does not inspect or extend job lifetimes.
    """

    def __init__(self, conninfo: str = "") -> None:
        """Configure connections without requiring an available database at construction.

        Args:
            conninfo: Optional test connection string; production uses PG* settings.
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
            name="habitat-prepared-areas",
        )

    def open(self) -> None:
        """Open the pool without waiting for PostgreSQL readiness.

        Raises:
            psycopg_pool.PoolClosed: If composition tries reopening a closed pool.
        """
        self._pool.open()

    def close(self) -> None:
        """Release the pool after prepared-area consumers have stopped."""
        self._pool.close()

    @contextmanager
    def _transaction(self) -> Iterator[psycopg.Cursor[dict[str, Any]]]:
        """Borrow a cursor and translate actual persistence failures to a public error.

        Yields:
            Exclusive cursor committed or rolled back before returning its connection.

        Raises:
            ProcessingError: If the database or stored area metadata is invalid.
        """
        try:
            with self._pool.connection() as connection:
                with connection.cursor() as cursor:
                    yield cursor
        except (psycopg.Error, ValidationError) as error:
            raise ProcessingError(
                "habitat_prepared_areas_unavailable",
                "Saved Ecosystem Condition areas could not be read or saved. Try again later.",
                503,
            ) from error

    def _save(
        self, name: str, selection: CatalogSelection, *, replace_name: bool
    ) -> HabitatPreparedArea:
        """Atomically register one definition using the requested label-update policy.

        Args:
            name: Valid administrator label.
            selection: Validated exact Catalog selection.
            replace_name: Whether explicit registration may replace an existing label.

        Returns:
            Saved definition, including the existing label during historical import.

        Raises:
            ValidationError: If the label violates the public area contract.
            ProcessingError: If persistence is unavailable or its returned data is invalid.
        """
        area = HabitatPreparedArea(
            id=get_habitat_prepared_area_id(selection), name=name, selection=selection
        )
        label = (
            "EXCLUDED.name"
            if replace_name
            else "processing.habitat_prepared_areas.name"
        )
        with self._transaction() as cursor:
            cursor.execute(
                "INSERT INTO processing.habitat_prepared_areas (id,name,selection) "
                "VALUES (%s,%s,%s) ON CONFLICT (id) DO UPDATE SET name="
                + label
                + " RETURNING id,name,selection",
                (
                    area.id,
                    area.name,
                    Jsonb(selection.model_dump(mode="json", by_alias=True)),
                ),
            )
            return HabitatPreparedArea.model_validate(cursor.fetchone())

    def register(self, name: str, selection: CatalogSelection) -> HabitatPreparedArea:
        """Save an explicitly prepared area and its current administrator label.

        Args:
            name: Current display label.
            selection: Validated exact Catalog selection.

        Returns:
            Saved definition with a stable selection identity.

        Raises:
            ValidationError: If the label is invalid.
            ProcessingError: If persistence is unavailable or invalid.
        """
        return self._save(name, selection, replace_name=True)

    def import_retained(
        self, name: str, selection: CatalogSelection
    ) -> HabitatPreparedArea:
        """Save a historical definition while preserving an existing administrator label.

        Args:
            name: Historical label, used only if the area is new.
            selection: Validated exact historical Catalog selection.

        Returns:
            Existing or newly imported definition.

        Raises:
            ValidationError: If the label is invalid.
            ProcessingError: If persistence is unavailable or invalid.
        """
        return self._save(name, selection, replace_name=False)

    def get(self, area_id: str) -> HabitatPreparedArea | None:
        """Read a saved definition by identity without inspecting its source or coverage.

        Args:
            area_id: Opaque prepared-area identifier.

        Returns:
            Validated definition, or None when the identifier is unknown.

        Raises:
            ProcessingError: If persistence is unavailable or invalid.
        """
        with self._transaction() as cursor:
            cursor.execute(
                "SELECT id,name,selection FROM processing.habitat_prepared_areas WHERE id=%s",
                (area_id,),
            )
            row = cursor.fetchone()
            return None if row is None else HabitatPreparedArea.model_validate(row)

    def find(self, selection: CatalogSelection) -> HabitatPreparedArea | None:
        """Read the saved definition matching an exact validated Catalog selection.

        Args:
            selection: Original source, asset, layer and feature predicate.

        Returns:
            Exact registered definition, or None.

        Raises:
            ProcessingError: If persistence is unavailable or invalid.
        """
        return self.get(get_habitat_prepared_area_id(selection))

    def list(self) -> tuple[HabitatPreparedArea, ...]:
        """Read every saved area in name order, independent of historical job expiry.

        Returns:
            Validated definitions ordered by name and then stable identifier.

        Raises:
            ProcessingError: If persistence is unavailable or invalid.
        """
        with self._transaction() as cursor:
            cursor.execute(
                'SELECT id,name,selection FROM processing.habitat_prepared_areas ORDER BY name COLLATE "C",id'
            )
            return tuple(
                HabitatPreparedArea.model_validate(row) for row in cursor.fetchall()
            )


async def import_retained_habitat_preparation_areas(
    jobs: JobStore, store: HabitatPreparedAreaStore
) -> None:
    """Save still-retained administrator area definitions before job cleanup starts.

    Newest preparations are visited first, so their label initializes a missing
    area. Repeated startup imports preserve existing labels. Expired metadata
    and unrelated operations are never used to reconstruct definitions.

    Args:
        jobs: Existing paginated administrator job-history reader.
        store: Durable Habitat area registry.

    Raises:
        ProcessingError: If history or the area registry cannot be read or saved.
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
                await asyncio.to_thread(
                    store.import_retained, inputs.name, inputs.selection
                )
        if len(rows) < 100:
            return
        before = rows[-1]["created_at"], rows[-1]["id"]


async def get_prepared_habitat_area_coverage(
    area_id: str,
    year: int,
    store: HabitatPreparedAreaStore | None,
    selections: CatalogSelectionReader | None,
    cache_directory: Path | None,
) -> HabitatCacheCoverage:
    """Count current cached inputs for the original polygons of a saved area and year.

    Args:
        area_id: Selected saved-area identity.
        year: Requested assessment year, checked by the existing scientific loader.
        store: Durable area registry, or None when not configured.
        selections: Original-source reader, or None when not configured.
        cache_directory: Server-controlled input-cache root, or None when unconfigured.

    Returns:
        Current required, cached and missing acquisition-tile counts, including zero.

    Raises:
        ProcessingError: If required services are unconfigured, the area is unknown,
            or cache inspection fails.
        SelectionUnavailableError: If the original source is unavailable or unauthorized.
        asyncio.CancelledError: After the existing coverage reader stops its child process.
    """
    if store is None or selections is None or cache_directory is None:
        raise ProcessingError(
            "habitat_prepared_areas_unavailable",
            "Saved Ecosystem Condition areas are not available on this server. Ask an administrator to check the service configuration.",
            503,
        )
    from eolab_app.processing.habitat_cache import get_habitat_cache_coverage

    area = await asyncio.to_thread(store.get, area_id)
    if area is None:
        raise ProcessingError(
            "habitat_prepared_area_unavailable",
            "This saved preparation area is unavailable. Choose an area from the current list.",
            409,
        )
    return await get_habitat_cache_coverage(
        area.selection, year, selections, cache_directory
    )


async def validate_habitat_prepared_area(
    request: HabitatRequest,
    store: HabitatPreparedAreaStore | None,
    selections: CatalogSelectionReader | None,
    cache_directory: Path | None,
    *,
    coverage_lock: asyncio.Lock,
) -> None:
    """Require a registered area with some current cached inputs for Earth Engine runs.

    Manual raster runs return without reading the registry, polygons or cache.
    Partial tile coverage is accepted; the calculation keeps its existing NoData
    behavior. Reference-site selections are independent of this assessment-area check.
    The service's lock serializes native admission reads without limiting their work;
    cancellation retains that lock until the existing reader stops its child process.

    Args:
        request: Validated model calculation inputs.
        store: Durable area registry, or None when not configured.
        selections: Original-source reader, or None when not configured.
        cache_directory: Server-controlled input-cache root, or None when unconfigured.
        coverage_lock: Service-owned concurrency gate for native admission reads.

    Raises:
        ProcessingError: If Earth Engine services are unconfigured, the area is
            unregistered, has no cached inputs for the year, or its original source
            is unavailable, unauthorized or cannot be inspected.
        asyncio.CancelledError: After the existing coverage reader stops its child process.
    """
    from eolab_app.processing.habitat_models import HabitatEarthEngineStack

    if not isinstance(request.stack, HabitatEarthEngineStack):
        return
    if store is None or selections is None or cache_directory is None:
        raise ProcessingError(
            "habitat_prepared_areas_unavailable",
            "Saved Ecosystem Condition areas are not available on this server. Ask an administrator to check the service configuration.",
            503,
        )
    from eolab_app.processing.habitat_cache import get_habitat_cache_coverage

    if not isinstance(request.catalogSelection, CatalogSelection):
        raise ProcessingError(
            "habitat_prepared_area_required",
            "Choose a saved preparation area for Original model inputs. Custom raster inputs keep their own analysis-area choices.",
            422,
        )
    area = await asyncio.to_thread(store.find, request.catalogSelection)
    if area is None:
        raise ProcessingError(
            "habitat_prepared_area_unavailable",
            "Choose a saved preparation area. Ask an administrator to register this area through input preparation.",
            409,
        )
    async with coverage_lock:
        try:
            coverage = await get_habitat_cache_coverage(
                area.selection, request.stack.year, selections, cache_directory
            )
        except SelectionUnavailableError as error:
            raise ProcessingError("selection_unavailable", error.detail, 409) from error
    if coverage.cached_tiles == 0:
        raise ProcessingError(
            "habitat_inputs_not_prepared",
            "No Ecosystem Condition inputs are prepared for this area and year. Ask an administrator to prepare them before running the model.",
            409,
        )
