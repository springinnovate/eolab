"""Neutral contracts used by the restricted WMS delivery boundary."""

from collections.abc import Mapping
from typing import Protocol


class PublishedLayerAuthorization(Protocol):
    """Browser-safe policy returned for one current published layer."""

    style_name: str

    def validate_parameters(
        self,
        operation: str,
        query: Mapping[str, str],
    ) -> None:
        """Validate feature-owned WMS parameters.

        Args:
            operation: Normalized WMS operation.
            query: Normalized, globally bounded query parameters.

        Raises:
            PublishedLayerRequestError: If feature-owned parameters are not
                authorized for this layer.
        """
        ...


class PublishedLayerRegistry(Protocol):
    """Require current authorization for one feature-owned WMS layer."""

    def require_current(self, layer_name: str) -> PublishedLayerAuthorization:
        """Require one current published layer.

        Args:
            layer_name: Workspace-qualified GeoServer layer name.

        Returns:
            Current authorization including the allowed fixed style.

        Raises:
            PublishedLayerNotAuthorizedError: If this registry does not own the
                layer.
            PublishedLayerChangedError: If its mounted source changed.
        """
        ...
