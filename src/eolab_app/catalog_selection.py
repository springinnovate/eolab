"""Path-free catalog selection values and the injected source authorization port."""

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from pydantic import ConfigDict, Field

from eolab_app.catalog.vector_contract import CatalogVectorRequest
from eolab_app.attribute_filter import VectorFilter


class CatalogSelection(CatalogVectorRequest):
    """Immutable source, native-layer and predicate identity, never coordinates.

    Asset and layer names are checked against the authoritative Catalog on every
    resolution. The signature is a digest of all mounted source components.
    """

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)
    filter: VectorFilter
    assetKey: str = Field(min_length=1, max_length=256)
    layerName: str = Field(min_length=1, max_length=256)
    sourceSignature: str = Field(pattern=r"^[0-9a-f]{64}$")

    def cache_identity(self) -> str:
        """Return a deterministic identity containing every selection input.

        Returns:
            Canonical JSON including source, native layer, and typed predicate.
        """
        return self.model_dump_json(by_alias=True)


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
    """Private, short-lived reading capability resolved from Catalog authority.

    Attributes:
        selection: Public immutable selection definition.
        path: Private exact mounted dataset path.
        driver: Allowed Fiona driver.
        components: Private files and their stat identities, checked around reads.
        where: Server-compiled conservative OGR predicate.
    """

    selection: CatalogSelection
    path: Path
    driver: str
    components: tuple[tuple[Path, tuple[int, ...]], ...]
    where: str | None

    def require_current(self) -> None:
        """Check every component without exposing paths on failure.

        Raises:
            SelectionUnavailableError: If a file disappeared or changed.
        """
        try:
            for path, expected in self.components:
                stat = path.stat()
                if (
                    stat.st_dev,
                    stat.st_ino,
                    stat.st_size,
                    stat.st_mtime_ns,
                    stat.st_ctime_ns,
                ) != expected:
                    raise SelectionUnavailableError(
                        "The catalog vector changed; select it again."
                    )
        except OSError as error:
            raise SelectionUnavailableError(
                "The catalog vector is no longer available."
            ) from error


class CatalogSelectionReader(Protocol):
    """Authorize immutable Catalog selections without rendering dependencies."""

    async def resolve_for_sampling(
        self, selection: CatalogSelection
    ) -> ResolvedCatalogSelection:
        """Resolve a descriptor to a private reading capability.

        Args:
            selection: Structurally validated public descriptor.

        Returns:
            Current source and server-compiled predicate.

        Raises:
            SelectionUnavailableError: If identity or source authorization fails.
        """
        ...
