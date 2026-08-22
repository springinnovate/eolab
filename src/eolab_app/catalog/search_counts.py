"""Read pgSTAC's cached Item Search count classification."""

import psycopg


async def number_matched_is_estimated(
    search_request_body: bytes,
    number_matched: int,
) -> bool:
    """Report whether pgSTAC supplied its estimate for an Item Search count.

    Args:
        search_request_body: Original STAC Item Search JSON body.
        number_matched: Count returned by pgSTAC for that search.

    Returns:
        Whether the returned count came from pgSTAC's estimate.

    Raises:
        RuntimeError: If pgSTAC did not retain statistics for the search.
        UnicodeDecodeError: If the request body is not valid UTF-8.
        psycopg.Error: If the catalog database query fails.
    """
    async with await psycopg.AsyncConnection.connect(
        options="-c search_path=pgstac,public"
    ) as connection:
        cursor = await connection.execute(
            """
            SELECT total_count IS NULL
            FROM pgstac.search_wheres
            WHERE md5(_where) = md5(
                pgstac.stac_search_to_where(%s::jsonb)
            )
            AND COALESCE(total_count, estimated_count) = %s
            """,
            (search_request_body.decode(), number_matched),
        )
        result = await cursor.fetchone()
    if result is None:
        raise RuntimeError("pgSTAC did not record Item Search count statistics")
    return result[0]
