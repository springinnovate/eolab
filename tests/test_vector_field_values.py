"""Exercise prepared string suggestions without rendering or source scans."""

import asyncio
from typing import Any
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from eolab_app.catalog.pgstac import PgStacCatalogDatabase
from eolab_app.catalog.public_metadata import copy_public_catalog_metadata
from eolab_app.routes.catalog import create_catalog_router
from eolab_app.vector_field_values import (
    VECTOR_FIELD_VALUES_KEY,
    CatalogVectorFieldValueQuery,
    VectorFieldValuePage,
    VectorFieldValueQuery,
    VectorFieldValuesUnavailable,
    page_field_values,
    string_field_names,
)


def test_pages_preserve_exact_strings_and_unicode_search() -> None:
    """Keep case/Unicode distinctions while matching full Unicode casefold text."""
    values = sorted({"", "Straße", "STRASSE", "e\u0301", "é", "Alpha", "alpha"})
    inventory = {"name": [(value, value.casefold()) for value in values], "empty": []}
    collected = []
    offset = 0
    while True:
        page = page_field_values(
            inventory, VectorFieldValueQuery(field="name", offset=offset, limit=2)
        )
        collected.extend(page.values)
        if page.next_offset is None:
            break
        offset = page.next_offset
    assert collected == values
    assert page_field_values(
        inventory, VectorFieldValueQuery(field="name", search="strasse")
    ).values == ("STRASSE", "Straße")
    assert (
        page_field_values(inventory, VectorFieldValueQuery(field="empty")).values == ()
    )
    assert (
        page_field_values(
            inventory, VectorFieldValueQuery(field="name", search="absent")
        ).next_offset
        is None
    )
    assert (
        page_field_values(
            inventory, VectorFieldValueQuery(field="name", offset=100)
        ).values
        == ()
    )
    with pytest.raises(VectorFieldValuesUnavailable):
        page_field_values(inventory, VectorFieldValueQuery(field="number"))


def test_only_string_schema_fields_receive_inventories() -> None:
    """Admit Fiona strings and nullable JSON strings without guessing categories."""
    assert string_field_names(
        {
            "fiona": "str:100",
            "ogr": "String",
            "nullable": "string | null",
            "mixed": "integer|string",
            "number": "int",
            "date": "date",
            "boolean": "boolean",
            "missing": "null",
        }
    ) == ("fiona", "ogr", "nullable")


@pytest.mark.parametrize("projected", [False, True])
def test_public_catalog_metadata_never_contains_inventories(projected: bool) -> None:
    """Strip private values even when a STAC projection omits Item identity."""
    properties = {
        VECTOR_FIELD_VALUES_KEY: {
            "name": [["private vocabulary", "private vocabulary"]]
        },
        "title": "Visible",
    }
    item: dict[str, Any] = {"properties": properties}
    if not projected:
        item.update({"id": "source", "collection": "eolab-mounted-vectors"})
    public = copy_public_catalog_metadata({"features": [item]})
    assert public["features"][0]["properties"] == {"title": "Visible"}
    assert VECTOR_FIELD_VALUES_KEY in properties


def test_catalog_value_route_validates_identity_and_pages() -> None:
    """Use a path-free lookup contract independent of vector styling services."""
    lookup = AsyncMock(
        return_value=VectorFieldValuePage(field="name", values=("Exact",), nextOffset=1)
    )
    app = FastAPI()
    app.include_router(create_catalog_router(AsyncMock(), AsyncMock(), lookup))
    client = TestClient(app)
    body = {
        "collectionId": "eolab-mounted-vectors",
        "itemId": "layer",
        "field": "name",
        "search": "ex",
        "limit": 1,
    }
    response = client.post("/api/catalog/vector-field-values", json=body)
    assert response.status_code == 200
    assert response.json() == {"field": "name", "values": ["Exact"], "nextOffset": 1}
    assert response.headers["cache-control"] == "no-store"
    assert lookup.await_args.args[0].model_dump(by_alias=True) == {**body, "offset": 0}
    for invalid in (
        {"path": "/private/source"},
        {"limit": 101},
        {"offset": -1},
        {"offset": 10**30},
    ):
        assert (
            client.post(
                "/api/catalog/vector-field-values", json={**body, **invalid}
            ).status_code
            == 422
        )
    lookup.return_value = None
    assert client.post("/api/catalog/vector-field-values", json=body).status_code == 404
    lookup.side_effect = VectorFieldValuesUnavailable(
        "Run a Catalog scan to refresh it."
    )
    unavailable = client.post("/api/catalog/vector-field-values", json=body)
    assert unavailable.status_code == 409 and "scan" in unavailable.text


def test_catalog_adapter_returns_only_requested_metadata_page(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Bind all query inputs and use prepared Unicode search rather than SQL lower."""
    cursor = AsyncMock()
    cursor.fetchone.return_value = (True, True, ["STRASSE", "Straße", "extra"])
    connection = AsyncMock()
    connection.__aenter__.return_value = connection
    connection.execute.return_value = cursor
    monkeypatch.setattr(
        "psycopg.AsyncConnection.connect", AsyncMock(return_value=connection)
    )
    query = CatalogVectorFieldValueQuery(
        collectionId="eolab-mounted-vectors",
        itemId="layer",
        field="name",
        search="STRASSE",
        offset=5,
        limit=2,
    )
    page = asyncio.run(PgStacCatalogDatabase().get_vector_field_values(query))
    assert page.values == ("STRASSE", "Straße") and page.next_offset == 7
    sql, params = connection.execute.await_args.args
    assert "WITH ORDINALITY" in sql and "lower(" not in sql
    assert params == (
        VECTOR_FIELD_VALUES_KEY,
        "eolab-mounted-vectors",
        "layer",
        "name",
        "name",
        "strasse",
        5,
        3,
    )
    cursor.fetchone.return_value = (False, None, [])
    with pytest.raises(VectorFieldValuesUnavailable, match="scan"):
        asyncio.run(PgStacCatalogDatabase().get_vector_field_values(query))
