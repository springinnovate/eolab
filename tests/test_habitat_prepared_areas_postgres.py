"""Prove saved preparation areas survive real storage and job-history lifecycles."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from collections.abc import Iterator
from typing import Any
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb
import pytest

from eolab_app.catalog_selection import CatalogSelection
from eolab_app.processing.habitat_prepared_areas import (
    PostgresHabitatPreparedAreas,
    import_retained_habitat_preparation_areas,
)
from eolab_app.processing.habitat_preparation_models import (
    HABITAT_PREPARATION_OWNER,
    OPERATION,
    HabitatInputPreparationInputs,
    HabitatInputPreparationSpec,
)
from eolab_app.processing.job_store import PostgresJobStore
from eolab_app.processing.models import PreparedJobPlan, ProcessingError
from test_habitat_prepared_areas import make_selection
from test_processing_jobs import store


@pytest.fixture
def prepared_areas(store: PostgresJobStore) -> Iterator[PostgresHabitatPreparedAreas]:
    """Open the Habitat adapter against the existing guarded disposable database.

    Args:
        store: Migrated Processing store with empty test tables.

    Yields:
        Real Habitat registry with composition-owned pool cleanup.
    """
    result = PostgresHabitatPreparedAreas(store.conninfo)
    result.open()
    try:
        yield result
    finally:
        result.close()


def test_saved_area_roundtrip_and_label_policies(
    store: PostgresJobStore, prepared_areas: PostgresHabitatPreparedAreas
) -> None:
    """Keep numeric wire identity and exact source predicates through PostgreSQL.

    Args:
        store: Real migrated database and connection metadata.
        prepared_areas: Real Habitat registry adapter.
    """
    retained = make_selection(1.0)
    area = prepared_areas.import_retained("Historical name", retained)
    public = area.model_dump(mode="json", by_alias=True)
    public["selection"]["filter"]["rules"][0]["value"] = 1
    browser_selection = CatalogSelection.model_validate(public["selection"])
    assert prepared_areas.find(browser_selection) == area
    renamed = prepared_areas.register("Current name", browser_selection)
    assert renamed.id == area.id
    assert renamed.name == "Current name"
    assert type(renamed.selection.filter.rules[0].value) is float
    assert prepared_areas.import_retained("Older name", retained) == renamed
    assert prepared_areas.find(make_selection(True)) is None
    boolean_area = prepared_areas.register("Boolean area", make_selection(True))
    other = retained.model_copy(update={"layerName": "other-polygons"})
    assert prepared_areas.find(other) is None
    assert prepared_areas.get("unknown' OR 1=1 --") is None
    assert prepared_areas.list() == (boolean_area, renamed)
    store.migrate()
    reopened = PostgresHabitatPreparedAreas(store.conninfo)
    reopened.open()
    try:
        assert reopened.get(area.id) == renamed
    finally:
        reopened.close()


def test_concurrent_history_import_preserves_explicit_label(
    store: PostgresJobStore, prepared_areas: PostgresHabitatPreparedAreas
) -> None:
    """Serialize label policy in PostgreSQL without duplicate definitions or lost renames.

    Args:
        store: Real disposable store required by the owning database lane.
        prepared_areas: Adapter whose pool serves simultaneous startup imports.
    """
    selection = make_selection()
    original = prepared_areas.register("Administrator's current name", selection)
    with ThreadPoolExecutor(max_workers=8) as executor:
        results = tuple(
            executor.map(
                prepared_areas.import_retained,
                [f"Historical {index}" for index in range(12)],
                [selection] * 12,
            )
        )
    assert all(area == original for area in results)
    assert prepared_areas.list() == (original,)


def _save_retained_preparation(
    store: PostgresJobStore,
    name: str,
    selection: CatalogSelection,
    *,
    owner: str = HABITAT_PREPARATION_OWNER,
    operation: str = OPERATION,
) -> dict[str, Any]:
    """Persist validated historical inputs without reading sources or scientific settings.

    Args:
        store: Real disposable Processing adapter.
        name: Historical administrator label.
        selection: Exact path-free area descriptor.
        owner: Job-history owner; varied to prove import isolation.
        operation: Registered operation discriminator; varied to prove filtering.

    Returns:
        Admitted subscriber record with the original typed retained inputs.
    """
    inputs = HabitatInputPreparationInputs(
        name=name, selection=selection, year=2018, configurationSha256="a" * 64
    )
    spec = HabitatInputPreparationSpec(inputs=inputs).model_dump(
        mode="json", by_alias=True
    )
    key = uuid4().hex
    return store.submit(
        owner,
        key,
        PreparedJobPlan(
            specification=spec,
            summary=inputs.model_dump(mode="json", by_alias=True),
            reserved_bytes=0,
            operation=operation,
            retained_metadata=spec,
        ),
        key,
    )


def test_retained_history_import_pages_and_outlives_cleanup(
    store: PostgresJobStore, prepared_areas: PostgresHabitatPreparedAreas
) -> None:
    """Recover existing area definitions before expiry without copying paths or geometry.

    Args:
        store: Real history owner exercising paging, expiry and cleanup.
        prepared_areas: Durable registry independent of historical job records.
    """
    oldest = _save_retained_preparation(store, "Older label", make_selection())
    for index in range(101):
        _save_retained_preparation(
            store, f"Area {index:03}", make_selection(f"Region {index}")
        )
    _save_retained_preparation(store, "Newest label", make_selection())
    expired = _save_retained_preparation(
        store, "Expired area", make_selection("Expired")
    )
    missing = _save_retained_preparation(
        store, "Missing metadata", make_selection("Missing")
    )
    _save_retained_preparation(
        store, "Another owner", make_selection("Foreign"), owner="f" * 64
    )
    _save_retained_preparation(
        store,
        "Another operation",
        make_selection("Other operation"),
        operation="another.operation.v1",
    )
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET created_at='2000-01-01T00:00:00Z' WHERE id=%s",
            (oldest["job_id"],),
        )
        connection.execute(
            "UPDATE processing.jobs SET metadata_expires_at=now()-interval '1 day' WHERE id=%s",
            (expired["job_id"],),
        )
        connection.execute(
            "UPDATE processing.jobs SET retained_metadata=NULL WHERE id=%s",
            (missing["job_id"],),
        )
    asyncio.run(import_retained_habitat_preparation_areas(store, prepared_areas))
    assert len(prepared_areas.list()) == 102
    assert prepared_areas.find(make_selection()).name == "Newest label"
    for value in ("Expired", "Missing", "Foreign", "Other operation"):
        assert prepared_areas.find(make_selection(value)) is None
    renamed = prepared_areas.register("Explicit newer name", make_selection())
    asyncio.run(import_retained_habitat_preparation_areas(store, prepared_areas))
    assert prepared_areas.get(renamed.id) == renamed
    expected = prepared_areas.list()
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET status='failed',spec=NULL,reserved_bytes=0,metadata_expires_at=now()-interval '9 days',updated_at=now()-interval '9 days'"
        )
    store.cleanup_candidates()
    store.migrate()
    with psycopg.connect(store.conninfo) as connection:
        assert connection.execute(
            "SELECT count(*) FROM processing.jobs"
        ).fetchone() == (0,)
    assert prepared_areas.list() == expected
    asyncio.run(import_retained_habitat_preparation_areas(store, prepared_areas))
    assert prepared_areas.list() == expected


def test_corrupt_persisted_area_is_not_published(
    store: PostgresJobStore, prepared_areas: PostgresHabitatPreparedAreas
) -> None:
    """Validate database selection metadata before it can authorize a model run.

    Args:
        store: Real database used to simulate invalid persisted external metadata.
        prepared_areas: Registry serving the invalid row through public read methods.
    """
    area = prepared_areas.register("Northern area", make_selection())
    invalid = area.selection.model_dump(mode="json", by_alias=True)
    invalid["path"] = "/private/source.gpkg"
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.habitat_prepared_areas SET selection=%s WHERE id=%s",
            (Jsonb(invalid), area.id),
        )
    for read in (lambda: prepared_areas.get(area.id), prepared_areas.list):
        with pytest.raises(ProcessingError) as caught:
            read()
        assert caught.value.code == "habitat_prepared_areas_unavailable"
        assert caught.value.status == 503
        assert "/private" not in caught.value.detail
