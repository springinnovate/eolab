"""Transfer per-request feature membership to a native Jobs reader without copying geometries."""

from contextlib import contextmanager
from collections.abc import Iterator, Mapping
from dataclasses import replace
from secrets import token_hex

import httpx2
from pydantic import TypeAdapter
from eolab_app.catalog_selection import ResolvedCatalogSelection, SelectionUnavailableError


class SpatialReads:
    """Hold native feature IDs only while the submitting request owns the source reads."""

    def __init__(self) -> None:
        """Start with no outstanding native reads."""
        self._reads: dict[str, dict[str, frozenset[int]]] = {}

    @contextmanager
    def hold(self, memberships: dict[str, frozenset[int]]) -> Iterator[str]:
        """Give one supervised operation temporary access to its spatial matches.

        Args:
            memberships: Native target IDs for each authorized polygon view.

        Yields:
            A random bearer credential, discarded when the operation stops.
        """
        token = token_hex(32)
        self._reads[token] = memberships
        try:
            yield token
        finally:
            self._reads.pop(token)

    def get(self, token: str) -> Mapping[str, frozenset[int]] | None:
        """Look up the membership for a live native read.

        Args:
            token: Server-issued bearer credential presented by the Jobs worker.

        Returns:
            Authorized original IDs, or None for an unknown or completed read.
        """
        return self._reads.get(token)


async def load_spatial_read(
    client: httpx2.AsyncClient, resolved: ResolvedCatalogSelection, token: str | None,
) -> ResolvedCatalogSelection:
    """Attach original feature IDs authorized by the submitting application request.

    Args:
        client: Internal HTTP client used by the native operation.
        resolved: The worker's independently resolved target source and filter.
        token: Temporary bearer credential or None for an ordinary attribute filter.

    Returns:
        The original selection with its spatial conditions ready to evaluate.

    Raises:
        SelectionUnavailableError: If the submitting reader or its authorization expired.
    """
    if not resolved.selection.filter.intersections:
        return resolved
    if token is None:
        raise SelectionUnavailableError("The selected polygon filter is unavailable.")
    reply = await client.get("http://app:8000/api/vector-sampling/spatial-read",
                             headers={"Authorization": f"Bearer {token}"})
    if reply.status_code != 200:
        raise SelectionUnavailableError("The selected polygon filter is no longer available.")
    memberships = TypeAdapter(dict[str, frozenset[int]]).validate_json(reply.content)
    return replace(resolved, intersections=memberships)
