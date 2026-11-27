"""Refine polygon boundary segments to an accuracy in a caller's target grid."""

from collections.abc import Callable
import math
from typing import TypeAlias

Position: TypeAlias = tuple[float, float]
ProjectedPosition: TypeAlias = tuple[float, ...]
ProjectPositions: TypeAlias = Callable[
    [tuple[Position, ...]], tuple[ProjectedPosition, ...]
]
InterpolatePosition: TypeAlias = Callable[[Position, Position, float], Position]


class BoundaryCoordinateLimitError(ValueError):
    """The projected boundary needs more coordinates than the caller permits."""


class BoundaryConvergenceError(ValueError):
    """Floating-point subdivision cannot meet the boundary accuracy."""


def _interpolate_segment(start: Position, end: Position, fraction: float) -> Position:
    """Locate a fraction of a straight edge in its original coordinate system."""
    if fraction == 0:
        return start
    if fraction == 1:
        return end
    return (
        start[0] + (end[0] - start[0]) * fraction,
        start[1] + (end[1] - start[1]) * fraction,
    )


def _distance_to_segment(
    point: ProjectedPosition, start: ProjectedPosition, end: ProjectedPosition
) -> float:
    """Return the distance from a projected point to the finite chord."""
    delta = tuple(b - a for a, b in zip(start, end, strict=True))
    offset = tuple(p - a for p, a in zip(point, start, strict=True))
    squared_length = sum(value * value for value in delta)
    fraction = (
        min(
            1.0,
            max(
                0.0,
                sum(a * b for a, b in zip(offset, delta, strict=True)) / squared_length,
            ),
        )
        if squared_length
        else 0.0
    )
    return math.hypot(*(a - fraction * b for a, b in zip(offset, delta, strict=True)))


def tessellate_projected_ring(
    ring: tuple[Position, ...],
    project_positions: ProjectPositions,
    *,
    maximum_error_pixels: float,
    maximum_coordinates: int | None = None,
    interpolate: InterpolatePosition = _interpolate_segment,
    check_continuity: bool = False,
) -> tuple[Position, ...]:
    """Add source positions until the projected ring meets the chord tolerance.

    Test each chord at quarter, midpoint and three-quarter positions. Project
    probes in batches, then bisect segments that exceed the pixel tolerance.
    Retain the accepted probes so a later longitude-wrapping transform can
    distinguish a long continuous edge from a short crossing of its seam.

    Args:
        ring: Closed ring in its original coordinate system.
        project_positions: Batch projection to target pixel coordinates or to
            coordinate pairs for several grids scaled to the same tolerance.
        maximum_error_pixels: Positive finite tolerance in target pixels.
        maximum_coordinates: Capacity for unique source positions, including
            probes, or None for caller-supervised unlimited work.
        interpolate: Locate a position on an original edge by fraction.
        check_continuity: Compare probes with the same fractional positions on
            the target chord. Use when the target must be continuous; a jump
            along a straight line can otherwise pass the chord-distance test.

    Returns:
        Closed ring in the source CRS including the accepted interior probes.

    Raises:
        BoundaryCoordinateLimitError: If accuracy needs more coordinates than allowed.
        BoundaryConvergenceError: If subdivision does not converge.
        ValueError: If projection is nonfinite or the tolerance is invalid.
    """
    if not math.isfinite(maximum_error_pixels) or maximum_error_pixels <= 0:
        raise ValueError("Boundary accuracy must be a positive finite pixel value")
    projected: dict[Position, ProjectedPosition] = {}

    def project_missing(positions: tuple[Position, ...]) -> None:
        """Project the unseen positions in this round under the coordinate budget."""
        missing = tuple(
            dict.fromkeys(point for point in positions if point not in projected)
        )
        if not missing:
            return
        if (
            maximum_coordinates is not None
            and len(projected) + len(missing) > maximum_coordinates
        ):
            raise BoundaryCoordinateLimitError(
                "Boundary exceeds the transformed-coordinate capacity"
            )
        for source, pixel in zip(missing, project_positions(missing), strict=True):
            if not all(math.isfinite(value) for value in pixel):
                raise ValueError("Boundary could not be projected")
            projected[source] = pixel

    pending = [(edge, 0.0, 1.0) for edge in range(len(ring) - 1)]
    accepted: list[tuple[int, float, Position]] = []
    while pending:
        probes = [
            tuple(
                interpolate(
                    ring[edge], ring[edge + 1], start + (stop - start) * fraction
                )
                for fraction in (0.0, 0.25, 0.5, 0.75, 1.0)
            )
            for edge, start, stop in pending
        ]
        project_missing(tuple(point for segment in probes for point in segment))
        next_pending = []
        for (edge, start, stop), positions in zip(pending, probes, strict=True):
            first, last = projected[positions[0]], projected[positions[-1]]
            error = max(
                (
                    math.dist(
                        projected[point],
                        tuple(
                            a + (b - a) * step / 4
                            for a, b in zip(first, last, strict=True)
                        ),
                    )
                    if check_continuity
                    else _distance_to_segment(projected[point], first, last)
                )
                for step, point in enumerate(positions[1:-1], start=1)
            )
            if error <= maximum_error_pixels:
                accepted.extend(
                    (edge, start + (stop - start) * step / 4, position)
                    for step, position in enumerate(positions[1:], start=1)
                )
                continue
            middle = (start + stop) / 2
            if middle == start or middle == stop:
                raise BoundaryConvergenceError("Boundary accuracy did not converge")
            next_pending.extend(((edge, start, middle), (edge, middle, stop)))
        pending = next_pending
    return (ring[0], *(point for _, _, point in sorted(accepted)))
