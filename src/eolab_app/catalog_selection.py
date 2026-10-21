"""Identify filtered vector features and authorize reads of their source files."""

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from eolab_app.catalog.vector_contract import CatalogVectorRequest
from eolab_app.attribute_filter import VectorFilter


class CatalogSelection(CatalogVectorRequest):
    """A catalog vector layer and attribute filter identifying features for analysis.

    Asset and layer names are checked against the authoritative Catalog on every
    resolution. Source files are immutable after admission.
    """

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)
    filter: VectorFilter
    assetKey: str = Field(min_length=1, max_length=256)
    layerName: str = Field(min_length=1, max_length=256)


class UploadedVectorFilterRequest(BaseModel):
    """Identify an uploaded polygon layer and the attribute filter to apply."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    uploadId: UUID
    filter: VectorFilter


class UploadedSelection(UploadedVectorFilterRequest):
    """Identify selected features in one browser-owned immutable GeoPackage.

    The server checks ownership separately from this public descriptor. The layer
    name must match the sole layer recorded when the upload was admitted.
    """

    layerName: str


VectorSelection = CatalogSelection | UploadedSelection
"""Path-free source identity and attribute filter for vector analysis."""


class SelectionUnavailableError(ValueError):
    """A vector selection no longer resolves to its authorized immutable source."""

    def __init__(self, detail: str) -> None:
        """Retain a path-free source failure for public error translation.

        Args:
            detail: User-safe failure explanation.
        """
        super().__init__(detail)
        self.detail = detail


@dataclass(frozen=True)
class ResolvedCatalogSelection:
    """An authorized immutable vector source and its feature filter.

    Attributes:
        selection: Public immutable selection definition.
        path: Private exact mounted dataset path.
        driver: Allowed Fiona driver.
        where: Server-compiled conservative OGR predicate.
    """

    selection: VectorSelection
    path: Path
    driver: str
    where: str | None


class CatalogSelectionReader(Protocol):
    """Authorize vector selections without rendering dependencies."""

    async def resolve_source(
        self, source: CatalogVectorRequest
    ) -> ResolvedCatalogSelection:
        """Authorize the current complete catalog layer without reading its features.

        Args:
            source: Catalog collection and item identifying the configured layer.

        Returns:
            Full-layer descriptor and authorized path.

        Raises:
            SelectionUnavailableError: If the source cannot be resolved or inspected.
        """
        ...

    async def resolve_for_sampling(
        self, selection: VectorSelection, upload_owner: str | None = None
    ) -> ResolvedCatalogSelection:
        """Find and authorize the source file and filter for a vector selection.

        Args:
            selection: Validated catalog or upload identity and feature filter.
            upload_owner: Server-derived browser identity for private uploads.

        Returns:
            Current source and server-compiled predicate.

        Raises:
            SelectionUnavailableError: If identity or source authorization fails.
            VectorUploadError: If the upload is unavailable to this browser.
        """
        ...
