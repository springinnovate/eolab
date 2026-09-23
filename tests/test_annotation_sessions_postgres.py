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


def test_map_invitation_reads_live_layers_without_granting_write_access(
    store: AnnotationSessionStore,
) -> None:
    """Invitations allow live reads; cookie membership alone grants own-contribution writes.

    Args:
        store: Isolated real PostgreSQL session store.
    """
    app = FastAPI()
    app.include_router(create_annotation_sessions_router(store))
    author = TestClient(app, base_url="https://testserver", headers=HEADERS)
    visitor = TestClient(app, base_url="https://testserver", headers=HEADERS)
    session = author.post(
        BASE, json={"name": "Saved map layer", "contributorName": "Author"}
    ).json()
    path = f"{BASE}/{session['id']}"
    invitation = f"{BASE}/invitations/{session['id']}/{session['joinCode']}"
    upload = {"revision": 0, "collection": collection()}
    assert author.put(path + f"/layers/{session['id']}", json=upload).status_code == 200
    snapshot = visitor.get(invitation)
    assert snapshot.status_code == 200
    assert snapshot.json()["contributorId"] is None
    assert len(snapshot.json()["contributors"]) == 1
    assert visitor.get(BASE).json() == [], "reading must not create membership"
    contribution = f"/contributors/{session['contributorId']}/layers/{session['id']}"
    first = visitor.get(invitation + contribution).json()
    assert first["revision"] == 1
    assert visitor.get(path).status_code == 404
    assert visitor.get(path + contribution).status_code == 404
    assert (
        visitor.put(path + f"/layers/{session['id']}", json=upload).status_code == 404
    )
    assert visitor.patch(path + "/color", json={"color": "#123456"}).status_code == 404
    bad_code = "AAAAAAAA" if session["joinCode"] != "AAAAAAAA" else "BBBBBBBB"
    assert (
        visitor.get(f"{BASE}/invitations/{session['id']}/{bad_code}").status_code == 404
    )
    assert (
        visitor.get(f"{BASE}/invitations/{uuid4()}/{session['joinCode']}").status_code
        == 404
    )
    updated = collection()
    updated["features"][0]["properties"]["note"] = "Live update"
    author.put(
        path + f"/layers/{session['id']}", json={"revision": 1, "collection": updated}
    )
    assert (
        visitor.get(invitation + contribution).json()["collection"]["features"][0][
            "properties"
        ]
        == updated["features"][0]["properties"]
    )
    assert visitor.get(invitation).json()["layers"][0]["revision"] == 2
    assert author.get(invitation).json()["contributorId"] == session["contributorId"]
    assert (
        visitor.post(
            BASE + "/join",
            json={"joinCode": session["joinCode"], "contributorName": "Author"},
        ).status_code
        == 409
    )
    joined = visitor.post(
        BASE + "/join",
        json={"joinCode": session["joinCode"], "contributorName": "Visitor"},
    ).json()
    assert joined["contributorId"] != session["contributorId"]
    assert visitor.get(invitation).json()["contributorId"] == joined["contributorId"]
    assert (
        visitor.put(path + f"/layers/{session['id']}", json=upload).status_code == 200
    )
    assert (
        author.get(path + contribution).json()["collection"]["features"][0][
            "properties"
        ]
        == updated["features"][0]["properties"]
    )
    other = author.post(
        BASE, json={"name": "Other layer", "contributorName": "Author"}
    ).json()
    other_contribution = f"/contributors/{other['contributorId']}/layers/{other['id']}"
    assert visitor.get(invitation + other_contribution).status_code == 404


