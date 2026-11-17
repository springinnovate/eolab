"""Verify durable Planning ownership and optimistic updates using real PostgreSQL."""

from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from fastapi.testclient import TestClient
import psycopg
import pytest

from eolab_app.planning.models import PlanningError, PlanningToolDocument
from eolab_app.planning.store import PlanningToolStore
from test_planning_tools import BASE, HEADERS, make_app, tool_document


@pytest.fixture
def store(request: pytest.FixtureRequest) -> PlanningToolStore:
    """Initialize only Planning storage in an explicitly selected disposable database.

    Args:
        request: Pytest configuration containing the deliberate database DSN.

    Returns:
        Empty real PostgreSQL Planning store.

    Raises:
        pytest.fail.Exception: The selected database is not explicitly disposable.
    """
    dsn = request.config.getoption("--processing-dsn")
    if dsn is None:
        pytest.skip("Pass --processing-dsn for real PostgreSQL tests")
    if (
        not psycopg.conninfo.conninfo_to_dict(dsn)
        .get("dbname", "")
        .startswith("eolab_processing_test")
    ):
        pytest.fail(
            "An explicit disposable eolab_processing_test* database is required"
        )
    with psycopg.connect(dsn) as connection:
        if not connection.info.dbname.startswith("eolab_processing_test"):
            pytest.fail("The connected database must be disposable")
    result = PlanningToolStore(dsn)
    result.initialize_schema()
    result.initialize_schema()
    with result.transaction() as cursor:
        cursor.execute("TRUNCATE planning.tools")
    return result


def test_author_only_http_persistence_survives_store_restart(
    store: PlanningToolStore,
) -> None:
    """Retain duplicate-source role definitions and author ownership across app restart.

    Args:
        store: Empty real PostgreSQL store.
    """
    document = tool_document()
    app = make_app(store)
    with (
        TestClient(app, base_url="https://testserver", headers=HEADERS) as author,
        TestClient(app, base_url="https://testserver", headers=HEADERS) as stranger,
    ):
        created = author.post(BASE, json=document)
        assert created.status_code == 201, created.text
        record = created.json()
        path = created.headers["location"]
        for key, value in document.items():
            assert record[key] == value
        assert stranger.get(path).status_code == 404
        assert stranger.get(BASE).json() == []
        author_cookies = dict(author.cookies)
    restarted = PlanningToolStore(store.conninfo)
    restarted.initialize_schema()
    with TestClient(
        make_app(restarted), base_url="https://testserver", headers=HEADERS
    ) as author:
        author.cookies.update(author_cookies)
        assert author.get(path).json() == record
        assert [summary["id"] for summary in author.get(BASE).json()] == [record["id"]]
        changed = {**document, "title": "Updated tool", "expectedRevision": 1}
        response = author.put(path, json=changed)
        assert response.status_code == 200, response.text
        assert response.json()["revision"] == 2
        assert response.json()["createdAt"] == record["createdAt"]
        assert author.put(path, json=changed).status_code == 409
        assert author.get(path).json() == response.json()


def test_only_one_concurrent_author_update_wins(store: PlanningToolStore) -> None:
    """Recheck revisions in PostgreSQL after two source validations could both succeed.

    Args:
        store: Empty real PostgreSQL store.
    """
    document = PlanningToolDocument.model_validate(tool_document())
    original = store.create_tool("author", document)

    def update(title: str) -> int:
        """Attempt an independent write based on the same acknowledged revision.

        Args:
            title: Competing replacement title.

        Returns:
            HTTP-equivalent success or conflict status.
        """
        try:
            replacement = document.model_copy(update={"title": title})
            store.update_tool("author", original.id, 1, replacement)
            return 200
        except PlanningError as error:
            return error.status

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(update, ["First editor", "Second editor"])) == [200, 409]
    assert store.get_tool("author", original.id).revision == 2
    for identifier in (original.id, uuid4()):
        with pytest.raises(PlanningError) as inaccessible:
            store.update_tool("stranger", identifier, 1, document)
        assert inaccessible.value.status == 404


def test_invalid_update_and_bad_stored_document_do_not_silently_replace_tool(
    store: PlanningToolStore,
) -> None:
    """Keep source validation outside transactions and reject corrupted persisted JSON.

    Args:
        store: Empty real PostgreSQL store.
    """
    import asyncio
    from eolab_app.planning.models import UpdatePlanningTool
    from eolab_app.planning.service import PlanningToolService
    from eolab_app.vector.errors import VectorConflictError
    from eolab_app.vector.parcel_models import (
        ParcelIdRequest,
        ParcelIdValidationResponse,
    )
    from test_planning_tools import authorize_layer

    document = PlanningToolDocument.model_validate(tool_document())
    original = store.create_tool("author", document)

    async def reject(request: ParcelIdRequest) -> ParcelIdValidationResponse:
        """Reject duplicate original parcel IDs before any document write.

        Args:
            request: Current parcel source and chosen original ID field.

        Raises:
            VectorConflictError: The fixture source IDs are invalid.
        """
        raise VectorConflictError("Parcel IDs must be unique")

    service = PlanningToolService(store, authorize_layer, reject)
    replacement = UpdatePlanningTool(
        **document.model_dump(exclude_unset=True), expectedRevision=1
    )
    with pytest.raises(PlanningError) as failure:
        asyncio.run(service.update_tool("author", original.id, replacement))
    assert failure.value.status == 422
    assert store.get_tool("author", original.id) == original
    with store.transaction() as cursor:
        cursor.execute(
            "UPDATE planning.tools SET definition='{}'::jsonb WHERE id=%s",
            (original.id,),
        )
    with pytest.raises(PlanningError) as invalid:
        store.get_tool("author", original.id)
    assert invalid.value.status == 503
    assert "Planning storage" in str(invalid.value)
