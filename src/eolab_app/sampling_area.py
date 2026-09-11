"""Reusable bounded sampling-area contracts for raster analysis."""

from dataclasses import dataclass
from typing import Literal, TypeAlias

from eolab_app.raster.models import CanonicalWgs84Bounds
from eolab_app.catalog_selection import ResolvedCatalogSelection

@dataclass(frozen=True)
class WholeRasterSamplingArea:
    """Select every source cell through the bounded whole-raster grid."""

    kind: Literal["wholeRaster"] = "wholeRaster"

    def cache_identity(self) -> tuple[str]:
        """Return the stable whole-raster cache identity.

        Returns:
            Single whole-raster discriminator.
        """
        return (self.kind,)


@dataclass(frozen=True)
class SelectedBoundsSamplingArea:
    """Select cells intersecting one canonical WGS 84 rectangle.

    Attributes:
        bounds: West, south, east, and north in longitude/latitude order.
        kind: Stable rectangular-area discriminator.
    """

    bounds: CanonicalWgs84Bounds
    kind: Literal["selectedArea"] = "selectedArea"

    def cache_identity(self) -> tuple[str, CanonicalWgs84Bounds]:
        """Return the stable rectangular cache identity.

        Returns:
            Scope discriminator and canonical rectangle.
        """
        return self.kind, self.bounds


@dataclass(frozen=True)
class CatalogSelectionSamplingArea:
    """Select exact polygons read from an immutable catalog descriptor.

    Attributes:
        resolved: Private source capability resolved by the Catalog authority.
        kind: Public selection discriminator.
    """

    resolved: ResolvedCatalogSelection
    kind: Literal["catalogSelection"] = "catalogSelection"

    def cache_identity(self) -> tuple[str, str]:
        """Return the full source, native-layer and predicate identity.

        Returns:
            Scope and deterministic descriptor JSON for cache/coalescing keys.
        """
        return self.kind, self.resolved.selection.cache_identity()


RasterSamplingArea: TypeAlias = (
    WholeRasterSamplingArea | SelectedBoundsSamplingArea | CatalogSelectionSamplingArea
)
