"""Direct pgSTAC inventory, deletion, and count-cache adapter."""

from collections.abc import AsyncIterator, Iterable
from typing import Any

import psycopg

from eolab_app.catalog.collections import (
    MOUNTED_GEOTIFF_COLLECTION_ID,
)
from eolab_app.catalog.models import CatalogItemSource


class PgStacCatalogDatabase:
    """Implement catalog database operations through libpq."""

    async def existing_item_keys(
        self,
        collection_identifiers: tuple[str, ...],
    ) -> set[tuple[str, str]]:
        """Return Collection and Item identifiers from pgSTAC.

        Args:
            collection_identifiers: Collections included in the inventory.

        Returns:
            Existing Collection and Item identifier pairs.

        Raises:
            psycopg.Error: If the inventory query fails.
        """
        async with await psycopg.AsyncConnection.connect() as connection:
            cursor = await connection.execute(
                "SELECT collection, id FROM pgstac.items WHERE collection = ANY(%s)",
                (list(collection_identifiers),),
            )
            return {(row[0], row[1]) async for row in cursor}

    async def scanner_item_pages(
        self,
        collection_identifiers: tuple[str, ...],
        page_size: int,
    ) -> AsyncIterator[list[CatalogItemSource]]:
        """Stream scanner-owned source Assets in stable key order.

        Args:
            collection_identifiers: Scanner-owned Collections to inspect.
            page_size: Maximum number of Items in each page.

        Yields:
            Pages ordered by Collection and Item identifier.

        Raises:
            psycopg.Error: If a paging query fails.
            ValueError: If a scanner-owned Item lacks a required Asset.
        """
        after: tuple[str, str] | None = None
        async with await psycopg.AsyncConnection.connect() as connection:
            while True:
                if after is None:
                    cursor = await connection.execute(
                        """
                        SELECT collection, id, content->'assets'
                        FROM pgstac.items
                        WHERE collection = ANY(%s)
                        ORDER BY collection, id
                        LIMIT %s
                        """,
                        (list(collection_identifiers), page_size),
                    )
                else:
                    cursor = await connection.execute(
                        """
                        SELECT collection, id, content->'assets'
                        FROM pgstac.items
                        WHERE collection = ANY(%s)
                          AND (collection, id) > (%s, %s)
                        ORDER BY collection, id
                        LIMIT %s
                        """,
                        (
                            list(collection_identifiers),
                            after[0],
                            after[1],
                            page_size,
                        ),
                    )
                rows = await cursor.fetchall()
                if not rows:
                    return
                page = [
                    catalog_item_source(collection, item_id, assets)
                    for collection, item_id, assets in rows
                ]
                yield page
                after = (page[-1].collection, page[-1].item_id)

    async def delete_item_batches(
        self,
        item_batches: Iterable[list[tuple[str, str]]],
    ) -> int:
        """Delete bounded key batches in one pgSTAC transaction.

        Args:
            item_batches: Batches of Collection and Item identifier pairs.

        Returns:
            Number of Items removed.

        Raises:
            psycopg.Error: If deletion fails. The context manager rolls the
                transaction back before propagating the failure.
        """
        removed = 0
        async with await psycopg.AsyncConnection.connect() as connection:
            for item_keys in item_batches:
                collections, item_ids = zip(*item_keys, strict=True)
                cursor = await connection.execute(
                    """
                    DELETE FROM pgstac.items AS item
                    USING unnest(%s::text[], %s::text[])
                        AS stale(collection, id)
                    WHERE item.collection = stale.collection
                      AND item.id = stale.id
                    """,
                    (list(collections), list(item_ids)),
                )
                removed += cursor.rowcount
        return removed

    async def invalidate_search_count_cache(self) -> None:
        """Discard cached Item Search counts after a scan.

        Raises:
            psycopg.Error: If the cache invalidation query fails.
        """
        async with await psycopg.AsyncConnection.connect() as connection:
            await connection.execute("DELETE FROM pgstac.search_wheres")


def catalog_item_source(
    collection: str,
    item_id: str,
    assets: dict[str, Any],
) -> CatalogItemSource:
    """Extract source Assets required by a scanner-owned Collection.

    Args:
        collection: Collection containing the Item.
        item_id: Item identifier within the Collection.
        assets: STAC Asset mapping stored by pgSTAC.

    Returns:
        Item identity and its required source Asset locations.

    Raises:
        ValueError: If a required source Asset is missing.
    """
    required_asset_keys = (
        ("data",)
        if collection == MOUNTED_GEOTIFF_COLLECTION_ID
        else ("shp", "shx", "dbf", "prj")
    )
    try:
        asset_hrefs = tuple(assets[key]["href"] for key in required_asset_keys)
    except KeyError as error:
        raise ValueError(
            f"{collection}/{item_id} is missing required source Assets"
        ) from error
    return CatalogItemSource(collection, item_id, asset_hrefs)
