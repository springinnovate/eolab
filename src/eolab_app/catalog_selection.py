"""Identify filtered catalog features and authorize reads of their source files."""

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from pydantic import ConfigDict, Field

from eolab_app.catalog.vector_contract import CatalogVectorRequest
from eolab_app.attribute_filter import VectorFilter


class CatalogSelection(CatalogVectorRequest):
    """A catalog vector layer and attribute filter identifying features for analysis.

    Asset and layer names are checked against the authoritative Catalog on every
    resolution. Supplied legacy fingerprints survive serialization for existing
    idempotent requests, but do not identify or authorize the immutable selection.
    """

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)
    filter: VectorFilter
    assetKey: str = Field(min_length=1, max_length=256)
    layerName: str = Field(min_length=1, max_length=256)
    sourceSignature: str | None = Field(
        default=None, pattern=r"^[0-9a-f]{64}$", exclude_if=lambda value: value is None
    )

    def cache_identity(self) -> str:
        """Return the Catalog binding and predicate, without legacy fingerprints.

        Returns:
            Canonical JSON including source, native layer, and typed predicate.
        """
        return self.model_dump_json(by_alias=True, exclude={"sourceSignature"})


class SelectionUnavailableError(ValueError):
    """A catalog selection no longer resolves to its authorized immutable source."""

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

    selection: CatalogSelection
    path: Path
    driver: str
    where: str | None


class CatalogSelectionReader(Protocol):
    """Authorize immutable Catalog selections without rendering dependencies."""

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
        self, selection: CatalogSelection
    ) -> ResolvedCatalogSelection:
        """Find and authorize the source files and filter for a catalog selection.

        Args:
            selection: Validated catalog identity and feature filter.

        Returns:
            Current source and server-compiled predicate.

        Raises:
            SelectionUnavailableError: If identity or source authorization fails.
        """
        ...
