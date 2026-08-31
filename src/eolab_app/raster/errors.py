"""Application-level failures exposed by the raster feature."""

from typing import Literal


RasterPublicationFailureCategory = Literal[
    "reader_rejection",
    "connectivity",
    "authentication",
    "timeout",
    "configuration",
    "upstream_failure",
]


class RasterFeatureError(Exception):
    """Describe a stable raster failure without coupling it to HTTP.

    Args:
        detail: Browser-safe explanation of the failure.

    Attributes:
        detail: Browser-safe explanation of the failure.
    """

    def __init__(self, detail: str) -> None:
        """Store the browser-safe failure detail.

        Args:
            detail: Browser-safe explanation of the failure.

        Returns:
            None.
        """
        super().__init__(detail)
        self.detail = detail


class RasterRequestError(RasterFeatureError):
    """Raised when a request references an unapproved raster layer."""


class RasterNotFoundError(RasterFeatureError):
    """Raised when an authoritative catalog Item does not exist."""


class RasterAssetError(RasterFeatureError):
    """Raised when a catalog Item has no safe mounted raster Asset."""


class RasterConflictError(RasterFeatureError):
    """Raised when current raster state cannot satisfy an operation."""


class RasterStatisticsCapacityError(RasterConflictError):
    """A temporary statistics admission conflict, safe to retry later."""


class RasterUpstreamError(RasterFeatureError):
    """Raised when a required catalog or rendering adapter fails."""


class RasterPublicationError(RasterUpstreamError):
    """Describe a categorized, browser-safe GeoServer publication failure.

    Args:
        category: Stable machine-readable publication failure category.
        detail: Concise browser-safe explanation and recovery guidance.

    Attributes:
        category: Stable machine-readable publication failure category.
    """

    def __init__(
        self,
        category: RasterPublicationFailureCategory,
        detail: str,
    ) -> None:
        """Store one categorized publication failure.

        Args:
            category: Stable machine-readable publication failure category.
            detail: Concise browser-safe explanation and recovery guidance.

        Returns:
            None.
        """
        super().__init__(detail)
        self.category = category
