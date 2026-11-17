"""Verify durable linked drawings and browser ownership with real PostgreSQL."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Barrier
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
import psycopg
import pytest

from eolab_app.drawings.models import (
    MAX_REQUEST_BYTES,
    CreateDrawingLayer,
    DrawingError,
    DrawingLayer,
    UpdateDrawingLayer,
)
from eolab_app.drawings.store import DrawingLayerStore
from eolab_app.routes.drawings import create_drawings_router
from test_drawings import collection

BASE = "/api/drawings"
HEADERS = {"X-EOLab-Drawings": "1"}


@pytest.fixture
def store(request: pytest.FixtureRequest) -> DrawingLayerStore:
    """Create drawing tables only in an explicitly disposable test database.

    Args:
        request: Pytest configuration containing the deliberate database DSN.

    Returns:
        Empty real drawing-source store.

    Raises:
        pytest.fail.Exception: The database is not explicitly named for testing.
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
    result = DrawingLayerStore(dsn)
    result.initialize_schema()
    result.initialize_schema()
    with result.transaction() as cursor:
        cursor.execute("TRUNCATE drawings.layers")
    return result


def make_app(store: DrawingLayerStore) -> FastAPI:
    """Compose the real HTTP identity and source API around an isolated store.

    Args:
        store: Drawing-source persistence owner.

    Returns:
        Small application exercising the production HTTP boundary.
    """
    app = FastAPI()
    app.include_router(create_drawings_router(store))
    return app


def test_linked_drawing_can_be_read_but_only_its_owner_can_write_after_restart(
    store: DrawingLayerStore,
) -> None:
    """Share live original polygons without sharing write ownership or private listing.

    Args:
        store: Empty disposable PostgreSQL drawing store.
    """
    original = collection()
    with (
        TestClient(
            make_app(store), base_url="https://testserver", headers=HEADERS
        ) as owner,
        TestClient(
            make_app(store), base_url="https://testserver", headers=HEADERS
        ) as reader,
    ):
        created = owner.post(
            BASE, json={"localLayerId": "device-layer", "collection": original}
        )
        assert created.status_code == 201, created.text
        path, source = created.headers["location"], created.json()
        assert source["collection"] == original
        assert source["canEdit"] is True
        assert source["revision"] == 1
        assert not {"owner", "owner_hash", "localLayerId"}.intersection(source)
        linked = reader.get(path)
        assert linked.status_code == 200, linked.text
        assert linked.json() == {**source, "canEdit": False}
        assert reader.get(BASE).json() == []
        summaries = owner.get(BASE).json()
        assert summaries[0]["id"] == source["id"]
        assert summaries[0]["localLayerId"] == "device-layer"
        assert "collection" not in summaries[0]
        changed = deepcopy(original)
        changed["name"] = "Renamed drawing"
        changed["features"][1]["properties"]["name"] = "Still parcel-b"
        changed["features"][1]["geometry"]["coordinates"][0][1] = [6, 0]
        changed["features"].pop(0)
        update = {"expectedRevision": 1, "collection": changed}
        assert reader.put(path, json=update).status_code == 404
        assert reader.put(f"{BASE}/{uuid4()}", json=update).status_code == 404
        accepted = owner.put(path, json=update)
        assert accepted.status_code == 200, accepted.text
        assert accepted.json()["revision"] == 2
        assert accepted.json()["collection"] == changed
        assert accepted.json()["collection"]["features"][0]["id"] == "parcel-b"
        assert owner.put(path, json=update).status_code == 409
        assert reader.get(path).json() == {**accepted.json(), "canEdit": False}
        assert reader.get(path).headers["cache-control"] == "private, no-store"
        cookies = dict(owner.cookies)
    restarted = DrawingLayerStore(store.conninfo)
    with TestClient(
        make_app(restarted), base_url="https://testserver", headers=HEADERS
    ) as owner:
        owner.cookies.update(cookies)
        assert owner.get(path).json() == accepted.json()
        restored = owner.put(path, json={"expectedRevision": 2, "collection": original})
        assert restored.status_code == 200, restored.text
        assert restored.json()["collection"] == original
        assert restored.json()["id"] == source["id"]


def test_creation_retries_never_duplicate_sources_or_overwrite_newer_content(
    store: DrawingLayerStore,
) -> None:
    """Keep one source per owner/local ID and reject a changed initial-create retry.

    Args:
        store: Empty disposable PostgreSQL drawing store.
    """
    request = CreateDrawingLayer(localLayerId="same-device-id", collection=collection())
    created = store.create_layer("owner", request)
    assert store.create_layer("owner", request) == created
    changed = request.model_copy(
        update={
            "collection": request.collection.model_copy(update={"name": "Other tab"})
        }
    )
    with pytest.raises(DrawingError) as conflict:
        store.create_layer("owner", changed)
    assert conflict.value.status == 409
    assert store.read_layer(created.id, "owner") == created
    updated = store.update_layer(
        "owner",
        created.id,
        UpdateDrawingLayer(expectedRevision=1, collection=changed.collection),
    )
    with pytest.raises(DrawingError) as stale:
        store.create_layer("owner", request)
    assert stale.value.status == 409
    assert store.create_layer("owner", changed) == updated
    independent = store.create_layer("another-owner", request)
    assert independent.id != created.id
    assert len(store.list_layers("owner")) == 1
    assert len(store.list_layers("another-owner")) == 1


