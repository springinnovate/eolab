"""Focused collaborator contracts used by raster application services."""

from pathlib import Path
from typing import Any, Protocol

from eolab_app.raster.source_models import (
    TemporalRasterSelection,
    TemporalIntervalSelection,
)
from eolab_app.raster.temporal import TemporalObservation

from eolab_app.raster.models import (
    AuthorizedRaster,
    CatalogRasterRequest,
)


class RasterCatalog(Protocol):
    """Authoritative catalog operations required by raster workflows."""

    async def get_item(
        self,
        request: (
            CatalogRasterRequest | TemporalRasterSelection | TemporalIntervalSelection
        ),
    ) -> dict[str, Any]:
        """Load the authoritative Item matching a validated request.

        Args:
            request: Validated Collection and Item identity.

        Returns:
            Authoritative STAC Item.
        """
        ...


class RasterPublisher(Protocol):
    """Rendering adapter required by the publication use case."""

    async def publish(
        self, resource_name: str, source_path: Path, *, advertised: bool = True
    ) -> None:
        """Publish and style one mounted GeoTIFF.

        Args:
            resource_name: Stable GeoServer resource name.
            source_path: Canonical mounted GeoTIFF path.
            advertised: Whether public capabilities may list this layer.

        Raises:
            RasterUpstreamError: If publication or styling fails.
        """
        ...

    async def temporary_layers(self) -> tuple[str, ...]:
        """List model-output and temporal-slice publications for cleanup.

        Returns:
            Unqualified names in the reserved model_ and slice_ namespaces.

        Raises:
            RasterUpstreamError: If GeoServer cannot list its resources.
        """
        ...

    async def remove(self, resource_name: str) -> None:
        """Remove a publication and its tiles without deleting its source file.

        Args:
            resource_name: Server-owned resource selected for cleanup.

        Raises:
            RasterUpstreamError: If unpublication fails and must be retried.
        """
        ...


class RasterSourceResolver(Protocol):
    """Resolve authoritative catalog Items to mounted raster sources."""

    def resolve(self, item: dict[str, Any]) -> Path:
        """Resolve one scanner-owned data Asset inside its configured mount.

        Args:
            item: Authoritative scanner-owned STAC Item.

        Returns:
            Canonical mounted GeoTIFF path.

        Raises:
            RasterFeatureError: If the Asset is absent, invalid, unavailable,
                or outside the configured mount.
        """
        ...

    def get_observations(
        self,
        item: dict[str, Any],
        selection: TemporalRasterSelection | TemporalIntervalSelection,
    ) -> tuple[TemporalObservation, ...]:
        """Resolve selected published observations inside the source mount.

        Args:
            item: Authoritative temporal Item.
            selection: Validated variable and time or interval.

        Returns:
            Ordered available observations with confined array locations.

        Raises:
            RasterFeatureError: If the selection or archive cannot be read.
        """
        ...


class RasterSourceAuthorizer(Protocol):
    """Authorize mounted catalog sources for rendering-independent analysis."""

    async def authorize(
        self,
        request: CatalogRasterRequest,
    ) -> AuthorizedRaster:
        """Resolve one current scanner-owned source.

        Args:
            request: Validated Collection and Item identity.

        Returns:
            Current mounted source authorization.

        Raises:
            RasterFeatureError: If catalog, mount, or source identity
                validation fails.
        """
        ...

    async def get_observations(
        self,
        selection: TemporalRasterSelection | TemporalIntervalSelection,
    ) -> tuple[TemporalObservation, ...]:
        """Authorize selected temporal observations independently of rendering.

        Args:
            selection: Validated Catalog variable and time or interval.

        Returns:
            Available observations in time order.

        Raises:
            RasterFeatureError: If Catalog, mount or selection access fails.
        """
        ...
