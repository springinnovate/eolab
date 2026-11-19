"""Pass original sources and selected feature IDs between a request and its native Jobs worker."""

from contextlib import contextmanager
from collections.abc import Iterator
from dataclasses import dataclass, replace
from secrets import token_hex
from typing import TYPE_CHECKING, Any

import httpx2

from eolab_app.catalog_selection import FeatureMatches, ResolvedCatalogSelection, SelectionUnavailableError

if TYPE_CHECKING:
    from eolab_app.feature_intersection import IntersectionLayer

SPATIAL_READ_URL = "http://app:8000/api/vector-sampling/spatial-read"


@dataclass
class SpatialRead:
    """Data available to one native reader until its submitting request ends."""

    inputs: dict[str, Any]
    result: FeatureMatches | None = None


class SpatialReads:
    """Keep large inputs and results out of the Jobs queue while original sources are held."""

    def __init__(self) -> None:
        """Start with no outstanding native reads."""
        self._reads: dict[str, SpatialRead] = {}

    @contextmanager
    def hold(self, inputs: dict[str, Any]) -> Iterator[tuple[str, SpatialRead]]:
        """Yield a temporary worker credential and remove it when the source read ends."""
        token = token_hex(32)
        read = self._reads[token] = SpatialRead(inputs)
        try:
            yield token, read
        finally:
            del self._reads[token]

    def get(self, token: str) -> SpatialRead | None:
        """Return the active read for a worker's bearer token, or None after it has ended."""
        return self._reads.get(token)


def worker_layer(layer: "IntersectionLayer") -> dict[str, Any]:
    """Describe an authorized vector file or supply the committed drawing polygons for a native read."""
    if not isinstance(layer, ResolvedCatalogSelection):
        return {"polygons": [polygon.model_dump(mode="json") for polygon in layer]}
    return {"selection": layer.selection.model_dump(mode="json", by_alias=True),
            "uploadOwner": layer.upload_owner, "readLease": layer.read_lease,
            "matches": layer.matches.model_dump(mode="json") if layer.matches is not None else None}


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
    reply = await client.get(SPATIAL_READ_URL,
                             headers={"Authorization": f"Bearer {token}"})
    if reply.status_code != 200:
        raise SelectionUnavailableError("The selected polygon filter is no longer available.")
    return replace(resolved, matches=FeatureMatches.model_validate_json(reply.content))
