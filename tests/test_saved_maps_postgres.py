"""Verify named-map persistence and concurrent writes using real PostgreSQL."""

from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI
from fastapi.testclient import TestClient
import psycopg
import pytest

from eolab_app.routes.saved_maps import (
    create_saved_maps_router,
    create_saved_maps_admin_router,
)
from eolab_app.saved_maps.models import CreateSavedMap, SavedMapError, UpdateSavedMap
from eolab_app.saved_maps.store import SavedMapStore
from test_saved_maps import BASE, HEADERS, map_request


@pytest.fixture
def store(request: pytest.FixtureRequest) -> SavedMapStore:
    """Empty only the saved-map table in an explicitly selected test database.

    Args:
        request: Pytest configuration containing the disposable database DSN.

    Returns:
        Initialized saved-map store.

    Raises:
        pytest.fail.Exception: If the target is not a disposable test database.
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
    result = SavedMapStore(dsn)
    result.initialize_schema()
    result.initialize_schema()
    with result.transaction() as cursor:
        cursor.execute("TRUNCATE saved_maps.maps")
    return result


def test_create_retrieve_restart_and_http_errors(store: SavedMapStore) -> None:
    """Persist a browser document and retrieve it through a new store and API instance.

    Args:
        store: Empty disposable PostgreSQL store.
    """
    app = FastAPI()
    app.include_router(create_saved_maps_router(store))
    with TestClient(app, headers=HEADERS) as client:
        response = client.post(BASE, json=map_request())
        assert response.status_code == 201, response.text
        original = response.json()
        assert original["view"] == map_request()["view"]
        assert response.headers["location"] == BASE + "/amazon-priorities"
        assert response.headers["cache-control"] == "no-store"
        assert client.post(BASE, json=map_request()).status_code == 409
        assert client.get(BASE + "/missing").status_code == 404
        assert client.get(BASE).status_code == 405
        assert client.delete(BASE + "/amazon-priorities").status_code == 405
    restarted = SavedMapStore(store.conninfo)
    restarted.initialize_schema()
    other = FastAPI()
    other.include_router(create_saved_maps_router(restarted))
    with TestClient(other) as client:
        assert client.get(BASE + "/amazon-priorities").json() == original


def test_admin_edit_preserves_identity_and_checks_revision(
    store: SavedMapStore,
) -> None:
    """Publish changes atomically while retaining URLs, references and creation time.

    Args:
        store: Empty disposable PostgreSQL store.
    """
    import json
    from pathlib import Path

    request = map_request()
    request["view"] = json.loads(
        (Path(__file__).parent / "fixtures/saved-map-v2.json").read_text()
    )
    request["view"]["viewer"]["origin"] = "http://testserver"
    original = store.create_saved_map(CreateSavedMap.model_validate(request))
    password = "test-administrator-password-561"
    app = FastAPI()
    app.include_router(create_saved_maps_router(store))
    app.include_router(create_saved_maps_admin_router(store, password))
    client = TestClient(app, headers={"X-EOLab-Admin": "1"})
    client.auth = ("admin", password)
    url = "/api/admin/saved-maps/amazon-priorities"
    loaded = client.get(url).json()
    assert loaded["revision"] == 1
    assert client.get("/api/admin/saved-maps").json() == [
        {"slug": original.slug, "title": original.title}
    ]
    changes = {
        **request,
        "title": "Corrected map",
        "subtitle": "Updated subtitle",
        "revision": 1,
    }
    changes["view"].update(schemaVersion=3, basemap="none")
    changes["view"]["viewport"]["zoom"] = 7
    # An in-memory draft has no effect on the public record.
    assert client.get(BASE + "/amazon-priorities").json() == loaded
    saved = client.put(url, json=changes)
    assert saved.status_code == 200, saved.text
    saved = saved.json()
    assert saved["slug"] == loaded["slug"]
    assert saved["createdAt"] == loaded["createdAt"]
    assert saved["revision"] == 2
    assert saved["view"]["layers"] == loaded["view"]["layers"]
    assert saved["view"]["basemap"] == "none"
    assert saved["subtitle"] == "Updated subtitle"
    assert client.put(url, json=changes).status_code == 409
    assert (
        client.put(url, json={**changes, "slug": "renamed", "revision": 2}).status_code
        == 422
    )
    invalid = {
        **changes,
        "revision": 2,
        "view": {
            **changes["view"],
            "viewer": {**changes["view"]["viewer"], "origin": "https://other.example"},
        },
    }
    assert client.put(url, json=invalid).status_code == 422
    assert client.get(BASE + "/amazon-priorities").json() == saved
    assert store.list_published_maps() == [
        {"slug": original.slug, "title": "Corrected map"}
    ]
    assert SavedMapStore(store.conninfo).get_saved_map(original.slug).revision == 2
    assert (
        client.put(
            "/api/admin/saved-maps/missing", json={**changes, "slug": "missing"}
        ).status_code
        == 404
    )


def test_only_one_concurrent_admin_update_wins(store: SavedMapStore) -> None:
    """An atomic revision comparison prevents two editors from overwriting each other.

    Args:
        store: Empty disposable PostgreSQL store.
    """
    store.create_saved_map(CreateSavedMap.model_validate(map_request()))

    def save(title: str) -> int:
        """Return success or conflict for an independent administrator transaction.

        Args:
            title: Replacement title for this editor.

        Returns:
            HTTP-equivalent outcome code.
        """
        try:
            store.update_saved_map(
                "amazon-priorities",
                UpdateSavedMap.model_validate(
                    {**map_request(), "title": title, "revision": 1}
                ),
            )
            return 200
        except SavedMapError as error:
            return error.status

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(save, ["Editor one", "Editor two"])) == [200, 409]
    with store.transaction() as cursor:
        cursor.execute("ALTER TABLE saved_maps.maps DROP COLUMN revision")
    store.initialize_schema()
    assert store.get_saved_map("amazon-priorities").revision == 1


def test_subtitle_migration_preserves_existing_maps(store: SavedMapStore) -> None:
    """Upgrade an existing saved-map table without changing its records.

    Args:
        store: Empty disposable PostgreSQL store.
    """
    store.create_saved_map(CreateSavedMap.model_validate(map_request()))
    with store.transaction() as cursor:
        cursor.execute("ALTER TABLE saved_maps.maps DROP COLUMN subtitle")
    store.initialize_schema()
    assert store.get_saved_map("amazon-priorities").subtitle == ""
    request = map_request("with-subtitle")
    request["subtitle"] = "Explore habitat"
    store.create_saved_map(CreateSavedMap.model_validate(request))
    store.initialize_schema()
    assert store.get_saved_map("with-subtitle").subtitle == "Explore habitat"


def test_concurrent_duplicate_creation_preserves_winner(store: SavedMapStore) -> None:
    """Race two writers and verify that exactly one map is stored unchanged.

    Args:
        store: Empty disposable PostgreSQL store.
    """

    def create(title: str) -> int:
        """Try to store one competing title.

        Args:
            title: Distinct title associated with this writer.

        Returns:
            HTTP-equivalent success or conflict status.
        """
        try:
            store.create_saved_map(
                CreateSavedMap.model_validate({**map_request(), "title": title})
            )
            return 201
        except SavedMapError as error:
            return error.status

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(create, ["First", "Second"]))
    assert sorted(results) == [201, 409]
    winner = ["First", "Second"][results.index(201)]
    assert store.get_saved_map("amazon-priorities").title == winner


def test_capacity_is_atomic_across_store_instances(store: SavedMapStore) -> None:
    """Ensure simultaneous different names cannot exceed site capacity.

    Args:
        store: Empty disposable PostgreSQL store.
    """

    def create(slug: str) -> int:
        """Attempt a map insert using an independent app's store.

        Args:
            slug: Competing map URL name.

        Returns:
            Success or full-capacity status.
        """
        try:
            SavedMapStore(store.conninfo, capacity=1).create_saved_map(
                CreateSavedMap.model_validate(map_request(slug))
            )
            return 201
        except SavedMapError as error:
            return error.status

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(create, ["one", "two"]))
    assert sorted(results) == [201, 503]
    winner = ["one", "two"][results.index(201)]
    assert store.get_saved_map(winner).slug == winner


def test_invalid_stored_map_is_not_returned(store: SavedMapStore) -> None:
    """Revalidate persisted data rather than handing corrupted JSON to the browser.

    Args:
        store: Empty disposable PostgreSQL store.
    """
    store.create_saved_map(CreateSavedMap.model_validate(map_request()))
    with store.transaction() as cursor:
        cursor.execute("UPDATE saved_maps.maps SET view='{}'::jsonb")
    with pytest.raises(SavedMapError) as captured:
        store.get_saved_map("amazon-priorities")
    assert captured.value.status == 503
