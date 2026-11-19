"""Describe kilometer-sized WGS 84 boxes and approximate their geodesic edges."""

from collections.abc import Callable
import math
from typing import TypeAlias

from pydantic import BaseModel, ConfigDict, Field, model_validator

from eolab_app.projected_boundary import (
    BoundaryCoordinateLimitError,
    tessellate_projected_ring,
)

MEAN_EARTH_RADIUS_KM = 6371.0088
MAXIMUM_SAMPLING_BOX_SIDE_KM = math.floor(math.pi * MEAN_EARTH_RADIUS_KM / math.sqrt(2))
SAMPLING_BOX_BOUNDARY_ERROR = "Sampling box reaches a pole or crosses the date line"
GeographicPosition: TypeAlias = tuple[float, float]
ProjectedPosition: TypeAlias = tuple[float, ...]
BoxProjection: TypeAlias = Callable[
    [tuple[GeographicPosition, ...]], tuple[ProjectedPosition, ...]
]


class SamplingBoxCenter(BaseModel):
    """Locate the center of a sampling box in canonical WGS 84 degrees.

    Attributes:
        longitude: East-positive degrees from -180 through 180.
        latitude: North-positive degrees from -90 through 90.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    longitude: float = Field(strict=True, ge=-180, le=180, allow_inf_nan=False)
    latitude: float = Field(strict=True, ge=-90, le=90, allow_inf_nan=False)


class Wgs84SamplingBox(BaseModel):
    """Capture one nonwrapping kilometer-sized geodesic quadrilateral.

    Corners follow the established spherical construction: travel half the
    requested diagonal at bearings 315, 45, 135 and 225 degrees from the center,
    using the mean Earth radius 6371.0088 km. Adjacent corners are joined by
    their shorter great-circle arcs. The size is approximate on this sphere;
    it does not describe an exact square on an ellipsoid.

    Attributes:
        center: Canonical longitude/latitude center retained with the input.
        sideLengthKm: Integer side length from the browser's existing size range.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    center: SamplingBoxCenter
    sideLengthKm: int = Field(strict=True, ge=1, le=MAXIMUM_SAMPLING_BOX_SIDE_KM)

    @model_validator(mode="after")
    def require_nonwrapping_nonpolar_box(self) -> "Wgs84SamplingBox":
        """Reject the same polar and date-line crossings as the box producer.

        Returns:
            This validated, immutable descriptor.

        Raises:
            ValueError: If the box's enclosing spherical cap reaches a pole,
                or its corners cross the date line.
        """
        half_diagonal = self.sideLengthKm / math.sqrt(2) / MEAN_EARTH_RADIUS_KM
        if abs(math.radians(self.center.latitude)) + half_diagonal >= math.pi / 2:
            raise ValueError(SAMPLING_BOX_BOUNDARY_ERROR)
        longitudes = [point[0] for point in sampling_box_corners(self)]
        if max(longitudes) - min(longitudes) >= 180:
            raise ValueError(SAMPLING_BOX_BOUNDARY_ERROR)
        return self


def _destination(
    longitude: float, latitude: float, angular_distance: float, bearing: float
) -> GeographicPosition:
    """Travel along a spherical geodesic from one degree-valued position.

    Args:
        longitude: Starting longitude in degrees.
        latitude: Starting latitude in degrees.
        angular_distance: Travel distance divided by the mean Earth radius.
        bearing: Clockwise starting bearing from north in radians.

    Returns:
        Longitude and latitude in degrees, with longitude in [-180, 180).
    """
    latitude = math.radians(latitude)
    longitude = math.radians(longitude)
    destination_latitude = math.asin(
        math.sin(latitude) * math.cos(angular_distance)
        + math.cos(latitude) * math.sin(angular_distance) * math.cos(bearing)
    )
    offset = math.atan2(
        math.sin(bearing) * math.sin(angular_distance) * math.cos(latitude),
        math.cos(angular_distance)
        - math.sin(latitude) * math.sin(destination_latitude),
    )
    return (
        (math.degrees(longitude + offset) + 540) % 360 - 180,
        math.degrees(destination_latitude),
    )


def sampling_box_corners(box: Wgs84SamplingBox) -> tuple[GeographicPosition, ...]:
    """Return the established northwest, northeast, southeast and southwest corners.

    Args:
        box: Descriptor whose field ranges have been validated. The owning
            model validator also uses these corners to reject date-line crossings.

    Returns:
        Four longitude/latitude pairs on the existing mean-radius Earth model.
    """
    half_diagonal = box.sideLengthKm / math.sqrt(2) / MEAN_EARTH_RADIUS_KM
    return tuple(
        _destination(
            box.center.longitude,
            box.center.latitude,
            half_diagonal,
            math.radians(bearing),
        )
        for bearing in (315, 45, 135, 225)
    )


