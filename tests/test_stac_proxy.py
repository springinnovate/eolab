"""Test the restricted public STAC proxy contract."""

import json
from pathlib import Path
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient

from eolab_app.main import create_app


@pytest.mark.parametrize(
    ("method", "path", "projected"),
    [
        ("GET", "/stac/collections/eolab-temporal-datasets/items/era5", False),
        ("GET", "/stac/search", False),
        ("POST", "/stac/search", True),
    ],
)
def test_stac_proxy_omits_private_source_metadata(
    configured_environment: None,
    version_file_path: Path,
    method: str,
    path: str,
    projected: bool,
) -> None:
    """Keep paths and complete string inventories out of public Item/search replies.

    Args:
        configured_environment: Application settings isolated by the fixture.
        version_file_path: Disposable application version file.
        method: Public proxy HTTP method.
        path: Item or search route.
        projected: Whether the upstream result omits Item identity.
    """
    private_path = "file:///private/mounted-weather/dataset.yaml"
    item: dict[str, Any] = {
        "assets": {
            "eolab:temporal-source": {"href": private_path},
        }
    }
    if not projected:
        item.update(
            {
                "type": "Feature",
                "id": "era5",
                "collection": "eolab-temporal-datasets",
                "properties": {"eolab:source": "preserved public metadata"},
            }
        )
    item.setdefault("properties", {})["eolab:vector-field-values"] = {
        "label": [["private vocabulary", "private vocabulary"]]
    }
    is_search = path.endswith("/search")
    payload = (
        {"type": "FeatureCollection", "features": [item], "numberMatched": 1}
        if is_search
        else item
    )

    def catalog_response(request: httpx2.Request) -> httpx2.Response:
        """Return the same internal source metadata for reads and searches."""
        return httpx2.Response(
            200,
            json=payload,
            headers={"Content-Type": "application/geo+json"},
        )

    async def exact_count(search_request_body: bytes, number_matched: int) -> bool:
        """Keep the search count header independent of metadata projection."""
        assert number_matched == 1
        return False

    client = TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(catalog_response),
            number_matched_estimate_lookup=exact_count,
        )
    )
    request_options = {"json": {"fields": {"include": ["assets", "properties.eolab:vector-field-values"]}}} if projected else {}
    response = client.request(method, path, **request_options)

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/geo+json"
    assert private_path not in response.text
    assert "eolab:temporal-source" not in response.text
    assert "eolab:vector-field-values" not in response.text
    assert "private vocabulary" not in response.text
    public_item = response.json()["features"][0] if is_search else response.json()
    assert public_item["assets"] == {}
    if not projected:
        assert public_item["properties"] == {"eolab:source": "preserved public metadata"}
    if method == "POST":
        assert response.headers["x-eolab-number-matched-estimated"] == "false"
    assert item["assets"]["eolab:temporal-source"]["href"] == private_path


def test_stac_proxy_preserves_non_json_error(
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Preserve an upstream plain-text failure rather than parsing it as metadata."""

    def catalog_response(request: httpx2.Request) -> httpx2.Response:
        """Represent an upstream proxy error outside the STAC JSON contract."""
        return httpx2.Response(503, text="catalog temporarily unavailable")

    response = TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(catalog_response),
        )
    ).get("/stac/search")

    assert response.status_code == 503
    assert response.headers["content-type"] == "text/plain; charset=utf-8"
    assert response.text == "catalog temporarily unavailable"


def test_stac_proxy_forwards_public_read_request(
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Expose an internal STAC response through the public catalog path."""

    def catalog_response(request: httpx2.Request) -> httpx2.Response:
        assert str(request.url) == "http://stac-api:8080/collections?limit=4"
        assert request.headers["x-forwarded-host"] == "testserver"
        assert request.headers["x-forwarded-proto"] == "http"
        return httpx2.Response(
            200,
            json={"collections": []},
            headers={"Content-Type": "application/json"},
        )

    response = TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(catalog_response),
        )
    ).get("/stac/collections?limit=4")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    assert response.json() == {"collections": []}


def test_stac_proxy_forwards_item_search(
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Forward standard POST Item Search without exposing write endpoints."""

    async def number_matched_is_estimated(
        search_request_body: bytes,
        number_matched: int,
    ) -> bool:
        assert json.loads(search_request_body) == {
            "limit": 20,
            "filter-lang": "cql2-json",
            "filter": {
                "op": "like",
                "args": [{"property": "title"}, "%2004%"],
            },
        }
        assert number_matched == 106967
        return True

    def catalog_response(request: httpx2.Request) -> httpx2.Response:
        assert request.method == "POST"
        assert str(request.url) == "http://stac-api:8080/search"
        assert json.loads(request.content) == {
            "limit": 20,
            "filter-lang": "cql2-json",
            "filter": {
                "op": "like",
                "args": [{"property": "title"}, "%2004%"],
            },
        }
        return httpx2.Response(
            200,
            json={
                "type": "FeatureCollection",
                "features": [],
                "numberMatched": 106967,
            },
            headers={"Content-Type": "application/geo+json"},
        )

    response = TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(catalog_response),
            number_matched_estimate_lookup=number_matched_is_estimated,
        )
    ).post(
        "/stac/search",
        json={
            "limit": 20,
            "filter-lang": "cql2-json",
            "filter": {
                "op": "like",
                "args": [{"property": "title"}, "%2004%"],
            },
        },
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/geo+json"
    assert response.headers["x-eolab-number-matched-estimated"] == "true"
    assert response.json() == {
        "type": "FeatureCollection",
        "features": [],
        "numberMatched": 106967,
    }


def test_stac_proxy_rejects_catalog_writes(
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Keep STAC transaction routes private to the Compose network."""
    response = TestClient(create_app(version_file_path)).post(
        "/stac/collections",
        json={"id": "not-allowed"},
    )

    assert response.status_code == 405
    assert response.json() == {
        "detail": "Only STAC Item Search accepts POST requests"
    }


def test_stac_proxy_reports_unavailable_catalog(
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Report catalog connectivity failure without failing application startup."""

    def unavailable_catalog(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("catalog unavailable", request=request)

    response = TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(unavailable_catalog),
        )
    ).get("/stac")

    assert response.status_code == 502
    assert response.json() == {
        "detail": "The STAC catalog service is unavailable"
    }
