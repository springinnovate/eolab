"""Prove nonspatial metadata round trips through the deployment's real STAC API."""

from copy import deepcopy
from dataclasses import asdict
import json
import os
from pathlib import Path
import time
from typing import Any, Iterator
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

import psycopg
from pydantic import TypeAdapter
from eolab_app.catalog.models import DescriptorSource
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


@pytest.mark.parametrize("interval", [False, True])
def test_nonspatial_admission_retrieval_search_and_replacement(
    descriptor_api: tuple[str, str],
    interval: bool,
) -> None:
    """Keep null geometry, curated notes and identity Assets through real HTTP writes.

    Args:
        descriptor_api: Ready private STAC API and guarded database DSN.
        interval: Whether the Item declares an interval with explicit null datetime.
    """
    base, dsn = descriptor_api
    item = nonspatial_item()
    values = {
        "missing": None,
        "zero": 0,
        "reviewed": False,
        "nested": {"missing": None},
        "empty": {},
        "literal_marker": "𒍟※",
    }
    item["properties"]["eolab:metadata"]["annotations"] = deepcopy(values)
    item["assets"]["data"]["eolab:metadata"]["annotations"] = deepcopy(values)
    if interval:
        item["properties"].update(
            {
                "datetime": None,
                "start_datetime": "2020-01-01T00:00:00Z",
                "end_datetime": "2020-12-31T23:59:59Z",
            }
        )
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
    assert returned["properties"]["datetime"] == item["properties"]["datetime"]
    with psycopg.connect(dsn) as connection:
        stored = connection.execute(
            "SELECT content FROM pgstac.items WHERE collection=%s AND id=%s",
            (COLLECTION, item["id"]),
        ).fetchone()[0]
    assert (
        stored["properties"]["eolab:metadata"] == item["properties"]["eolab:metadata"]
    )
    assert (
        stored["assets"]["data"]["eolab:metadata"]
        == item["assets"]["data"]["eolab:metadata"]
    )
    listed = api_request(base, "GET", f"/collections/{COLLECTION}/items")["features"][0]
    assert listed["geometry"] is None and "bbox" not in listed
    assert listed["properties"]["eolab:metadata"]["annotations"] == values
    unfiltered = api_request(base, "POST", "/search", {"collections": [COLLECTION]})[
        "features"
    ][0]
    assert unfiltered["geometry"] is None and "bbox" not in unfiltered
    assert unfiltered["properties"]["eolab:metadata"]["annotations"] == values
    projected = api_request(
        base,
        "POST",
        "/search",
        {
            "collections": [COLLECTION],
            "fields": {
                "include": [
                    "geometry",
                    "properties.eolab:metadata",
                    "assets.data.eolab:metadata",
                ],
                "exclude": [
                    "properties.eolab:metadata.annotations.nested",
                    "assets.data.eolab:metadata.annotations.reviewed",
                ],
            },
        },
    )["features"][0]
    assert projected["geometry"] is None
    assert "nested" not in projected["properties"]["eolab:metadata"]["annotations"]
    assert projected["properties"]["eolab:metadata"]["annotations"]["missing"] is None
    assert (
        "reviewed" not in projected["assets"]["data"]["eolab:metadata"]["annotations"]
    )
    geometry_only = api_request(
        base,
        "POST",
        "/search",
        {
            "collections": [COLLECTION],
            "fields": {"include": ["geometry"], "exclude": ["collection"]},
        },
    )["features"][0]
    assert geometry_only["geometry"] is None and "collection" not in geometry_only
    without_geometry = api_request(
        base,
        "POST",
        "/search",
        {
            "collections": [COLLECTION],
            "fields": {"exclude": ["geometry"]},
        },
    )["features"][0]
    assert "geometry" not in without_geometry
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
    assert returned["geometry"] is None and "bbox" not in returned
    assert returned["properties"]["eolab:metadata"]["annotations"] == {}
    assert returned["assets"]["data"]["eolab:metadata"]["annotations"] == values
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


@pytest.mark.parametrize("external", [False, True])
def test_persisted_private_descriptor_is_decodable_on_the_next_scan(
    descriptor_api: tuple[str, str],
    external: bool,
) -> None:
    """Decode nullable private ownership after the actual HTTP and database path.

    Args:
        descriptor_api: Ready private STAC API and guarded database DSN.
        external: Use an external nonspatial source instead of a native raster.
    """
    base, dsn = descriptor_api
    if external:
        item = nonspatial_item()
        item["assets"]["data"]["href"] = "https://example.org/observations.csv"
        item["assets"]["data"]["eolab:access"] = {"kind": "external"}
        source = DescriptorSource(
            href="file:///scan-source/observations.eolab.yaml",
            relative_path="observations.eolab.yaml",
            descriptor_id=item["id"],
            primary_href=item["assets"]["data"]["href"],
            primary_relative_path=None,
            primary_asset_key="data",
            kind="nonspatial",
            claimed_paths=(),
            selector=None,
        )
    else:
        records = json.loads(FIXTURE.read_text(encoding="utf-8"))
        item = deepcopy(
            next(
                record["item"]
                for record in records
                if record["item"]["collection"] == "eolab-mounted-geotiffs"
            )
        )
        collection = api_request(base, "GET", f"/collections/{COLLECTION}")
        collection.update({"id": item["collection"], "links": []})
        api_request(base, "POST", "/collections", collection)
        source = DescriptorSource(
            href="file:///scan-source/depth.tif.eolab.yaml",
            relative_path="depth.tif.eolab.yaml",
            descriptor_id="depth-study",
            primary_href="file:///scan-source/depth.tif",
            primary_relative_path="depth.tif",
            primary_asset_key="data",
            kind="raster",
            claimed_paths=("depth.tif",),
            selector=None,
        )
    item["assets"]["eolab:descriptor-source"] = asdict(source)
    try:
        api_request(
            base,
            "POST",
            f"/collections/{item['collection']}/bulk_items",
            {
                "method": "upsert",
                "items": {item["id"]: item},
            },
        )
        with psycopg.connect(dsn) as connection:
            stored = connection.execute(
                "SELECT content->'assets'->'eolab:descriptor-source' FROM pgstac.items WHERE collection=%s AND id=%s",
                (item["collection"], item["id"]),
            ).fetchone()[0]
        assert TypeAdapter(DescriptorSource).validate_python(stored) == source
        returned = api_request(
            base, "GET", f"/collections/{item['collection']}/items/{item['id']}"
        )
        assert (
            TypeAdapter(DescriptorSource).validate_python(
                returned["assets"]["eolab:descriptor-source"]
            )
            == source
        )
    finally:
        if not external:
            api_request(base, "DELETE", f"/collections/{item['collection']}")