def interpolate_great_circle(
    start: GeographicPosition, end: GeographicPosition, fraction: float
) -> GeographicPosition:
    """Locate a fraction of the shorter great-circle arc between box corners.

    Args:
        start: Starting longitude/latitude pair from a validated box.
        end: Adjacent corner; the nonpolar box contract excludes antipodal arcs.
        fraction: Fraction from zero through one, supplied by edge subdivision.

    Returns:
        Longitude/latitude position, preserving the exact endpoints at zero/one.
    """
    if fraction == 0:
        return start
    if fraction == 1:
        return end
    latitude_a, latitude_b = math.radians(start[1]), math.radians(end[1])
    longitude_delta = math.radians(end[0] - start[0])
    cross_x = math.sin(longitude_delta) * math.cos(latitude_b)
    cross_y = math.cos(latitude_a) * math.sin(latitude_b) - math.sin(
        latitude_a
    ) * math.cos(latitude_b) * math.cos(longitude_delta)
    dot = math.sin(latitude_a) * math.sin(latitude_b) + math.cos(latitude_a) * math.cos(
        latitude_b
    ) * math.cos(longitude_delta)
    angular_distance = math.atan2(math.hypot(cross_x, cross_y), dot)
    return _destination(
        start[0], start[1], fraction * angular_distance, math.atan2(cross_x, cross_y)
    )


class SamplingBoxCoordinateLimitError(ValueError):
    """A box's projected boundary needs more coordinates than its caller permits."""

def tessellate_sampling_box(
    box: Wgs84SamplingBox,
    project_positions: BoxProjection,
    *,
    maximum_error_pixels: float = 0.25,
    maximum_coordinates: int | None = None,
) -> tuple[GeographicPosition, ...]:
    """Approximate box edges to the requested accuracy on a caller's pixel grid.

    Quarter, midpoint and three-quarter positions test each projected chord.
    Segments that miss the accuracy target are bisected until they converge.
    The projection callback receives batches and must measure actual display or
    raster pixel coordinates, including any rotation and anisotropic scale.
    A caller may concatenate scaled coordinate pairs for multiple accuracy grids;
    the combined Euclidean error bounds the error in every individual pair.
    Geometry is derived for this operation; only the center/size descriptor
    belongs in captured requests or persisted jobs.

    Args:
        box: Validated immutable descriptor.
        project_positions: Transform longitude/latitude batches to equally sized
            pixel-coordinate batches. Coordinate pairs for additional grids may be
            concatenated after scaling them to the same tolerance units.
            Transform failures propagate to the caller.
        maximum_error_pixels: Positive finite maximum tested chord deviation.
        maximum_coordinates: Caller-owned capacity for unique transformed
            positions, including accuracy probes. None permits unlimited work.

    Returns:
        Closed longitude/latitude ring approximating the four great-circle arcs.

    Raises:
        ValueError: If the tolerance is invalid, a projection is nonfinite, or
            floating-point subdivision cannot meet the requested accuracy.
        SamplingBoxCoordinateLimitError: If the caller's capacity is exceeded.
    """
    corners = sampling_box_corners(box)
    try:
        return tessellate_projected_ring(
            (*corners, corners[0]),
            project_positions,
            maximum_error_pixels=maximum_error_pixels,
            maximum_coordinates=maximum_coordinates,
            interpolate=interpolate_great_circle,
        )
    except BoundaryCoordinateLimitError as error:
        raise SamplingBoxCoordinateLimitError(
            "Sampling-box boundary exceeds the transformed-coordinate capacity"
        ) from error


def sampling_box_bounds(box: Wgs84SamplingBox) -> tuple[float, float, float, float]:
    """Return the complete nonwrapping envelope of the four geodesic edges.

    Opposite top/bottom corners share a latitude, so their arcs' latitude
    extrema lie at endpoints or midpoints. Side-arc latitude is monotonic under
    the existing enclosing-cap polar guard. Longitude is monotonic along every
    nonpolar shorter arc. Including all corners and edge midpoints therefore
    captures the supported quadrilateral's geographic extrema.

    Args:
        box: Validated nonwrapping, nonpolar descriptor.

    Returns:
        West, south, east and north in degrees. This envelope selects read
        windows; it must not replace the polygon as the membership geometry.
    """
    corners = sampling_box_corners(box)
    positions = corners + tuple(
        interpolate_great_circle(corners[edge], corners[(edge + 1) % 4], 0.5)
        for edge in range(4)
    )
    return (
        min(point[0] for point in positions),
        min(point[1] for point in positions),
        max(point[0] for point in positions),
        max(point[1] for point in positions),
    )
