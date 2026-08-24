"""Application-level failures exposed by vector visualization."""

from eolab_app.rendering.errors import PublicationFailureCategory


class VectorFeatureError(Exception):
    """Describe a stable vector failure without coupling it to HTTP."""

    def __init__(self, detail: str) -> None:
        """Store browser-safe failure detail.

        Args:
            detail: Browser-safe explanation of the failure.
        """
        super().__init__(detail)
        self.detail = detail


class VectorRequestError(VectorFeatureError):
    """Raised when a request references an unapproved vector layer."""


class VectorNotFoundError(VectorFeatureError):
    """Raised when an authoritative catalog Item does not exist."""


class VectorAssetError(VectorFeatureError):
    """Raised when a catalog Item has no safe vector source contract."""


class VectorConflictError(VectorFeatureError):
    """Raised when current vector state cannot satisfy an operation."""


class VectorUpstreamError(VectorFeatureError):
    """Raised when a required catalog or rendering adapter fails."""


class VectorPublicationError(VectorUpstreamError):
    """Describe a categorized GeoServer vector publication failure."""

    def __init__(
        self,
        category: PublicationFailureCategory,
        detail: str,
    ) -> None:
        """Store one categorized publication failure.

        Args:
            category: Stable machine-readable publication failure category.
            detail: Concise browser-safe recovery guidance.
        """
        super().__init__(detail)
        self.category = category