def test_concurrent_create_retries_return_one_original_source(
    store: DrawingLayerStore,
) -> None:
    """Serialize idempotent creates using original owner/local identity.

    Args:
        store: Empty disposable PostgreSQL drawing store.
    """
    request = CreateDrawingLayer(localLayerId="device-layer", collection=collection())
    start = Barrier(2)

    def create(_: int) -> DrawingLayer:
        """Submit an identical create after both browser retries are ready.

        Args:
            _: Unused worker number.

        Returns:
            The single committed source returned to either retry.
        """
        start.wait(timeout=5)
        return store.create_layer("owner", request)

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(create, [0, 1]))
    assert results[0] == results[1]
    assert len(store.list_layers("owner")) == 1


def test_concurrent_edits_preserve_only_the_winning_source_revision(
    store: DrawingLayerStore,
) -> None:
    """Reject the losing editor without combining or losing either polygon's identity.

    Args:
        store: Empty disposable PostgreSQL drawing store.
    """
    source = store.create_layer(
        "owner",
        CreateDrawingLayer(localLayerId="device-layer", collection=collection()),
    )
    start = Barrier(2)

    def update(name: str) -> tuple[str, int]:
        """Save competing source names using the same acknowledged revision.

        Args:
            name: Distinct label for this edit.

        Returns:
            Submitted name and success or conflict status.
        """
        request = UpdateDrawingLayer(expectedRevision=1, collection=collection(name))
        start.wait(timeout=5)
        try:
            store.update_layer("owner", source.id, request)
            return name, 200
        except DrawingError as error:
            return name, error.status

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(update, ["First tab", "Second tab"]))
    assert sorted(status for _, status in results) == [200, 409]
    winner = next(name for name, status in results if status == 200)
    current = store.read_layer(source.id)
    assert current.collection.name == winner
    assert current.revision == 2
    assert current.canEdit is False
    assert [feature.id for feature in current.collection.features] == [
        "parcel-a",
        "parcel-b",
    ]


def test_http_errors_cannot_publish_invalid_or_unauthorized_drawing_changes(
    store: DrawingLayerStore,
) -> None:
    """Reject invalid polygons, forged ownership, cross-site writes and oversized bodies.

    Args:
        store: Empty disposable PostgreSQL drawing store.
    """
    with TestClient(
        make_app(store), base_url="https://testserver", headers=HEADERS
    ) as owner:
        payload = {"localLayerId": "device-layer", "collection": collection()}
        for headers in (
            {"X-EOLab-Drawings": ""},
            {"Origin": "https://foreign.example"},
            {"Sec-Fetch-Site": "cross-site"},
        ):
            rejected = owner.post(BASE, json=payload, headers=headers)
            assert rejected.status_code == 403
            assert rejected.headers["cache-control"] == "private, no-store"
        assert owner.get(BASE).json() == []
        duplicated = deepcopy(payload)
        duplicated["collection"]["features"][1]["id"] = "parcel-a"
        for invalid in (
            duplicated,
            {**payload, "owner": "another-browser"},
            {**payload, "collection": {**collection(), "filter": {}}},
        ):
            response = owner.post(BASE, json=invalid)
            assert response.status_code == 422, response.text
            assert response.headers["cache-control"] == "private, no-store"
        large = owner.post(BASE, content=b" " * (MAX_REQUEST_BYTES + 1))
        assert large.status_code == 413
        assert large.headers["cache-control"] == "private, no-store"
        created = owner.post(BASE, json=payload)
        path = created.headers["location"]
        invalid_update = owner.put(
            path, json={"expectedRevision": True, "collection": collection()}
        )
        assert invalid_update.status_code == 422
        assert owner.get(path).json() == created.json()


def test_invalid_persisted_source_fails_locally_without_returning_partial_geometry(
    store: DrawingLayerStore,
) -> None:
    """Validate database reads at the source owner before consumers see source data.

    Args:
        store: Empty disposable PostgreSQL drawing store.
    """
    source = store.create_layer(
        "owner",
        CreateDrawingLayer(localLayerId="device-layer", collection=collection()),
    )
    with store.transaction() as cursor:
        cursor.execute(
            "UPDATE drawings.layers SET collection=jsonb_set(collection,'{features,1,id}',to_jsonb('parcel-a'::text)) WHERE id=%s",
            (source.id,),
        )
    with pytest.raises(DrawingError) as invalid:
        store.read_layer(source.id)
    assert invalid.value.status == 503
    assert "Drawing storage" in str(invalid.value)