def test_contributor_colors_are_shared_owned_and_persistent(
    store: AnnotationSessionStore,
) -> None:
    """Exercise palette assignment, custom colors, isolation and exports over the real API.

    Args:
        store: Empty disposable PostgreSQL store.
    """
    app = FastAPI()
    app.include_router(create_annotation_sessions_router(store))
    first = TestClient(app, base_url="https://testserver", headers=HEADERS)
    second = TestClient(app, base_url="https://testserver", headers=HEADERS)
    outsider = TestClient(app, base_url="https://testserver", headers=HEADERS)
    session = first.post(
        BASE, json={"name": "Colors", "contributorName": "First"}
    ).json()
    path = f"{BASE}/{session['id']}"
    joined = second.post(
        BASE + "/join",
        json={"joinCode": session["joinCode"], "contributorName": "Second"},
    ).json()
    colors = {person["name"]: person["color"] for person in joined["contributors"]}
    assert colors == {"First": "#FFBE0B", "Second": "#FB5607"}
    assert (
        first.put(
            path + f"/layers/{session['id']}",
            json={"revision": 0, "collection": collection()},
        ).status_code
        == 200
    )
    assert first.patch(path + "/color", json={"color": "#ab12ef"}).json() == {
        "color": "#AB12EF"
    }
    assert outsider.patch(path + "/color", json={"color": "#000000"}).status_code == 404
    assert (
        second.patch(
            path + "/color",
            json={"color": "#000000", "contributorId": session["contributorId"]},
        ).status_code
        == 422
    )
    for bad in ["red", "#fff", "url(x)", "#1234567", None]:
        assert second.patch(path + "/color", json={"color": bad}).status_code == 422
    snapshot = second.get(path).json()
    assert {p["name"]: p["color"] for p in snapshot["contributors"]} == {
        "First": "#AB12EF",
        "Second": "#FB5607",
    }
    assert (
        snapshot["layers"][0]["revision"] == 1
    ), "color updates do not rewrite polygons"
    exported = second.get(path + "/export").json()
    assert exported["eolabAnnotations"] == 1
    assert exported["features"][0]["properties"]["contributorColor"] == "#AB12EF"
    rejoined = first.post(
        BASE + "/join",
        json={"joinCode": session["joinCode"], "contributorName": "Renamed"},
    ).json()
    assert (
        next(
            p["color"]
            for p in rejoined["contributors"]
            if p["id"] == session["contributorId"]
        )
        == "#AB12EF"
    )
    other_session = first.post(
        BASE, json={"name": "Separate", "contributorName": "First"}
    ).json()
    assert other_session["contributors"][0]["color"] == "#FFBE0B"
    store.initialize_and_clean_join_attempts()
    assert first.get(path).json()["contributors"] == rejoined["contributors"]


def test_concurrent_joins_assign_distinct_colors_and_old_rows_have_stable_fallback(
    store: AnnotationSessionStore,
) -> None:
    """Serialize palette assignment and keep pre-color memberships readable without data loss.

    Args:
        store: Empty disposable PostgreSQL store.
    """
    session_id = store.create_session("creator", "Colors", "Creator")
    code = store.get_session_snapshot(session_id, "creator")["joinCode"]
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(
            pool.map(
                lambda index: store.join_session(
                    f"member-{index}", code, f"Member {index}"
                ),
                range(4),
            )
        )
    people = store.get_session_snapshot(session_id, "creator")["contributors"]
    assert len({p["color"] for p in people}) == 5
    with store.transaction(write=True) as cursor:
        cursor.execute(
            "UPDATE shared_annotation_layers.contributors SET color=NULL WHERE session_id=%s",
            (session_id,),
        )
    before = store.get_session_snapshot(session_id, "creator")["contributors"]
    store.initialize_and_clean_join_attempts()
    assert store.get_session_snapshot(session_id, "creator")["contributors"] == before
    assert all(p["color"].startswith("#") for p in before)


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
    result.initialize_and_clean_join_attempts()
    result.initialize_and_clean_join_attempts()
    with result.transaction(write=True) as cursor:
        cursor.execute(
            "TRUNCATE shared_annotation_layers.sessions, shared_annotation_layers.contributors, shared_annotation_layers.layers, shared_annotation_layers.join_attempts"
        )
    return result


