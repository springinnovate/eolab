"""Domain-neutral failures for published map-layer authorization."""

from typing import Literal


PublicationFailureCategory = Literal[
    "reader_rejection",
    "connectivity",
    "authentication",
    "timeout",
    "configuration",
    "upstream_failure",
]


class PublishedLayerNotAuthorizedError(Exception):
    """Raised when no feature registry owns a requested WMS layer."""


class PublishedLayerChangedError(Exception):
    """Raised when an authorized layer's source is no longer current."""


class PublishedLayerRequestError(Exception):
    """Raised when WMS parameters violate the owning layer's policy."""
