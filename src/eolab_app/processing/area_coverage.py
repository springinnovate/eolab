"""Fractional masks on a rectilinear equal-area grid without pixel polygons.

For each row strip, Green's theorem gives the area to the left of x as the
oriented boundary integral of clamp(edge_x, row_left, x) dy. Differencing that
integral at column boundaries gives cell coverage, including holes and slivers.
Only the AOI's oriented edges are retained; processing block size is immaterial.
"""

from collections.abc import Iterable

import numpy as np


class AreaCoverage:
    """Rasterize oriented AOI rings onto slices of a cached equal-area grid."""

    def __init__(self, rings: Iterable[np.ndarray]) -> None:
        """Compile the already validated, bounded AOI once for a calculation.

        Args:
            rings: Closed equal-area coordinate rings, with counterclockwise
                exteriors and clockwise holes, from a unioned valid polygon.
        """
        segments = np.concatenate(
            [np.column_stack((ring[:-1, :2], ring[1:, :2])) for ring in rings]
        )
        self.edges = segments

    def mask(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        """Return fractional coverage using only row/column boundaries and edges.

        Args:
            xs: Monotone equal-area column edges for a bounded processing tile.
            ys: Monotone equal-area row edges for the same tile. Either axis
                may increase or decrease; output follows its original order.

        Returns:
            Float64 coverage fractions with shape (len(ys)-1, len(xs)-1).
            Fractions preserve partial coverage and exclude unioned AOI holes.
        """
        reverse_x = xs[-1] < xs[0]
        ascending_x = xs[::-1] if reverse_x else xs
        origin = ascending_x[0]
        stops = (ascending_x - origin)[None, :]
        south, north = np.minimum(ys[:-1], ys[1:]), np.maximum(ys[:-1], ys[1:])
        cumulative = np.zeros((len(south), len(xs)), dtype=np.float64)
        winding = np.zeros((len(south), len(xs) - 1), dtype=np.int32)
        boundary = np.zeros_like(winding, dtype=bool)
        column_centers = (stops[:, :-1] + stops[:, 1:]) / 2
        row_centers = (south + north) / 2
        # Horizontal edges contribute zero area but identify subpixel strips.
        # Edges wholly left of the tile contribute neither area nor winding.
        edges = self.edges[
            (np.maximum(self.edges[:, 1], self.edges[:, 3]) > south.min())
            & (np.minimum(self.edges[:, 1], self.edges[:, 3]) < north.max())
            & (np.maximum(self.edges[:, 0], self.edges[:, 2]) > origin)
        ]
        for x0, y0, x1, y1 in edges:
            if y0 == y1:
                rows = np.flatnonzero((south < y0) & (north > y0))
                boundary[rows] |= (max(x0, x1) - origin > stops[:, :-1]) & (
                    min(x0, x1) - origin < stops[:, 1:]
                )
                continue
            bottom = np.maximum(south, min(y0, y1))
            top = np.minimum(north, max(y0, y1))
            rows = np.flatnonzero(top > bottom)
            if not len(rows):
                continue
            slope = (x1 - x0) / (y1 - y0)
            start = x0 - origin + (bottom[rows] - y0) * slope
            end = x0 - origin + (top[rows] - y0) * slope
            low = np.minimum(start, end)[:, None]
            high = np.maximum(start, end)[:, None]
            boundary[rows] |= (high > stops[:, :-1]) & (low < stops[:, 1:])
            center_rows = np.flatnonzero(
                (row_centers >= min(y0, y1)) & (row_centers < max(y0, y1))
            )
            crossing = x0 - origin + (row_centers[center_rows] - y0) * slope
            winding[center_rows] += int(np.sign(y1 - y0)) * (
                crossing[:, None] > column_centers
            )
            # Integrate a clamped linear function using its ramp and constant
            # portions. This avoids subtracting squares of large world offsets.
            ramp_start = np.maximum(low, 0)
            ramp_end = np.minimum(high, stops)
            ramp_length = np.maximum(ramp_end - ramp_start, 0)
            constant_length = np.maximum(high - np.maximum(low, stops), 0)
            integral = (
                ramp_start + ramp_end
            ) * 0.5 * ramp_length + stops * constant_length
            average = np.clip(low, 0, stops)
            np.divide(integral, high - low, out=average, where=high != low)
            signed_height = (top[rows] - bottom[rows]) * np.sign(y1 - y0)
            cumulative[rows] += average * signed_height[:, None]
        full_area = (north - south)[:, None] * np.diff(ascending_x)[None, :]
        coverage = np.clip(np.diff(cumulative, axis=1) / full_area, 0, 1)
        # Analytic membership suppresses cancellation noise in empty cells and
        # holes without rounding away genuinely thin positive-area slivers.
        coverage[(winding == 0) & ~boundary] = 0
        return coverage[:, ::-1] if reverse_x else coverage
