"""Execute Catalog inventory paging against the disposable PostgreSQL database."""

import asyncio
import json
from pathlib import Path
from typing import Any

import psycopg
import pytest

from eolab_app.catalog.pgstac import PgStacCatalogDatabase
from eolab_app.processing.job_store import PostgresJobStore
from eolab_app.vector_field_values import (
    VECTOR_FIELD_VALUES_KEY,
    CatalogVectorFieldValueQuery,
    VectorFieldValuesUnavailable,
    read_field_value_inventory,
)
from test_processing_jobs import store  # noqa: F401
from test_vector_field_value_admission import write_text_layer


def test_catalog_inventory_query_refresh_and_removal(
    store: PostgresJobStore, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Verify actual JSON paging, Unicode matching and replacement/deletion behavior.

    Args:
        store: Existing fixture enforcing an explicit disposable database name.
        monkeypatch: Route only this adapter's connections to the disposable DSN.
        tmp_path: Disposable native source for the production admission helper.
    """
    # The query uses only these pgSTAC columns; no deployed Catalog is modified.
    with psycopg.connect(store.conninfo) as connection:
        connection.execute("CREATE SCHEMA IF NOT EXISTS pgstac")
        connection.execute(
            "CREATE TABLE pgstac.items (collection text, id text, content jsonb)"
        )

    original_connect = psycopg.AsyncConnection.connect

    async def connect() -> psycopg.AsyncConnection:
        """Connect the Catalog adapter only to the explicitly disposable database.

        Returns:
            Real asynchronous PostgreSQL connection.
        """
        return await original_connect(store.conninfo)

    monkeypatch.setattr(psycopg.AsyncConnection, "connect", connect)
    database = PgStacCatalogDatabase()
    source_values = [
        "",
        "Straße",
        "STRASSE",
        "é",
        "e\u0301",
        *[f"value {i:04d}" for i in range(550)],
    ]
    source = tmp_path / "values.gpkg"
    write_text_layer(source, "GPKG", source_values)
    inventory = read_field_value_inventory(str(source), "values", {"label": "str"})
    exact = sorted(source_values[:255])

    def publish(properties: dict[str, Any]) -> None:
        """Replace the Item's admitted properties in the real database.

        Args:
            properties: Complete replacement private admission metadata.
        """
        with psycopg.connect(store.conninfo) as connection:
            connection.execute("DELETE FROM pgstac.items")
            connection.execute(
                "INSERT INTO pgstac.items VALUES (%s, %s, %s::jsonb)",
                (
                    "eolab-mounted-vectors",
                    "source",
                    json.dumps({"properties": properties}),
                ),
            )

    def query(**kwargs: Any) -> Any:
        """Run the production SQL adapter using a chosen bounded value query.

        Args:
            **kwargs: String field, search or page settings.

        Returns:
            Production page or None for an absent Item.
        """
        return asyncio.run(
            database.get_vector_field_values(
                CatalogVectorFieldValueQuery(
                    collectionId="eolab-mounted-vectors",
                    itemId="source",
                    field="label",
                    **kwargs,
                )
            )
        )

    try:
        publish({VECTOR_FIELD_VALUES_KEY: inventory})
        collected = []
        offset = 0
        while True:
            page = query(offset=offset, limit=100)
            collected.extend(page.values)
            assert page.truncated
            if page.next_offset is None:
                break
            offset = page.next_offset
        assert collected == exact
        assert query(search="STRASSE").values == ("STRASSE", "Straße")
        assert query(search="%_").values == ()  # Substring, not SQL wildcard syntax.
        assert (
            query(search="value 0549").values == ()
            and query(search="value 0549").truncated
        )
        assert query(offset=1000).values == ()
        publish(
            {
                VECTOR_FIELD_VALUES_KEY: {
                    "label": {
                        "values": [["replacement", "replacement"]],
                        "truncated": False,
                    }
                }
            }
        )
        assert query().values == ("replacement",)
        assert not query().truncated
        publish(
            {VECTOR_FIELD_VALUES_KEY: {"label": {"values": [], "truncated": False}}}
        )
        assert query().values == () and query().next_offset is None
        publish({VECTOR_FIELD_VALUES_KEY: {}})
        with pytest.raises(VectorFieldValuesUnavailable, match="string field"):
            query()
        publish({})
        with pytest.raises(VectorFieldValuesUnavailable, match="scan"):
            query()
        with psycopg.connect(store.conninfo) as connection:
            connection.execute("DELETE FROM pgstac.items")
        assert query() is None
    finally:
        with psycopg.connect(store.conninfo) as connection:
            connection.execute("DROP TABLE pgstac.items")
