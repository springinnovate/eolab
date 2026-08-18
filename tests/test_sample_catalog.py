"""Test the sample STAC records used for deployment verification."""

import json
from pathlib import Path


SAMPLE_DIRECTORY = Path(__file__).parents[1] / "catalog" / "sample"
REPOSITORY_ROOT = Path(__file__).parents[1]


def test_sample_catalog_is_packaged_in_the_seed_image() -> None:
    """Keep the seed job independent of deployment-time bind mounts."""
    dockerfile = (REPOSITORY_ROOT / "Dockerfile.catalog-seed").read_text(
        encoding="utf-8"
    )
    compose = (REPOSITORY_ROOT / "docker-compose.yml").read_text(encoding="utf-8")

    assert "COPY catalog/load_sample.sh /catalog/load_sample.sh" in dockerfile
    assert (
        "COPY catalog/sample/collections.ndjson /catalog/sample/collections.ndjson"
        in dockerfile
    )
    assert (
        "COPY catalog/sample/items.ndjson /catalog/sample/items.ndjson" in dockerfile
    )
    assert "dockerfile: Dockerfile.catalog-seed" in compose
    assert "./catalog:/catalog" not in compose


def test_sample_catalog_has_one_collection_and_four_items() -> None:
    """Provide stable, internally consistent records for the catalog interface."""
    collection_lines = (
        SAMPLE_DIRECTORY / "collections.ndjson"
    ).read_text(encoding="utf-8").splitlines()
    item_lines = (
        SAMPLE_DIRECTORY / "items.ndjson"
    ).read_text(encoding="utf-8").splitlines()

    assert len(collection_lines) == 1
    assert len(item_lines) == 4

    collection = json.loads(collection_lines[0])
    items = [json.loads(item_line) for item_line in item_lines]

    assert collection["type"] == "Collection"
    assert collection["id"] == "eolab-sample-data"
    assert len({item["id"] for item in items}) == 4
    assert {item["collection"] for item in items} == {collection["id"]}

    for item in items:
        assert item["type"] == "Feature"
        assert item["geometry"]["type"] == "Polygon"
        assert len(item["bbox"]) == 4
        assert item["properties"]["datetime"].endswith("Z")
        assert item["properties"]["title"]
        assert item["properties"]["description"]
        assert item["assets"]["data"]["roles"] == ["data"]
