"""Reusable bounded sampling-area contracts for raster analysis."""

from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Protocol, TypeAlias

from eolab_app.raster.models import CanonicalWgs84Bounds


ImmutableCoordinates: TypeAlias = tuple[object, ...]


class SamplingAreaUnavailableError(ValueError):
    """Describe why an opaque sampling area cannot currently be resolved.

    Attributes:
        detail: Actionable browser-safe explanation of the lifecycle failure.
    """

    def __init__(self, detail: str) -> None:
        """Create a stable sampling-area lifecycle failure.

        Args:
            detail: Actionable browser-safe failure explanation.
        """
        super().__init__(detail)
        self.detail = detail


@dataclass(frozen=True)
class PolygonalWgs84Geometry:
    """One immutable Polygon or MultiPolygon in longitude/latitude order.

    Attributes:
        geometry_type: Exact GeoJSON polygonal geometry discriminator.
        coordinates: Deeply immutable finite WGS 84 coordinate structure.
    """

    geometry_type: Literal["Polygon", "MultiPolygon"]
    coordinates: ImmutableCoordinates

    def as_geojson(self) -> dict[str, object]:
        """Return a fresh mutable GeoJSON mapping for geometry consumers.

        Returns:
            Polygonal GeoJSON mapping whose coordinates cannot mutate this
            lifecycle-owned value object.
        """
        return {
            "type": self.geometry_type,
            "coordinates": _thaw_coordinates(self.coordinates),
        }


@dataclass(frozen=True)
class TemporaryAoiLifecycleIdentity:
    """Immutable identity of one ready temporary-AOI lifecycle.

    Attributes:
        reference: Opaque process-local identifier supplied by the browser.
        expires_at: Fixed UTC expiration timestamp assigned at upload.
    """

    reference: str
    expires_at: datetime

    def cache_identity(self) -> tuple[str, str]:
        """Return the stable cache and stale-response identity.

        Returns:
            Opaque reference and canonical expiration timestamp.
        """
        return self.reference, self.expires_at.isoformat()


@dataclass(frozen=True)
class ResolvedTemporaryAoi:
    """Bounded immutable AOI geometry returned by the narrow read port.

    Attributes:
        identity: Current ready lifecycle identity.
        bounds: Canonical WGS 84 polygon envelope.
        geometries: Polygonal components used for union masking.
    """

    identity: TemporaryAoiLifecycleIdentity
    bounds: CanonicalWgs84Bounds
    geometries: tuple[PolygonalWgs84Geometry, ...]


class TemporaryAoiSamplingAreaReader(Protocol):
    """Resolve opaque temporary-AOI references for bounded raster analysis."""

    async def resolve_for_sampling(
        self,
        temporary_aoi_id: str,
    ) -> ResolvedTemporaryAoi:
        """Resolve one active ready AOI without exposing storage metadata.

        Args:
            temporary_aoi_id: Untrusted opaque browser reference.

        Returns:
            Immutable bounded WGS 84 polygonal geometry and lifecycle identity.

        Raises:
            SamplingAreaUnavailableError: If the AOI is absent, expired,
                pending selection, removed, or has no polygonal area.
        """
        ...


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
class TemporaryAoiSamplingArea:
    """Select cells intersecting one resolved temporary AOI.

    Attributes:
        resolved_aoi: Immutable geometry and lifecycle identity.
        kind: Stable temporary-AOI discriminator.
    """

    resolved_aoi: ResolvedTemporaryAoi
    kind: Literal["temporaryAoi"] = "temporaryAoi"

    def cache_identity(self) -> tuple[str, str, str]:
        """Return the stable temporary-AOI cache identity.

        Returns:
            Scope, opaque reference, and lifecycle expiration timestamp.
        """
        reference, expires_at = self.resolved_aoi.identity.cache_identity()
        return self.kind, reference, expires_at


RasterSamplingArea: TypeAlias = (
    WholeRasterSamplingArea
    | SelectedBoundsSamplingArea
    | TemporaryAoiSamplingArea
)


def freeze_coordinates(value: object) -> ImmutableCoordinates:
    """Convert a validated GeoJSON coordinate tree to immutable tuples.

    Args:
        value: Nested GeoJSON coordinate arrays already validated as finite.

    Returns:
        Deeply immutable coordinate structure.

    Raises:
        TypeError: If the coordinate tree contains an unexpected scalar.
    """
    if not isinstance(value, (list, tuple)):
        raise TypeError("Polygonal coordinates must be nested arrays")
    frozen: list[object] = []
    for child in value:
        if isinstance(child, (list, tuple)):
            frozen.append(freeze_coordinates(child))
        elif isinstance(child, (int, float)) and not isinstance(child, bool):
            frozen.append(float(child))
        else:
            raise TypeError("Polygonal coordinates contain an invalid ordinate")
    return tuple(frozen)


def polygonal_geometries_from_feature_collection(
    feature_collection: dict[str, object],
) -> tuple[PolygonalWgs84Geometry, ...]:
    """Extract all Polygon and MultiPolygon components from ready AOI data.

    Polygonal children of GeometryCollections contribute independently.
    Points and lines are deliberately ignored so a mixed dataset remains
    usable when it contains area.

    Args:
        feature_collection: Validated bounded WGS 84 FeatureCollection.

    Returns:
        Immutable polygonal components in source feature order.

    Raises:
        TypeError: If the previously validated collection is malformed.
    """
    features = feature_collection.get("features")
    if not isinstance(features, list):
        raise TypeError("Temporary AOI FeatureCollection is malformed")
    geometries: list[PolygonalWgs84Geometry] = []
    for feature in features:
        if not isinstance(feature, dict):
            raise TypeError("Temporary AOI feature is malformed")
        geometry = feature.get("geometry")
        if not isinstance(geometry, dict):
            raise TypeError("Temporary AOI feature geometry is malformed")
        _append_polygonal_geometries(geometry, geometries)
    return tuple(geometries)


def _append_polygonal_geometries(
    geometry: dict[str, object],
    destination: list[PolygonalWgs84Geometry],
) -> None:
    """Append polygonal members of one validated GeoJSON geometry.

    Args:
        geometry: Validated GeoJSON geometry mapping.
        destination: Mutable extraction result owned by the caller.

    Returns:
        None.

    Raises:
        TypeError: If polygonal or collection members are malformed.
    """
    geometry_type = geometry.get("type")
    if geometry_type in {"Polygon", "MultiPolygon"}:
        coordinates = freeze_coordinates(geometry.get("coordinates"))
        destination.append(PolygonalWgs84Geometry(geometry_type, coordinates))
        return
    if geometry_type != "GeometryCollection":
        return
    children = geometry.get("geometries")
    if not isinstance(children, list):
        raise TypeError("Temporary AOI GeometryCollection is malformed")
    for child in children:
        if not isinstance(child, dict):
            raise TypeError("Temporary AOI collection member is malformed")
        _append_polygonal_geometries(child, destination)


def _thaw_coordinates(value: ImmutableCoordinates) -> list[object]:
    """Copy immutable coordinate tuples into GeoJSON-compatible lists.

    Args:
        value: Deeply immutable coordinate structure.

    Returns:
        Fresh nested lists and numeric ordinates.
    """
    return [
        _thaw_coordinates(child) if isinstance(child, tuple) else child
        for child in value
    ]
