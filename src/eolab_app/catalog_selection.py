"""Identify filtered vector features and authorize reads of their source files."""

from dataclasses import dataclass, field
from pathlib import Path
from contextlib import AbstractAsyncContextManager
from typing import Any, Mapping, Protocol

from eolab_app.catalog.vector_contract import CatalogVectorRequest
from eolab_app.calculated_fields import CompiledCalculatedField
from eolab_app.attribute_filter import matches_filter
from eolab_app.feature_predicate import (
    ArtifactVectorSelection as ArtifactVectorSelection, CatalogSelection as CatalogSelection,
    UploadedSelection as UploadedSelection, UploadedVectorFilterRequest as UploadedVectorFilterRequest,
    VectorSelection as VectorSelection, VectorSourceOwners,
)


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
        intersections: Original target IDs that meet each authorized spatial condition.
            Bound only for this read, never serialized with the source descriptor.
        upload_owner: Server-only ownership credential for a worker reading an authorized upload.
        read_lease: Server-only lease held while a worker reads a private result file.
    """

    selection: VectorSelection
    path: Path
    driver: str
    where: str | None
    calculated_fields: tuple[CompiledCalculatedField, ...] = ()
    intersections: dict[str, frozenset[int]] = field(default_factory=dict)
    upload_owner: str | None = field(default=None, repr=False, compare=False)
    read_lease: str | None = field(default=None, repr=False, compare=False)

    def matches_feature(self, feature_id: str | int, properties: Mapping[str, Any]) -> bool:
        """Test one original feature against the captured field and spatial conditions.

        Args:
            feature_id: Native Fiona feature ID from this dataset.
            properties: Original attributes with this view's calculated fields.

        Returns:
            Whether the entire original feature belongs to this selection.

        Raises:
            AttributeFilterError: If a required polygon source has not been bound.
        """
        matches = {key: int(feature_id) in ids for key, ids in self.intersections.items()}
        return matches_filter(self.selection.filter, properties, matches)


class CatalogSelectionReader(Protocol):
    """Authorize vector selections without rendering dependencies."""

    def open_selection(
        self, selection: VectorSelection, source_owner: str | VectorSourceOwners | None = None
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

    async def resolve_original_selection(
        self, selection: CatalogSelection | UploadedSelection, source_owner: str | None = None,
    ) -> ResolvedCatalogSelection:
        """Authorize the original file and fields before a job opens its retained polygon sources.

        Args:
            selection: Original vector identity, calculated fields and predicate.
            source_owner: Browser upload identity, when required at admission.

        Returns:
            Validated source metadata with spatial conditions awaiting their separate reads.

        Raises:
            SelectionUnavailableError: If the source or its fields changed.
        """
        ...

    async def resolve_for_sampling(
        self, selection: VectorSelection, source_owner: str | VectorSourceOwners | None = None
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
