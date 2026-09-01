"""Focused collaborator contracts used by vector application services."""

from pathlib import Path
from threading import Event
from typing import Any, Protocol

from eolab_app.vector.models import (
    CatalogVectorRequest,
    ResolvedVectorSource,
    VectorCategoryRead,
    VectorFormat,
    VectorGeometryKind,
    VectorReaderAssessment,
    VectorStyle,
)


class VectorCatalog(Protocol):
    """Authoritative catalog operations required by vector workflows."""

    async def get_item(
        self,
        request: CatalogVectorRequest,
    ) -> dict[str, Any]:
        """Load the authoritative Item matching a validated request.

        Args:
            request: Validated Collection and Item identity.

        Returns:
            Authoritative STAC Item.

        Raises:
            VectorFeatureError: If the catalog is unavailable or invalid.
        """
        ...

    async def upsert_item(
        self,
        request: CatalogVectorRequest,
        item: dict[str, Any],
    ) -> None:
        """Persist one authoritative assessed vector Item.

        Args:
            request: Validated Collection and Item identity.
            item: Complete replacement STAC Item.

        Raises:
            VectorFeatureError: If the Item cannot be saved.
        """
        ...


class VectorReaderAssessor(Protocol):
    """Read-only deployed datastore boundary used during assessment."""

    async def assess(
        self,
        source_format: VectorFormat,
        source_path: Path,
        layer_name: str,
    ) -> VectorReaderAssessment:
        """Ask deployed GeoTools to open one exact source layer.

        Args:
            source_format: Supported mounted vector format.
            source_path: Canonical mounted container or file path.
            layer_name: Exact native layer selected by the catalog Item.

        Returns:
            Validated compatibility result.

        Raises:
            VectorUpstreamError: If the assessment boundary is unavailable or
                violates its response contract.
        """
        ...


class VectorPublisher(Protocol):
    """Rendering adapter required by vector publication."""

    async def publish(
        self,
        resource_name: str,
        source_format: VectorFormat,
        source_path: Path,
        layer_name: str,
        geometry_kind: VectorGeometryKind,
    ) -> str:
        """Converge and style one exact mounted vector layer.

        Args:
            resource_name: Stable GeoServer feature type and layer name.
            source_format: Supported mounted vector format.
            source_path: Canonical mounted container or file path.
            layer_name: Exact native layer selected by the Item.
            geometry_kind: Default point, line, or polygon style class.

        Returns:
            Unqualified initialized style name assigned to the layer.

        Raises:
            VectorPublicationError: If GeoServer cannot converge the layer.
        """
        ...


class VectorCategoryReader(Protocol):
    """Bounded mounted-source attribute reader for vector styling."""

    def read(
        self,
        source: ResolvedVectorSource,
        field: str,
        feature_limit: int,
        cancel_event: Event,
    ) -> VectorCategoryRead:
        """Count typed values from one exact vector source field.

        Args:
            source: Catalog-derived exact mounted source and native layer.
            field: Authoritative attribute field identity.
            feature_limit: Maximum features whose values may be counted.
            cancel_event: Cooperative cancellation signal checked while reading.

        Returns:
            Bounded observed category counts and completion metadata.

        Raises:
            VectorFeatureError: If the exact source or field cannot be read.
        """
        ...


class VectorStyler(Protocol):
    """GeoServer styling adapter required by the vector style workflow."""

    async def apply_style(
        self,
        resource_name: str,
        style: VectorStyle,
    ) -> str:
        """Create or update one per-layer SLD and assign it to the layer.

        Args:
            resource_name: Server-derived GeoServer feature type identity.
            style: Complete validated vector style state.

        Returns:
            Unqualified deterministic style name assigned to the layer.

        Raises:
            VectorPublicationError: If GeoServer cannot apply the style.
        """
        ...
