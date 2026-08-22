"""Test catalog database and STAC Transactions adapters."""

import asyncio

import httpx2

from eolab_app.catalog.pgstac import catalog_item_source
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


def test_stac_api_writer_bounds_upstream_error_detail() -> None:
    """Expose status and path without retaining an unbounded response."""
    async def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(503, text="x" * 1000, request=request)

    async def write_collection() -> None:
        writer = StacApiWriter(
            "http://catalog:8080",
            httpx2.MockTransport(handler),
        )
        async with writer.session() as session:
            await session.upsert_collection({"id": "test"})

    try:
        asyncio.run(write_collection())
    except RuntimeError as error:
        assert str(error).startswith(
            "STAC API returned 503 for GET /collections/test: "
        )
        assert len(str(error).rsplit(": ", 1)[1]) == 500
    else:
        raise AssertionError("upstream rejection was accepted")
