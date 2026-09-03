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

    def build_composite_sld(
        self,
        layer_name: str,
        style_name: str,
        style_environment: str | None,
        style_definition: Mapping[str, object] | None,
        opacity: float,
    ) -> bytes:
        """Build one authorized layer entry for a composite SLD document.

        Args:
            layer_name: Current workspace-qualified GeoServer layer identity.
            style_name: Feature-owned style identity requested by the browser.
            style_environment: Optional raster dynamic-style environment.
            style_definition: Optional complete vector style definition.
            opacity: Neutral retained-layer opacity from zero through one.

        Returns:
            One complete SLD document containing exactly one named layer.

        Raises:
            PublishedLayerRequestError: If the requested appearance does not
                match this feature's current authorized contract.
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
