"""Test catalog database and STAC Transactions adapters."""

import asyncio
from unittest.mock import AsyncMock

import httpx2
import psycopg
import pytest

from eolab_app.catalog.pgstac import PgStacCatalogDatabase, catalog_item_source
from eolab_app.catalog.search_counts import number_matched_is_estimated
from eolab_app.catalog.stac_api import StacApiWriter


def test_pgstac_inventory_requires_scanner_owned_source_assets() -> None:
    """Reject a scanner-owned raster without its authoritative data Asset."""
    try:
        catalog_item_source("eolab-mounted-geotiffs", "geotiff-a", {})
    except ValueError as error:
        assert str(error) == (
            "eolab-mounted-geotiffs/geotiff-a is missing required source Assets"
        )
    else:
        raise AssertionError("missing data Asset was accepted")


@pytest.mark.parametrize("item_id", ("geopackage-layer", "geojson-file"))
def test_pgstac_inventory_tracks_single_file_vector_assets(item_id: str) -> None:
    """Use the data Asset for each supported single-file vector format.

    Args:
        item_id: Format-specific Item identity prefix under test.
    """
    source = catalog_item_source(
        "eolab-mounted-vectors",
        item_id,
        {"data": {"href": "file:///scan-source/vector-data"}},
    )

    assert source.asset_hrefs == ("file:///scan-source/vector-data",)


def test_pgstac_random_item_uses_filtered_selection_function(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pass filters and repeat avoidance to the database-owned query."""
    item = {
        "type": "Feature",
        "collection": "collection-a",
        "id": "item-b",
    }
    cursor = AsyncMock()
    cursor.fetchone.return_value = (item,)
    connection = AsyncMock()
    connection.__aenter__.return_value = connection
    connection.execute.return_value = cursor
    connect = AsyncMock(return_value=connection)
    monkeypatch.setattr(psycopg.AsyncConnection, "connect", connect)

    selected = asyncio.run(
        PgStacCatalogDatabase().random_matching_item(
            {"datetime": "2025-01-01T00:00:00Z/2025-12-31T23:59:59Z"},
            ("collection-a", "item-a"),
        )
    )

    assert selected == item
    query, parameters = connection.execute.await_args.args
    assert "pgstac.eolab_random_matching_item" in query
    assert parameters == (
        '{"datetime": "2025-01-01T00:00:00Z/2025-12-31T23:59:59Z"}',
        "collection-a",
        "item-a",
    )


def test_count_estimate_lookup_uses_pgstac_search_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Resolve pgSTAC functions called without schema-qualified names."""
    cursor = AsyncMock()
    cursor.fetchone.return_value = (True,)
    connection = AsyncMock()
    connection.__aenter__.return_value = connection
    connection.execute.return_value = cursor
    connect = AsyncMock(return_value=connection)
    monkeypatch.setattr(psycopg.AsyncConnection, "connect", connect)

    assert asyncio.run(
        number_matched_is_estimated(b'{"limit": 20}', 106967)
    )
    connect.assert_awaited_once_with(options="-c search_path=pgstac,public")


def test_pgstac_retires_only_other_temporal_ids_at_published_descriptors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Scope retirement to published descriptor paths and return deleted IDs.

    Args:
        monkeypatch: Replaces only the external PostgreSQL connection.
    """
    cursor = AsyncMock()
    cursor.fetchall.return_value = [("eolab-temporal-datasets", "old-weather")]
    connection = AsyncMock()
    connection.__aenter__.return_value = connection
    connection.execute.return_value = cursor
    monkeypatch.setattr(
        psycopg.AsyncConnection, "connect", AsyncMock(return_value=connection)
    )
    hrefs = ["file:///data/weather/dataset.yaml", "file:///data/ocean/dataset.yaml"]
    items = [
        {
            "id": item_id,
            "collection": "eolab-temporal-datasets",
            "assets": {"eolab:temporal-source": {"href": href}},
        }
        for item_id, href in zip(("weather", "ocean"), hrefs)
    ]

    retired = asyncio.run(PgStacCatalogDatabase().delete_replaced_temporal_items(items))

    assert retired == (("eolab-temporal-datasets", "old-weather"),)
    connection.execute.assert_awaited_once()
    query, parameters = connection.execute.await_args.args
    assert parameters == (["weather", "ocean"], hrefs, "eolab-temporal-datasets")
    assert "item.collection = %s" in query
    assert "item.content->'assets'->'eolab:temporal-source'->>'href'" in query
    assert "= published.href" in query
    assert "item.id <> published.id" in query
    assert "RETURNING item.collection, item.id" in query


def test_stac_api_writer_bounds_upstream_error_detail() -> None:
    """Expose status and path without retaining an unbounded response."""
    request_timeouts: list[float] = []

    async def handler(request: httpx2.Request) -> httpx2.Response:
        request_timeouts.append(request.extensions["timeout"]["read"])
        return httpx2.Response(503, text="x" * 1000, request=request)

    async def write_collection() -> None:
        writer = StacApiWriter(
            "http://catalog:8080",
            httpx2.MockTransport(handler),
            write_timeout_seconds=17,
            error_detail_limit=23,
        )
        async with writer.session() as session:
            await session.upsert_collection({"id": "test"})

    try:
        asyncio.run(write_collection())
    except RuntimeError as error:
        assert str(error).startswith(
            "STAC API returned 503 for GET /collections/test: "
        )
        assert len(str(error).rsplit(": ", 1)[1]) == 23
        assert request_timeouts == [17]
    else:
        raise AssertionError("upstream rejection was accepted")
