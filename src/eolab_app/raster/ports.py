"""Focused collaborator contracts used by raster application services."""

from pathlib import Path
from typing import Any, Protocol

from eolab_app.raster.models import (
    CatalogRasterRequest,
    RasterReaderAssessment,
)


class RasterCatalog(Protocol):
    """Authoritative catalog operations required by raster workflows."""

    async def get_item(
        self,
        request: CatalogRasterRequest,
    ) -> dict[str, Any]:
        """Load the authoritative Item matching a validated request.

        Args:
            request: Validated Collection and Item identity.

        Returns:
            Authoritative STAC Item.
        """
        ...

    async def upsert_item(
        self,
        request: CatalogRasterRequest,
        item: dict[str, Any],
    ) -> None:
        """Persist one authoritative raster Item.

        Args:
            request: Validated Collection and Item identity.
            item: Complete replacement STAC Item.

        Raises:
            RasterUpstreamError: If the Item cannot be saved.
        """
        ...


class RasterPublisher(Protocol):
    """Rendering adapter required by the publication use case."""

    async def publish(self, resource_name: str, source_path: Path) -> None:
        """Publish and style one mounted GeoTIFF.

        Args:
            resource_name: Stable GeoServer resource name.
            source_path: Canonical mounted GeoTIFF path.

        Raises:
            RasterUpstreamError: If publication or styling fails.
        """
        ...


class RasterReaderAssessor(Protocol):
    """Read-only deployed-reader boundary required by raster assessment.

    Implementations acquire source metadata without publishing or modifying a
    GeoServer catalog resource.
    """

    async def assess(self, source_path: Path) -> RasterReaderAssessment:
        """Ask the deployed reader to acquire one mounted GeoTIFF.

        Args:
            source_path: Canonical mounted GeoTIFF path.

        Returns:
            Stable reader compatibility result.

        Raises:
            RasterUpstreamError: If the reader assessment service is
                unavailable or violates its response contract.
        """
        ...
