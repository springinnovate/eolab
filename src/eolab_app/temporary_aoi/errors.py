"""Stable application failures for the temporary-AOI feature."""


class TemporaryAoiError(Exception):
    """Describe a browser-safe temporary-AOI failure.

    Args:
        detail: Actionable public explanation of the failure.
    """

    def __init__(self, detail: str) -> None:
        """Store the browser-safe failure detail.

        Args:
            detail: Actionable public explanation of the failure.
        """
        super().__init__(detail)
        self.detail = detail


class TemporaryAoiRequestError(TemporaryAoiError):
    """Raised when the HTTP-owned upload contract is invalid.

    Attributes:
        detail: Browser-safe request correction guidance inherited from the
            base application failure.
    """


class TemporaryAoiTooLargeError(TemporaryAoiError):
    """Raised when upload or extracted data exceeds a resource ceiling.

    Attributes:
        detail: Browser-safe resource-limit explanation inherited from the
            base application failure.
    """


class TemporaryAoiValidationError(TemporaryAoiError):
    """Raised when an uploaded dataset cannot represent a safe AOI.

    Attributes:
        detail: Browser-safe dataset correction guidance inherited from the
            base application failure.
    """


class TemporaryAoiNotFoundError(TemporaryAoiError):
    """Raised when an opaque temporary identifier is absent or expired.

    Attributes:
        detail: Browser-safe lifecycle explanation inherited from the base
            application failure.
    """


class TemporaryAoiConflictError(TemporaryAoiError):
    """Raised when a temporary AOI is in the wrong lifecycle state.

    Attributes:
        detail: Browser-safe state correction guidance inherited from the base
            application failure.
    """
