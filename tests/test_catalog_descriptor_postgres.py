"""Prove nonspatial metadata round trips through the deployment's real STAC API."""

from copy import deepcopy
import json
import os
from pathlib import Path
import time
from typing import Any, Iterator
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

import psycopg
from psycopg.types.json import Jsonb
import pytest

FIXTURE = Path(__file__).parent / "fixtures/catalog_descriptors/public-items.json"
MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "catalog/migrations/0008_described_nonspatial_geometry.sql"
)
COLLECTION = "eolab-described-nonspatial"


def api_request(base: str, method: str, path: str, body: Any = None) -> Any:
    """Perform one HTTP JSON operation against the isolated test STAC API.

    Args:
        base: Test container URL on the launcher's private Docker network.
        method: HTTP operation.
        path: API-relative resource path.
        body: Optional JSON request document.

    Returns:
        Decoded response JSON, or None for an empty response.

    Raises:
        RuntimeError: If the API rejects the request, with its response body.
        URLError: If the private API is unavailable.
    """
    request = Request(
        base + path,
        data=None if body is None else json.dumps(body).encode(),
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urlopen(request, timeout=15) as response:
            payload = response.read()
            return json.loads(payload) if payload else None
    except HTTPError as error:
        raise RuntimeError(
            f"STAC API {method} {path}: {error.code} {error.read().decode()}"
        ) from error


@pytest.fixture
def descriptor_api() -> Iterator[tuple[str, str]]:
    """Guard the disposable database and wait for its private API to become ready.

    Yields:
        Private API URL and explicitly disposable database DSN.

    Raises:
        ValueError: If configuration could target a non-test database.
        RuntimeError: If the pinned API does not become ready.
    """
    dsn = os.environ.get("EOLAB_CATALOG_TEST_DSN")
    base = os.environ.get("EOLAB_CATALOG_TEST_URL")
    if not dsn or not base:
        pytest.skip("Run scripts/test_catalog_postgres.py for the pinned STAC API")
    if not (
        urlsplit(dsn).path.lstrip("/").startswith("eolab_catalog_test_")
        and urlsplit(base).hostname == "catalog-api"
    ):
        raise ValueError(
            "Catalog API tests require the launcher's disposable database/network"
        )
    deadline = time.monotonic() + 30
    while True:
        try:
            api_request(base, "GET", "/")
            break
        except (URLError, RuntimeError):
            if time.monotonic() >= deadline:
                raise RuntimeError("Pinned STAC API did not become ready")
            time.sleep(0.2)
    collection = {
        "type": "Collection",
        "stac_version": "1.0.0",
        "id": COLLECTION,
        "description": "Standalone supplied evidence with no asserted footprint.",
        "license": "other",
        "links": [],
        "extent": {
            "spatial": {"bbox": [[-180, -90, 180, 90]]},
            "temporal": {"interval": [[None, None]]},
        },
    }
    api_request(base, "POST", "/collections", collection)
    try:
        yield base, dsn
    finally:
        api_request(base, "DELETE", f"/collections/{COLLECTION}")


def nonspatial_item() -> dict[str, Any]:
    """Read the canonical descriptor-produced nonspatial Item fixture.

    Returns:
        A fresh complete STAC Item shared with authoring/browser contract tests.
    """
    records = json.loads(FIXTURE.read_text(encoding="utf-8"))
    return deepcopy(
        next(
            record["item"]
            for record in records
            if record["item"]["collection"] == COLLECTION
        )
    )


def test_nonspatial_admission_retrieval_search_and_replacement(
    descriptor_api: tuple[str, str],
) -> None:
    """Keep null geometry, curated notes and identity Assets through real HTTP writes.

    Args:
        descriptor_api: Ready private STAC API and guarded database DSN.
    """
    base, _ = descriptor_api
    item = nonspatial_item()
    item["assets"]["data"]["eolab:asset-source"] = {
        "href": "file:///scan-source/field-observations.csv"
    }
    api_request(
        base,
        "POST",
        f"/collections/{COLLECTION}/bulk_items",
        {"method": "upsert", "items": {item["id"]: item}},
    )
    returned = api_request(base, "GET", f"/collections/{COLLECTION}/items/{item['id']}")
    assert returned["geometry"] is None
    assert "bbox" not in returned
    assert (
        returned["properties"]["eolab:metadata"] == item["properties"]["eolab:metadata"]
    )
    assert returned["assets"] == item["assets"]
    search = {
        "collections": [COLLECTION],
        "filter-lang": "cql2-json",
        "filter": {
            "op": "=",
            "args": [{"property": "title"}, item["properties"]["title"]],
        },
    }
    assert [
        entry["id"]
        for entry in api_request(base, "POST", "/search", search)["features"]
    ] == [item["id"]]
    assert (
        api_request(
            base,
            "POST",
            "/search",
            {"collections": [COLLECTION], "bbox": [-180, -90, 180, 90]},
        )["features"]
        == []
    )
    item["properties"]["title"] = "Revised field notes"
    item["properties"]["eolab:metadata"]["title"] = "Revised field notes"
    item["properties"]["eolab:metadata"]["annotations"] = {}
    api_request(
        base,
        "POST",
        f"/collections/{COLLECTION}/bulk_items",
        {"method": "upsert", "items": {item["id"]: item}},
    )
    assert api_request(base, "POST", "/search", search)["features"] == []
    returned = api_request(base, "GET", f"/collections/{COLLECTION}/items/{item['id']}")
    assert returned["properties"]["eolab:metadata"]["annotations"] == {}
    assert (
        len(
            api_request(base, "POST", "/search", {"collections": [COLLECTION]})[
                "features"
            ]
        )
        == 1
    )


def test_nonspatial_migration_replay_and_partition_maintenance_preserve_spatial_guard(
    descriptor_api: tuple[str, str],
) -> None:
    """Allow only the nonspatial collection to retain null geometry after maintenance.

    Args:
        descriptor_api: Ready private STAC API and guarded database DSN.
    """
    base, dsn = descriptor_api
    item = nonspatial_item()
    api_request(
        base,
        "POST",
        f"/collections/{COLLECTION}/bulk_items",
        {"method": "upsert", "items": {item["id"]: item}},
    )
    with psycopg.connect(dsn, autocommit=True) as connection:
        connection.execute("SET search_path TO pgstac, public")
        for _ in range(2):
            connection.execute(MIGRATION.read_text(encoding="utf-8"), prepare=False)
        partition = connection.execute(
            "SELECT tableoid::regclass::text FROM pgstac.items WHERE collection=%s AND id=%s",
            (COLLECTION, item["id"]),
        ).fetchone()[0]
        connection.execute("SELECT pgstac.drop_table_constraints(%s)", (partition,))
        assert (
            connection.execute(
                "SELECT count(*) FROM pg_constraint WHERE conrelid=%s::regclass AND conname='eolab_spatial_geometry_required'",
                (partition,),
            ).fetchone()[0]
            == 1
        )
        connection.execute("SELECT pgstac.update_partition_stats(%s)", (partition,))
        ordinary = {
            "type": "Collection",
            "stac_version": "1.0.0",
            "id": "descriptor-spatial-guard",
            "description": "Spatial guard",
            "license": "other",
            "links": [],
            "extent": {
                "spatial": {"bbox": [[-180, -90, 180, 90]]},
                "temporal": {"interval": [[None, None]]},
            },
        }
        api_request(base, "POST", "/collections", ordinary)
        try:
            invalid = {**item, "collection": ordinary["id"]}
            with pytest.raises(psycopg.errors.CheckViolation) as failure:
                connection.execute(
                    "SELECT pgstac.upsert_items(%s)", (Jsonb([invalid]),)
                )
            assert (
                failure.value.diag.constraint_name == "eolab_spatial_geometry_required"
            )
        finally:
            api_request(base, "DELETE", "/collections/" + ordinary["id"])


@pytest.mark.parametrize(
    "invalid_case",
    ["ordinary-null", "omitted-geometry", "null-with-bbox", "collection-id", "item-id"],
)
def test_provider_preserves_http_identity_and_geometry_validation(
    descriptor_api: tuple[str, str], invalid_case: str
) -> None:
    """Reject invalid bulk writes without relaxing other provider boundaries.

    Args:
        descriptor_api: Ready private STAC API and guarded database DSN.
        invalid_case: One violation of the existing identity or geometry contract.
    """
    base, _ = descriptor_api
    item = nonspatial_item()
    target = COLLECTION
    key = item["id"]
    ordinary_id = "descriptor-http-spatial-guard"
    if invalid_case == "ordinary-null":
        ordinary = api_request(base, "GET", f"/collections/{COLLECTION}")
        ordinary["id"] = ordinary_id
        ordinary["links"] = []
        api_request(base, "POST", "/collections", ordinary)
        target = ordinary_id
        item["collection"] = target
    elif invalid_case == "omitted-geometry":
        del item["geometry"]
    elif invalid_case == "null-with-bbox":
        item["bbox"] = [-180, -90, 180, 90]
    elif invalid_case == "collection-id":
        item["collection"] = "wrong-collection"
    else:
        key = "wrong-item-id"
    try:
        with pytest.raises(RuntimeError) as rejected:
            api_request(
                base,
                "POST",
                f"/collections/{target}/bulk_items",
                {"method": "upsert", "items": {key: item}},
            )
        assert isinstance(rejected.value.__cause__, HTTPError)
        assert rejected.value.__cause__.code in (400, 422)
        assert (
            api_request(base, "POST", "/search", {"collections": [target]})["features"]
            == []
        )
    finally:
        if target == ordinary_id:
            api_request(base, "DELETE", f"/collections/{ordinary_id}")


def test_provider_retains_ordinary_spatial_http_writes(
    descriptor_api: tuple[str, str],
) -> None:
    """Keep ordinary spatial admission and geographic search on the same API.

    Args:
        descriptor_api: Ready private STAC API and guarded database DSN.
    """
    base, _ = descriptor_api
    records = json.loads(FIXTURE.read_text(encoding="utf-8"))
    item = deepcopy(
        next(record["item"] for record in records if record["item"]["geometry"])
    )
    collection = api_request(base, "GET", f"/collections/{COLLECTION}")
    collection["id"] = item["collection"]
    collection["links"] = []
    api_request(base, "POST", "/collections", collection)
    try:
        api_request(
            base,
            "POST",
            f"/collections/{item['collection']}/bulk_items",
            {"method": "upsert", "items": {item["id"]: item}},
        )
        returned = api_request(
            base, "GET", f"/collections/{item['collection']}/items/{item['id']}"
        )
        assert returned["geometry"] == item["geometry"]
        assert [
            found["id"]
            for found in api_request(
                base,
                "POST",
                "/search",
                {"collections": [item["collection"]], "bbox": [-180, -90, 180, 90]},
            )["features"]
        ] == [item["id"]]
    finally:
        api_request(base, "DELETE", f"/collections/{item['collection']}")


def test_combined_nonspatial_curated_search_and_replacement(
    descriptor_api: tuple[str, str],
) -> None:
    """Verify the admission and curated-search drafts together through real HTTP.

    Args:
        descriptor_api: Ready private STAC API with both feature migrations.
    """
    base, _ = descriptor_api
    item = nonspatial_item()
    metadata = item["properties"]["eolab:metadata"]
    metadata["annotations"] = {"finding": "Combined nonspatial evidence"}
    metadata["study_ids"] = ["Study-integration"]
    item["assets"]["data"]["eolab:metadata"] = {
        "version": 1,
        "categories": ["Coastal recovery"],
        "annotations": {"notes": "Attached census details"},
    }
    api_request(
        base,
        "POST",
        f"/collections/{COLLECTION}/bulk_items",
        {"method": "upsert", "items": {item["id"]: item}},
    )
    predicate = {
        "op": "and",
        "args": [
            {
                "op": "like",
                "args": [
                    {"property": "eolab_metadata_text"},
                    "%attached census details%",
                ],
            },
            {
                "op": "a_contains",
                "args": [{"property": "eolab_study_ids"}, ["study-integration"]],
            },
            {
                "op": "a_contains",
                "args": [{"property": "eolab_categories"}, ["coastal recovery"]],
            },
        ],
    }
    request = {
        "collections": [COLLECTION],
        "filter-lang": "cql2-json",
        "filter": predicate,
    }
    found = api_request(base, "POST", "/search", request)["features"]
    assert [entry["id"] for entry in found] == [item["id"]]
    assert found[0]["geometry"] is None
    assert found[0]["properties"]["eolab:metadata"] == metadata
    assert (
        found[0]["assets"]["data"]["eolab:metadata"]
        == item["assets"]["data"]["eolab:metadata"]
    )
    item["assets"]["data"]["eolab:metadata"]["annotations"] = {}
    api_request(
        base,
        "POST",
        f"/collections/{COLLECTION}/bulk_items",
        {"method": "upsert", "items": {item["id"]: item}},
    )
    assert api_request(base, "POST", "/search", request)["features"] == []
