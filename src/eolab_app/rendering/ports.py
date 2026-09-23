"""Neutral contracts used by the restricted WMS delivery boundary."""

from collections.abc import Awaitable, Callable, Mapping
from typing import Protocol

import httpx2


class MapRenderQueue(Protocol):
    """Admit an authorized HTTP render without exposing queue implementation."""

    async def run(
        self,
        request: Callable[[], Awaitable[httpx2.Response]],
        *,
        tile_key: str = "unspecified",
    ) -> httpx2.Response:
        """Wait for rendering capacity and then send the supplied request.

        Args:
            request: Deferred upstream GetMap HTTP operation.
            tile_key: Opaque diagnostic identity; does not change scheduling.

        Returns:
            Completed HTTP response, including upstream error responses.

        Raises:
            RenderQueueUnavailableError: If the queue is full, closed, or expires.
            RenderExecutionTimeoutError: If the admitted render exceeds its deadline.
            httpx2.RequestError: If the upstream transport fails.
            asyncio.CancelledError: If the caller cancels or the queue shuts down.
        """
        ...


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

    def prepare_query(
        self, operation: str, query: list[tuple[str, str]],
    ) -> list[tuple[str, str]]:
        """Translate authorized public identities into an upstream WMS request.

        Args:
            operation: Validated lowercase WMS operation.
            query: Globally bounded and feature-validated public query entries.

        Returns:
            Server-owned upstream query entries.
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
