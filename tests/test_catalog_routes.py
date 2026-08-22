"""Test filtered random Catalog discovery routes."""

from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from eolab_app.routes.catalog import create_catalog_router


CATALOG_ITEM = {
    "type": "Feature",
    "id": "geotiff-random",
    "collection": "eolab-mounted-geotiffs",
    "geometry": None,
    "properties": {"title": "Random raster"},
    "assets": {},
}


def catalog_client(random_item_lookup: Any) -> TestClient:
    """Create an isolated application around the Catalog route."""
    application = FastAPI()
    application.include_router(create_catalog_router(random_item_lookup))
    return TestClient(application)


def test_surprise_route_forwards_active_filter_and_exclusion() -> None:
    """Use the exact active STAC filter and avoid the current selection."""
    calls: list[tuple[dict[str, Any], tuple[str, str] | None]] = []

    async def random_item_lookup(
        search: dict[str, Any],
        excluded_item: tuple[str, str] | None,
    ) -> dict[str, Any]:
        calls.append((search, excluded_item))
        return CATALOG_ITEM

    response = catalog_client(random_item_lookup).post(
        "/api/catalog/surprise",
        json={
            "search": {
                "filter-lang": "cql2-json",
                "filter": {
                    "op": "=",
                    "args": [{"property": "assets.data.type"}, "cog"],
                },
                "datetime": "2020-01-01T00:00:00Z/2020-12-31T23:59:59Z",
            },
            "exclude": {
                "collection": "eolab-mounted-geotiffs",
                "id": "geotiff-previous",
            },
        },
    )

    assert response.status_code == 200
    assert response.json() == {"item": CATALOG_ITEM}
    assert calls == [
        (
            {
                "filter-lang": "cql2-json",
                "filter": {
                    "op": "=",
                    "args": [{"property": "assets.data.type"}, "cog"],
                },
                "datetime": "2020-01-01T00:00:00Z/2020-12-31T23:59:59Z",
            },
            ("eolab-mounted-geotiffs", "geotiff-previous"),
        )
    ]


def test_surprise_route_reports_no_matching_item() -> None:
    """Give the browser a clear empty-filtered-result state."""

    async def no_match(
        search: dict[str, Any],
        excluded_item: tuple[str, str] | None,
    ) -> None:
        return None

    response = catalog_client(no_match).post(
        "/api/catalog/surprise",
        json={"search": {}},
    )

    assert response.status_code == 404
    assert response.json() == {
        "detail": "No Catalog Items match the active filters"
    }


def test_surprise_route_rejects_fields_outside_current_search_contract() -> None:
    """Limit discovery to the filters currently exposed by the app."""

    async def unused_lookup(
        search: dict[str, Any],
        excluded_item: tuple[str, str] | None,
    ) -> None:
        raise AssertionError("invalid search reached the database")

    response = catalog_client(unused_lookup).post(
        "/api/catalog/surprise",
        json={"search": {"collections": ["not-a-current-filter"]}},
    )

    assert response.status_code == 422
    assert "Unsupported Catalog search field: collections" in response.text


def test_surprise_route_reports_database_failure() -> None:
    """Convert an unavailable Catalog database into an actionable response."""

    async def unavailable_lookup(
        search: dict[str, Any],
        excluded_item: tuple[str, str] | None,
    ) -> None:
        raise RuntimeError("database unavailable")

    response = catalog_client(unavailable_lookup).post(
        "/api/catalog/surprise",
        json={"search": {}},
    )

    assert response.status_code == 503
    assert response.json() == {
        "detail": "Random Catalog discovery is unavailable"
    }
