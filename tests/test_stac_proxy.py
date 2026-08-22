"""Test the restricted public STAC proxy contract."""

import json
from pathlib import Path

import httpx2
from fastapi.testclient import TestClient

from eolab_app.main import create_app


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
