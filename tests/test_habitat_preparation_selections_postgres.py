"""Prove Catalog preparation references survive storage and job-history cleanup."""

import asyncio
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
import random
import string
from typing import Any
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb
import pytest

from eolab_app.catalog_selection import CatalogSelection
from eolab_app.processing.habitat_preparation_selections import (
    PostgresHabitatPreparationSelections,
    import_retained_habitat_preparation_selections,
)
from eolab_app.processing.habitat_preparation_models import (
    HABITAT_PREPARATION_OWNER,
    OPERATION,
    HabitatInputPreparationInputs,
    HabitatInputPreparationSpec,
)
from eolab_app.processing.job_store import PostgresJobStore
from eolab_app.processing.models import PreparedJobPlan, ProcessingError
from test_habitat_preparation_selections import make_selection
from test_processing_jobs import store


@pytest.fixture
def preparation_selections(
    store: PostgresJobStore,
) -> Iterator[PostgresHabitatPreparationSelections]:
    """Open the Habitat adapter against the existing guarded disposable database.

    Args:
        store: Migrated Processing store with empty test tables.

    Yields:
        Real preparation references with composition-owned pool cleanup.
    """
    result = PostgresHabitatPreparationSelections(store.conninfo)
    result.open()
    try:
        yield result
    finally:
        result.close()


def test_preparation_references_use_jsonb_numeric_equality(
    store: PostgresJobStore,
    preparation_selections: PostgresHabitatPreparationSelections,
) -> None:
    """Preserve browser numeric round trips without merging strings or booleans.

    Args:
        store: Real migrated database and connection metadata.
        preparation_selections: Real preparation-reference adapter.
    """
    retained = make_selection(1.0)
    preparation_selections.record(retained)
    public = preparation_selections.list()[0].model_dump(mode="json", by_alias=True)
    public["filter"]["rules"][0]["value"] = 1
    browser_selection = CatalogSelection.model_validate(public)
    assert preparation_selections.contains(browser_selection)
    preparation_selections.record(browser_selection)
    assert len(preparation_selections.list()) == 1
    assert type(preparation_selections.list()[0].filter.rules[0].value) is float
    assert not preparation_selections.contains(make_selection(True))
    assert not preparation_selections.contains(make_selection("1"))
    preparation_selections.record(make_selection(True))
    preparation_selections.record(make_selection("1"))
    assert len(preparation_selections.list()) == 3
    assert {
        type(item.filter.rules[0].value) for item in preparation_selections.list()
    } == {float, bool, str}
    preparation_selections.record(make_selection(-0.0))
    assert preparation_selections.contains(make_selection(0))
    preparation_selections.record(make_selection(0))
    assert len(preparation_selections.list()) == 4
    assert not preparation_selections.contains(
        retained.model_copy(update={"layerName": "other-polygons"})
    )
    assert not preparation_selections.contains(make_selection("unknown' OR 1=1 --"))
    store.migrate()
    reopened = PostgresHabitatPreparationSelections(store.conninfo)
    reopened.open()
    try:
        assert reopened.contains(browser_selection)
        assert len(reopened.list()) == 4
    finally:
        reopened.close()


def test_full_length_filters_are_stored_and_compared_exactly(
    store: PostgresJobStore,
    preparation_selections: PostgresHabitatPreparationSelections,
) -> None:
    """Accept the existing twelve-rule contract without a full-document B-tree key.

    Args:
        store: Real database used to inspect the long persisted reference.
        preparation_selections: Reference writer and exact membership reader.
    """
    generator = random.Random(1176)
    alphabet = string.ascii_letters + string.digits
    payload = make_selection().model_dump(mode="json", by_alias=True)
    payload["filter"]["rules"] = [
        {
            "field": "".join(generator.choices(alphabet, k=256)),
            "operator": "eq",
            "value": "".join(generator.choices(alphabet, k=256)),
        }
        for _ in range(12)
    ]
    original = CatalogSelection.model_validate(payload)
    preparation_selections.record(original)
    assert preparation_selections.contains(original)
    assert preparation_selections.list() == (original,)
    with psycopg.connect(store.conninfo) as connection:
        assert (
            connection.execute(
                "SELECT octet_length(selection::text) FROM processing.habitat_preparation_selections"
            ).fetchone()[0]
            > 6000
        )
    payload["filter"]["rules"].reverse()
    assert not preparation_selections.contains(CatalogSelection.model_validate(payload))
    payload["filter"]["rules"] = payload["filter"]["rules"][:1]
    assert not preparation_selections.contains(CatalogSelection.model_validate(payload))