def test_two_browsers_share_with_equal_controls_and_author_only_writes(
    store: AnnotationSessionStore,
) -> None:
    """Verify equal read access and author-only changes through HTTP and PostgreSQL.

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
    assert "isOwner" not in joined and "expiresAt" not in joined
    again = other.post(
        BASE + "/join",
        json={"joinCode": session["joinCode"], "contributorName": "Changed name"},
    ).json()
    assert again["contributorId"] == joined["contributorId"]
    layer_id = session["id"]
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
    assert other.post(path + "/actions/close-joining").status_code == 404
    assert owner.post(path + "/actions/delete").status_code == 404
    exported = owner.get(path + "/export")
    assert exported.status_code == 200
    feature = exported.json()["features"][0]
    assert feature["properties"]["contributor"] == "Changed name"
    assert feature["properties"]["note"] == "New note"
    # Creating the shared layer does not grant access to another author's writes.
    assert owner.delete(write + "?revision=2").status_code == 405
    assert other.get(read).json()["revision"] == 2
    assert (
        owner.put(
            write, json={"revision": 0, "collection": collection("Own")}
        ).status_code
        == 200
    )
    assert (
        other.get(read).json()["collection"]["features"][0]["properties"]["note"]
        == "New note"
    )
    assert other.put(f"{path}/layers/{uuid4()}", json=body).status_code == 422


def test_persistent_sessions_survive_maintenance(store: AnnotationSessionStore) -> None:
    """Maintenance and store reinitialization retain memberships and polygons.

    Args:
        store: Disposable PostgreSQL store.
    """
    session_id = store.create_session("owner", "Session", "Owner")
    store.save_shared_layer(
        session_id, "owner", session_id, ShareLayer(revision=0, collection=collection())
    )
    before = store.get_session_snapshot(session_id, "owner")
    restarted = AnnotationSessionStore(store.conninfo)
    restarted.initialize_and_clean_join_attempts()
    assert restarted.get_session_snapshot(session_id, "owner") == before
    assert "expiresAt" not in before
    assert len(restarted.list_sessions("owner")) == 1


def test_concurrent_writers_do_not_overwrite_same_revision(
    store: AnnotationSessionStore,
) -> None:
    """Two different updates based on revision one cannot both be accepted.

    Args:
        store: Empty disposable PostgreSQL store.
    """
    session_id = store.create_session("owner", "Session", "Owner")
    layer = session_id
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
    layer = session
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


def test_unique_names_and_returning_credentials(store: AnnotationSessionStore) -> None:
    """Names cannot impersonate an existing contributor; the cookie retains identity.

    Args:
        store: Disposable PostgreSQL store.
    """
    identifier = store.create_session("first", "Layer", "Rich Sharp")
    first = store.get_session_snapshot(identifier, "first")
    code = first["joinCode"]
    with pytest.raises(SessionError, match="already used"):
        store.join_session("second", code, "rich sharp")
    store.join_session("second", code, "Maria")
    second = store.get_session_snapshot(identifier, "second")
    with pytest.raises(SessionError, match="already used"):
        store.update_contributor_name(identifier, "second", "RICH SHARP")
    store.join_session("second", code, "New name")
    assert (
        store.get_session_snapshot(identifier, "second")["contributorId"]
        == second["contributorId"]
    )
    assert (
        store.get_session_snapshot(identifier, "first")["contributorId"]
        == first["contributorId"]
    )


def test_concurrent_duplicate_names_admit_only_one(
    store: AnnotationSessionStore,
) -> None:
    """The serialized membership boundary rejects simultaneous duplicate names.

    Args:
        store: Disposable PostgreSQL store.
    """
    identifier = store.create_session("first", "Layer", "Creator")
    code = store.get_session_snapshot(identifier, "first")["joinCode"]

    def join(browser: str) -> int:
        """Try to reserve a name from a separate browser.

        Args:
            browser: Independent credential hash.

        Returns:
            Accepted or duplicate-name HTTP status.
        """
        try:
            store.join_session(browser, code, "Maria")
            return 200
        except SessionError as error:
            return error.status

    with ThreadPoolExecutor(2) as pool:
        assert sorted(pool.map(join, ["second", "third"])) == [200, 409]
