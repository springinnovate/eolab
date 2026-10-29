"""Verify named-map persistence and concurrent writes using real PostgreSQL."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient
import psycopg
from psycopg.types.json import Jsonb
import pytest

from eolab_app.routes.saved_maps import (
    create_saved_maps_router,
    create_saved_maps_admin_router,
)
from eolab_app.saved_maps.models import CreateSavedMap, SavedMapError, UpdateSavedMap
from eolab_app.saved_maps.store import SavedMapStore
from eolab_app.saved_maps.migrate import main as migrate_main
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
        {"slug": original.slug, "title": original.title, "deletedAt": None}
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
        {"slug": original.slug, "title": "Corrected map", "deletedAt": None}
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


def test_admin_delete_and_restore_preserve_map_and_reserve_url(
    store: SavedMapStore,
) -> None:
    """Hide a map, reject stale edits and restore its exact content at the same URL.

    Args:
        store: Empty disposable PostgreSQL store.
    """
    original = store.create_saved_map(CreateSavedMap.model_validate(map_request()))
    app = FastAPI()
    app.include_router(create_saved_maps_router(store))
    app.include_router(create_saved_maps_admin_router(store, "test-admin-password-561"))
    client = TestClient(app, headers={"X-EOLab-Admin": "1"})
    client.auth = ("admin", "test-admin-password-561")
    url = "/api/admin/saved-maps/amazon-priorities"
    changes = {**map_request(), "revision": 1}
    assert client.delete(url).status_code == 204
    deleted = client.get("/api/admin/saved-maps").json()[0]
    assert deleted["deletedAt"] is not None
    assert client.delete(url).status_code == 204
    assert client.get("/api/admin/saved-maps").json()[0] == deleted
    assert client.get(BASE + "/amazon-priorities").status_code == 404
    assert client.get(url).status_code == 404
    assert client.put(url, json=changes).status_code == 404
    # Deleted maps retain their data and URL; neither can be replaced by publishing.
    with pytest.raises(SavedMapError) as duplicate:
        store.create_saved_map(CreateSavedMap.model_validate(map_request()))
    assert duplicate.value.status == 409
    with pytest.raises(SavedMapError) as full:
        SavedMapStore(store.conninfo, capacity=1).create_saved_map(
            CreateSavedMap.model_validate(map_request("another-map"))
        )
    assert full.value.status == 503
    restarted = SavedMapStore(store.conninfo)
    restarted.initialize_schema()
    assert restarted.list_published_maps()[0]["deletedAt"] is not None
    assert client.post(url + "/restore").status_code == 204
    restored = client.get(BASE + "/amazon-priorities").json()
    assert restored == {
        **original.model_dump(mode="json", exclude_unset=True),
        "revision": 3,
    }
    assert client.post(url + "/restore").status_code == 204
    assert client.get(BASE + "/amazon-priorities").json() == restored
    assert client.get("/api/admin/saved-maps").json()[0]["deletedAt"] is None
    assert client.put(url, json=changes).status_code == 409
    assert client.put(url, json={**changes, "revision": 3}).status_code == 200
    assert client.delete("/api/admin/saved-maps/missing").status_code == 404
    assert client.post("/api/admin/saved-maps/missing/restore").status_code == 404


def test_subtitle_migration_preserves_existing_maps(store: SavedMapStore) -> None:
    """Upgrade an existing saved-map table without changing its records.

    Args:
        store: Empty disposable PostgreSQL store.
    """
    store.create_saved_map(CreateSavedMap.model_validate(map_request()))
    with store.transaction() as cursor:
        cursor.execute("ALTER TABLE saved_maps.maps DROP COLUMN subtitle")
        cursor.execute("ALTER TABLE saved_maps.maps DROP COLUMN deleted_at")
    store.initialize_schema()
    assert store.get_saved_map("amazon-priorities").subtitle == ""
    assert store.list_published_maps()[0]["deletedAt"] is None
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


def migration_record(store: SavedMapStore, slug: str) -> dict[str, Any]:
    """Read every stored map column without normalizing its legacy document.

    Args:
        store: Disposable PostgreSQL store.
        slug: Map to inspect.

    Returns:
        Raw map record, including deletion state and timestamps.
    """
    with store.transaction() as cursor:
        cursor.execute("SELECT * FROM saved_maps.maps WHERE slug=%s", (slug,))
        return cursor.fetchone()


def insert_legacy_map(
    store: SavedMapStore, slug: str = "site-condition"
) -> dict[str, Any]:
    """Store a pre-upgrade map with two obsolete Catalog fingerprint fields.

    Args:
        store: Disposable PostgreSQL store.
        slug: URL name to preserve through the migration.

    Returns:
        Exact legacy database row for preservation assertions.
    """
    request = map_request(slug)
    request["subtitle"] = "Workshop map"
    request["view"].update(schemaVersion=3, basemap="none")
    shared = json.loads(
        (Path(__file__).parent / "fixtures" / "saved-map-v2.json").read_text()
    )["layers"][0]
    request["view"]["layers"].insert(0, shared)
    store.create_saved_map(CreateSavedMap.model_validate(request))
    for index, layer in enumerate(request["view"]["layers"][1:]):
        layer["sourceRevision"] = None if index == 0 else "sha256:" + "a" * 64
    with store.transaction() as cursor:
        cursor.execute(
            "UPDATE saved_maps.maps SET view=%s, revision=4 WHERE slug=%s",
            (Jsonb(request["view"]), slug),
        )
    return migration_record(store, slug)


def test_source_revision_migration_preserves_map_and_shared_polygons(
    store: SavedMapStore,
) -> None:
    """Preview, migrate and retry without changing the URL, polygons or ownership.

    Args:
        store: Disposable database shared by the real map and annotation stores.
    """
    from eolab_app.annotation_sessions.models import ShareLayer
    from eolab_app.annotation_sessions.store import AnnotationSessionStore
    from test_annotation_sessions import collection

    annotations = AnnotationSessionStore(store.conninfo)
    annotations.initialize_and_clean_join_attempts()
    session = annotations.create_session("migration-owner", "Site Condition", "Owner")
    layer_id = session
    annotations.save_shared_layer(
        session,
        "migration-owner",
        layer_id,
        ShareLayer(revision=0, collection=collection()),
    )
    snapshot = annotations.get_session_snapshot(session, "migration-owner")
    invitation = {"id": str(session), "joinCode": snapshot["joinCode"]}
    before = insert_legacy_map(store)
    before["view"]["layers"][0]["sharedAnnotation"] = invitation
    with store.transaction() as cursor:
        cursor.execute(
            "UPDATE saved_maps.maps SET view=%s WHERE slug=%s",
            (Jsonb(before["view"]), before["slug"]),
        )
        cursor.execute(
            "SELECT * FROM shared_annotation_layers.contributors WHERE session_id=%s",
            (session,),
        )
        contributors = cursor.fetchall()
    polygons = annotations.export_session_geojson(session, "migration-owner")
    unrelated = insert_legacy_map(store, "unrelated-map")
    preview = store.migrate_source_revisions(before["slug"])
    assert (preview.changed_layers, preview.revision, preview.applied) == (2, 4, False)
    assert migration_record(store, before["slug"]) == before
    app = FastAPI()
    app.include_router(create_saved_maps_router(store))
    with TestClient(app) as client:
        assert client.get(BASE + "/" + before["slug"]).status_code == 503
        result = store.migrate_source_revisions(
            before["slug"], apply=True, expected_revision=4
        )
        assert (result.changed_layers, result.revision, result.applied) == (2, 5, True)
        response = client.get(BASE + "/" + before["slug"])
        assert response.status_code == 200, response.text
        assert response.json()["view"]["layers"][0]["sharedAnnotation"] == invitation
    expected = deepcopy(before)
    expected["revision"] = 5
    for layer in expected["view"]["layers"][1:]:
        del layer["sourceRevision"]
    assert migration_record(store, before["slug"]) == expected
    retry = store.migrate_source_revisions(
        before["slug"], apply=True, expected_revision=4
    )
    assert (retry.changed_layers, retry.revision, retry.applied) == (0, 5, False)
    assert migration_record(store, before["slug"]) == expected
    assert migration_record(store, unrelated["slug"]) == unrelated
    assert annotations.get_session_snapshot(session, "migration-owner") == snapshot
    assert annotations.export_session_geojson(session, "migration-owner") == polygons
    with store.transaction() as cursor:
        cursor.execute(
            "SELECT * FROM shared_annotation_layers.contributors WHERE session_id=%s",
            (session,),
        )
        assert cursor.fetchall() == contributors
    # Existing ownership and polygon revision still authorize the next edit.
    edited = collection()
    edited["features"][0]["properties"]["note"] = "Edited after migration"
    assert (
        annotations.save_shared_layer(
            session,
            "migration-owner",
            layer_id,
            ShareLayer(revision=1, collection=edited),
        )
        == 2
    )
    stale = UpdateSavedMap.model_validate(
        {
            "slug": before["slug"],
            "title": before["title"],
            "view": expected["view"],
            "revision": 4,
        }
    )
    with pytest.raises(SavedMapError) as conflict:
        store.update_saved_map(before["slug"], stale)
    assert conflict.value.status == 409


@pytest.mark.parametrize("expected_revision,status", [(None, 422), (3, 409)])
def test_source_revision_migration_requires_reviewed_revision(
    store: SavedMapStore, expected_revision: int | None, status: int
) -> None:
    """Reject unreviewed or stale application without changing the stored record.

    Args:
        store: Disposable PostgreSQL store.
        expected_revision: Missing or stale operator revision.
        status: Expected application error status.
    """
    before = insert_legacy_map(store)
    with pytest.raises(SavedMapError) as error:
        store.migrate_source_revisions(
            before["slug"], apply=True, expected_revision=expected_revision
        )
    assert error.value.status == status
    assert migration_record(store, before["slug"]) == before


@pytest.mark.parametrize("invalid", ["missing-layers", "old-style", "shared-extra"])
def test_source_revision_migration_rejects_other_incompatibilities(
    store: SavedMapStore, invalid: str
) -> None:
    """Leave all legacy data intact when this narrow conversion cannot validate it.

    Args:
        store: Disposable PostgreSQL store.
        invalid: Persisted incompatibility outside the approved migration.
    """
    before = insert_legacy_map(store)
    if invalid == "missing-layers":
        del before["view"]["layers"]
    elif invalid == "old-style":
        before["view"]["layers"][1]["style"] = {
            "kind": "raster",
            "definition": {},
            "paletteName": "viridis",
        }
    else:
        before["view"]["layers"][0]["sourceRevision"] = None
    with store.transaction() as cursor:
        cursor.execute(
            "UPDATE saved_maps.maps SET view=%s WHERE slug=%s",
            (Jsonb(before["view"]), before["slug"]),
        )
    for apply in (False, True):
        with pytest.raises(SavedMapError) as error:
            store.migrate_source_revisions(
                before["slug"], apply=apply, expected_revision=4
            )
        assert error.value.status == 422
        assert migration_record(store, before["slug"]) == before


def test_source_revision_migration_cli_and_deleted_maps(
    store: SavedMapStore,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Run preview/apply through the CLI and refuse missing or deleted URLs.

    Args:
        store: Disposable PostgreSQL store.
        monkeypatch: Isolate standard PG connection variables.
        capsys: Capture the operator report without printing map data.
    """
    for key, value in psycopg.conninfo.conninfo_to_dict(store.conninfo).items():
        monkeypatch.setenv("PG" + {"dbname": "DATABASE"}.get(key, key.upper()), value)
    before = insert_legacy_map(store)
    arguments = ["--slug", before["slug"]]
    assert migrate_main(arguments) == 0
    assert json.loads(capsys.readouterr().out) == {
        "slug": before["slug"],
        "revision": 4,
        "changed_layers": 2,
        "applied": False,
    }
    assert migration_record(store, before["slug"]) == before
    with pytest.raises(SystemExit) as missing_revision:
        migrate_main([*arguments, "--apply"])
    assert missing_revision.value.code == 2
    capsys.readouterr()
    assert migrate_main([*arguments, "--apply", "--expected-revision", "4"]) == 0
    assert json.loads(capsys.readouterr().out)["applied"] is True
    store.set_map_deleted(before["slug"], deleted=True)
    deleted = migration_record(store, before["slug"])
    assert migrate_main(arguments) == 1
    assert "not found" in capsys.readouterr().err
    assert migration_record(store, before["slug"]) == deleted
    with pytest.raises(SavedMapError) as missing:
        store.migrate_source_revisions("missing")
    assert missing.value.status == 404
