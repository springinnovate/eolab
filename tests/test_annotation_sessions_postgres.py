"""Exercise annotation-session ownership and revision rules against PostgreSQL."""

from concurrent.futures import ThreadPoolExecutor
from typing import Any
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
import psycopg
import pytest

from eolab_app.annotation_sessions.store import AnnotationSessionStore
from eolab_app.annotation_sessions.models import ShareLayer, SessionError
from eolab_app.routes.annotation_sessions import create_annotation_sessions_router
from test_annotation_sessions import collection

BASE = "/api/annotation-sessions"
HEADERS = {"X-EOLab-Annotations": "1"}


@pytest.fixture
def store(request: pytest.FixtureRequest) -> AnnotationSessionStore:
    """Initialize only an explicitly selected disposable test database.

    Args:
        request: Pytest configuration with an optional test DSN.

    Returns:
        Empty annotation store in the disposable database.

    Raises:
        pytest.fail.Exception: If the configured or resolved database is unsafe.
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
    result = AnnotationSessionStore(dsn)
    result.initialize_and_remove_expired_sessions()
    result.initialize_and_remove_expired_sessions()
    with result.transaction(write=True) as cursor:
        cursor.execute(
            "TRUNCATE annotation_sessions.sessions, annotation_sessions.contributors, annotation_sessions.layers, annotation_sessions.join_attempts"
        )
    return result


def test_two_browsers_share_and_owner_permissions(
    store: AnnotationSessionStore,
) -> None:
    """Share, revise, withdraw and export through actual HTTP/cookie/SQL boundaries.

    Args:
        store: Empty disposable PostgreSQL store.
    """
    app = FastAPI()
    app.include_router(create_annotation_sessions_router(store))
    owner = TestClient(app, base_url="https://testserver", headers=HEADERS)
    other = TestClient(app, base_url="https://testserver", headers=HEADERS)
    outsider = TestClient(app, base_url="https://testserver", headers=HEADERS)
    owner.get(BASE)
    other.get(BASE)
    outsider.get(BASE)
    response = owner.post(
        BASE, json={"name": "Watershed priorities", "contributorName": "Leader"}
    )
    assert response.status_code == 201, response.text
    session = response.json()
    path = f"{BASE}/{session['id']}"
    joined = other.post(
        BASE + "/join",
        json={"joinCode": session["joinCode"].lower(), "contributorName": "Maria"},
    ).json()
    assert not joined["isOwner"]
    again = other.post(
        BASE + "/join",
        json={"joinCode": session["joinCode"], "contributorName": "Changed name"},
    ).json()
    assert again["contributorId"] == joined["contributorId"]
    layer_id = str(uuid4())
    write = f"{path}/layers/{layer_id}"
    body = {"revision": 0, "collection": collection()}
    assert other.put(write, json=body).json() == {"revision": 1}
    assert other.put(write, json=body).json() == {"revision": 1}
    body["collection"]["features"][0]["properties"]["note"] = "New note"
    assert other.put(write, json=body).status_code == 409
    body["revision"] = 1
    assert other.put(write, json=body).json() == {"revision": 2}
    read = f"{path}/contributors/{joined['contributorId']}/layers/{layer_id}"
    assert owner.get(read).json()["revision"] == 2
    assert outsider.get(read).status_code == 404
    assert outsider.get(path).status_code == 404
    assert outsider.get(path + "/export").status_code == 404
    assert other.post(path + "/actions/close-joining").status_code == 403
    assert owner.post(path + "/actions/close-joining").status_code == 204
    assert (
        outsider.post(
            BASE + "/join",
            json={"joinCode": session["joinCode"], "contributorName": "New"},
        ).status_code
        == 403
    )
    exported = owner.get(path + "/export")
    assert exported.status_code == 200
    feature = exported.json()["features"][0]
    assert feature["properties"]["contributor"] == "Maria"
    assert feature["properties"]["note"] == "New note"
    # Owner cannot delete another contributor's copy, even when the local ID is known.
    assert owner.delete(write + "?revision=2").status_code == 204
    assert other.get(read).status_code == 200
    assert other.delete(write + "?revision=1").status_code == 409
    assert other.delete(write + "?revision=2").status_code == 204
    assert other.get(read).status_code == 404
    assert (
        other.put(write, json=body).status_code == 409
    ), "a stale update must not resurrect a withdrawn layer"


def test_expiry_and_cleanup_do_not_depend_on_browser(
    store: AnnotationSessionStore,
) -> None:
    """Reads do not renew sessions; expiration revokes access and deletes all related rows.

    Args:
        store: Empty disposable PostgreSQL store.
    """
    session_id = store.create_session("owner", "Session", "Owner")
    initial = store.get_session_snapshot(session_id, "owner")
    layer = uuid4()
    request = ShareLayer(revision=0, collection=collection())
    assert store.save_shared_layer(session_id, "owner", layer, request) == 1
    expires = store.get_session_snapshot(session_id, "owner")["expiresAt"]
    store.save_shared_layer(session_id, "owner", layer, request)
    assert store.get_session_snapshot(session_id, "owner")["expiresAt"] == expires
    with store.transaction(write=True) as cursor:
        cursor.execute(
            "UPDATE annotation_sessions.sessions SET expires_at=now()-interval '1 second' WHERE id=%s",
            (session_id,),
        )
    with pytest.raises(SessionError, match="expired"):
        store.apply_session_action(session_id, "owner", "extend")
    with pytest.raises(SessionError, match="expired"):
        store.read_shared_layer(session_id, "owner", initial["contributorId"], layer)
    assert store.list_sessions("owner") == []
    store.initialize_and_remove_expired_sessions()
    with store.transaction() as cursor:
        for table in ("sessions", "contributors", "layers"):
            cursor.execute(f"SELECT count(*) AS count FROM annotation_sessions.{table}")
            assert cursor.fetchone()["count"] == 0


def test_concurrent_writers_do_not_overwrite_same_revision(
    store: AnnotationSessionStore,
) -> None:
    """Two different updates based on revision one cannot both be accepted.

    Args:
        store: Empty disposable PostgreSQL store.
    """
    session_id = store.create_session("owner", "Session", "Owner")
    layer = uuid4()
    store.save_shared_layer(
        session_id, "owner", layer, ShareLayer(revision=0, collection=collection())
    )

    def update(name: str) -> int:
        """Try one competing revision.

        Args:
            name: Distinct new layer name.

        Returns:
            Revision or conflict status.
        """
        try:
            return store.save_shared_layer(
                session_id,
                "owner",
                layer,
                ShareLayer(revision=1, collection=collection(name)),
            )
        except SessionError as error:
            return error.status

    with ThreadPoolExecutor(2) as pool:
        assert sorted(pool.map(update, ["One", "Two"])) == [2, 409]


def test_failed_join_attempts_are_counted(store: AnnotationSessionStore) -> None:
    """Rejected invitation guesses still consume this browser's attempt budget.

    Args:
        store: Empty disposable PostgreSQL store.
    """
    for _ in range(10):
        with pytest.raises(SessionError) as failed:
            store.join_session("guesser", "AAAAAAAA", "Name")
        assert failed.value.status == 404
    with pytest.raises(SessionError) as failed:
        store.join_session("guesser", "AAAAAAAA", "Name")
    assert failed.value.status == 429


def test_storage_capacity_rejects_growth_without_losing_previous_copy(
    store: AnnotationSessionStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Enforce session storage bounds and leave the last accepted contribution intact.

    Args:
        store: Empty disposable PostgreSQL store.
        monkeypatch: Set a small session budget for this boundary test.
    """
    from eolab_app.annotation_sessions import store as storage_module

    session = store.create_session("owner", "Session", "Owner")
    layer = uuid4()
    store.save_shared_layer(
        session, "owner", layer, ShareLayer(revision=0, collection=collection())
    )
    author = store.get_session_snapshot(session, "owner")["contributorId"]
    original = store.read_shared_layer(session, "owner", author, layer)
    monkeypatch.setattr(storage_module, "SESSION_BYTES", 1)
    with pytest.raises(SessionError) as failed:
        store.save_shared_layer(
            session,
            "owner",
            layer,
            ShareLayer(revision=1, collection=collection("Larger name")),
        )
    assert failed.value.status == 413
    assert store.read_shared_layer(session, "owner", author, layer) == original