def test_concurrent_preparations_record_one_exact_reference(
    store: PostgresJobStore,
    preparation_selections: PostgresHabitatPreparationSelections,
) -> None:
    """Serialize deduplication while concurrent preparation requests share a selection.

    Args:
        store: Real disposable store required by the owning database lane.
        preparation_selections: Adapter whose pool serves simultaneous records.
    """
    selection = make_selection()
    with ThreadPoolExecutor(max_workers=8) as executor:
        tuple(executor.map(preparation_selections.record, [selection] * 12))
    assert preparation_selections.list() == (selection,)
    with psycopg.connect(store.conninfo) as connection:
        assert connection.execute(
            "SELECT count(*) FROM processing.habitat_preparation_selections"
        ).fetchone() == (1,)


def _save_retained_preparation(
    store: PostgresJobStore,
    name: str,
    selection: CatalogSelection,
    *,
    owner: str = HABITAT_PREPARATION_OWNER,
    operation: str = OPERATION,
) -> dict[str, Any]:
    """Persist existing typed preparation history without reading sources or settings.

    Args:
        store: Real disposable Processing adapter.
        name: Existing preparation-job label, not a preparation-reference identity.
        selection: Original path-free Catalog selection.
        owner: Job-history owner, varied to prove import isolation.
        operation: Operation discriminator, varied to prove filtering.

    Returns:
        Admitted subscriber record with its validated retained preparation inputs.
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


def test_retained_preparation_import_pages_and_outlives_job_cleanup(
    store: PostgresJobStore,
    preparation_selections: PostgresHabitatPreparationSelections,
) -> None:
    """Keep preparation references after history expiry without retaining labels or geometry.

    Args:
        store: Real history owner exercising pagination, expiry and cleanup.
        preparation_selections: References whose lifetime is independent of jobs.
    """
    oldest = _save_retained_preparation(store, "Older label", make_selection())
    for index in range(101):
        _save_retained_preparation(
            store, f"Area {index:03}", make_selection(f"Region {index}")
        )
    _save_retained_preparation(store, "Different label", make_selection())
    expired = _save_retained_preparation(store, "Expired", make_selection("Expired"))
    missing = _save_retained_preparation(store, "Missing", make_selection("Missing"))
    _save_retained_preparation(
        store, "Other owner", make_selection("Foreign"), owner="f" * 64
    )
    _save_retained_preparation(
        store,
        "Other operation",
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
    asyncio.run(
        import_retained_habitat_preparation_selections(store, preparation_selections)
    )
    assert len(preparation_selections.list()) == 102
    assert preparation_selections.contains(make_selection())
    for value in ("Expired", "Missing", "Foreign", "Other operation"):
        assert not preparation_selections.contains(make_selection(value))
    expected = preparation_selections.list()
    asyncio.run(
        import_retained_habitat_preparation_selections(store, preparation_selections)
    )
    assert preparation_selections.list() == expected
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
    asyncio.run(
        import_retained_habitat_preparation_selections(store, preparation_selections)
    )
    assert preparation_selections.list() == expected


def test_invalid_persisted_selection_is_not_published(
    store: PostgresJobStore,
    preparation_selections: PostgresHabitatPreparationSelections,
) -> None:
    """Validate database references before exposing them as eligible Catalog selections.

    Args:
        store: Real database used to simulate malformed persisted external metadata.
        preparation_selections: Reader validating the existing CatalogSelection contract.
    """
    selection = make_selection()
    preparation_selections.record(selection)
    invalid = selection.model_dump(mode="json", by_alias=True)
    invalid["path"] = "/private/source.gpkg"
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.habitat_preparation_selections SET selection=%s",
            (Jsonb(invalid),),
        )
    assert not preparation_selections.contains(selection)
    with pytest.raises(ProcessingError) as caught:
        preparation_selections.list()
    assert caught.value.code == "habitat_preparation_selections_unavailable"
    assert caught.value.status == 503
    assert "/private" not in caught.value.detail
