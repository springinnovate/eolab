"""Identify filtered vector features and authorize reads of their source files."""

from dataclasses import dataclass
from pathlib import Path
from contextlib import AbstractAsyncContextManager
from typing import Literal, Protocol
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from eolab_app.catalog.vector_contract import CatalogVectorRequest
from eolab_app.attribute_filter import VectorFilter
from eolab_app.calculated_fields import CalculatedField, CompiledCalculatedField

class CatalogSelection(CatalogVectorRequest):
    """A catalog vector layer and attribute filter identifying features for analysis.

    Asset and layer names are checked against the authoritative Catalog on every
    resolution. Source files are immutable after admission. Ordered calculated_fields
    travel with the view and filter; readers evaluate them from original attributes.
    """

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)
    filter: VectorFilter
    assetKey: str = Field(min_length=1, max_length=256)
    layerName: str = Field(min_length=1, max_length=256)
    calculated_fields: tuple[CalculatedField, ...] = Field(
        default=(), alias="calculatedFields", exclude_if=lambda value: not value
    )


class UploadedVectorFilterRequest(BaseModel):
    """Identify an upload, its view-owned calculated fields and feature predicate."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)
    uploadId: UUID
    filter: VectorFilter
    calculated_fields: tuple[CalculatedField, ...] = Field(
        default=(), alias="calculatedFields", exclude_if=lambda value: not value
    )


class UploadedSelection(UploadedVectorFilterRequest):
    """Identify selected features in one browser-owned immutable GeoPackage.

    The server checks ownership separately from this public descriptor. The layer
    name must match the sole layer recorded when the upload was admitted.
    """

    layerName: str


class ArtifactVectorSelection(BaseModel):
    """Select original features from a private immutable Processing result.

    Attributes:
        kind: The literal string "runArtifact" identifies its source lifetime.
        jobId: Opaque owning run ID, authorized by the Processing source boundary.
        artifactId: Opaque published file ID within the run.
        layerName: Original native GeoPackage layer, checked when the file opens.
        filter: Accepted attribute predicate, including calculated attributes.
        calculated_fields: Ordered view-owned definitions captured with the predicate.
    """

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)
    kind: Literal["runArtifact"]
    jobId: str = Field(pattern=r"^[a-f0-9]{32}$")
    artifactId: str = Field(pattern=r"^[a-f0-9]{32}$")
    layerName: str = Field(min_length=1, max_length=256)
    filter: VectorFilter
    calculated_fields: tuple[CalculatedField, ...] = Field(
        default=(), alias="calculatedFields", exclude_if=lambda value: not value
    )


VectorSelection = CatalogSelection | UploadedSelection | ArtifactVectorSelection
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
        calculated_fields: Programs validated against the original source schema.
    """

    selection: VectorSelection
    path: Path
    driver: str
    where: str | None
    calculated_fields: tuple[CompiledCalculatedField, ...] = ()


class CatalogSelectionReader(Protocol):
    """Authorize vector selections without rendering dependencies."""

    def open_selection(
        self, selection: VectorSelection, source_owner: str | None = None
    ) -> AbstractAsyncContextManager[ResolvedCatalogSelection]:
        """Keep an authorized selection's original file available for its complete read.

        Args:
            selection: Original source identity, predicate and calculated definitions.
            source_owner: Browser identity appropriate to a private upload or result.

        Returns:
            Access scope yielding the resolved source until the caller stops reading.

        Raises:
            SelectionUnavailableError: If the source, ownership or lifetime is invalid.
        """
        ...

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
        self, selection: VectorSelection, source_owner: str | None = None
    ) -> ResolvedCatalogSelection:
        """Find and authorize the source file and filter for a vector selection.

        Use open_selection() for private result reads that must retain the file
        after metadata resolution finishes.

        Args:
            selection: Validated original source identity and feature filter.
            source_owner: Server-derived upload or Processing source owner.

        Returns:
            Current source and server-compiled predicate.

        Raises:
            SelectionUnavailableError: If identity or source authorization fails.
            VectorUploadError: If the upload is unavailable to this browser.
        """
        ...
