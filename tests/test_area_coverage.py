"""Independent polygon-intersection references for numerical coverage masks."""

import numpy as np
import pytest
import shapely
from shapely.affinity import translate
from shapely.geometry import Polygon, box

from eolab_app.processing.area_coverage import AreaCoverage


def compiled(geometry: shapely.Geometry) -> AreaCoverage:
    """Compile valid unioned rings using the Processing mask input contract.

    Args:
        geometry: Test AOI, potentially multipart or containing holes.

    Returns:
        Oriented edge mask independent of the intersection reference below.
    """
    return AreaCoverage(
        np.asarray(ring.coords)
        for part in shapely.get_parts(shapely.orient_polygons(geometry))
        for ring in [part.exterior, *part.interiors]
    )


@pytest.mark.parametrize(
    "flip_x,flip_y", [(False, False), (True, False), (False, True), (True, True)]
)
@pytest.mark.parametrize("offset", [(0, 0), (-10_000_000, 5_000_000)])
def test_fractional_mask_matches_independent_cell_intersections(
    flip_x: bool, flip_y: bool, offset: tuple[float, float]
) -> None:
    """Unequal row spacing, slivers, holes and multipart regions retain coverage.

    Args:
        flip_x: Reverse native column order.
        flip_y: Reverse native row order.
        offset: Equal-area world offset to expose numerical cancellation.
    """
    polygon = Polygon(
        [(0.1, 0.2), (6.8, 0.1), (5.7, 5.8), (3.1, 3.2), (0.2, 5.9)],
        [[(1.1, 1.2), (2.9, 1.3), (1.7, 2.8)]],
    )
    geometry = shapely.union_all([polygon, box(7.999, 0.1, 8.001, 4.9)])
    geometry = translate(geometry, *offset)
    xs = np.array([-1, 0, 0.3, 1, 2, 3, 4, 5, 6, 7, 8, 9], dtype=float) + offset[0]
    ys = np.array([-1, 0, 0.4, 0.8, 1.5, 2.7, 4, 4.8, 5, 6, 7], dtype=float) + offset[1]
    xs, ys = xs[::-1] if flip_x else xs, ys[::-1] if flip_y else ys
    expected = np.empty((len(ys) - 1, len(xs) - 1))
    for row, (y0, y1) in enumerate(zip(ys[:-1], ys[1:], strict=True)):
        for column, (x0, x1) in enumerate(zip(xs[:-1], xs[1:], strict=True)):
            cell = box(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
            expected[row, column] = geometry.intersection(cell).area / cell.area
    mask = compiled(geometry)
    np.testing.assert_allclose(mask.mask(xs, ys), expected, rtol=1e-7, atol=2e-8)
    np.testing.assert_array_equal(mask.mask(xs, ys) > 0, expected > 0)
    tiled = np.zeros_like(expected)
    for row in range(0, len(ys) - 1, 3):
        for column in range(0, len(xs) - 1, 4):
            tile = mask.mask(xs[column : column + 5], ys[row : row + 4])
            tiled[row : row + tile.shape[0], column : column + tile.shape[1]] = tile
    np.testing.assert_allclose(tiled, expected, rtol=1e-7, atol=2e-8)
    np.testing.assert_allclose(tiled, mask.mask(xs, ys), rtol=1e-9, atol=1e-12)


def test_mask_excludes_holes_and_preserves_thin_boundary_slivers() -> None:
    """Whole, empty and tiny fractional coverage do not require pixel polygons."""
    geometry = Polygon(
        box(0, 0, 10, 10).exterior.coords, [box(2, 2, 8, 8).exterior.coords]
    )
    mask = compiled(geometry)
    np.testing.assert_array_equal(mask.mask(np.arange(3, 7), np.arange(3, 7)), 0)
    np.testing.assert_array_equal(mask.mask(np.arange(-4, 0), np.arange(-4, 0)), 0)
    np.testing.assert_array_equal(
        mask.mask(np.array([0, 1, 2]), np.array([0, 1, 2])), 1
    )
    thin = compiled(box(0.999999, 0, 1, 1)).mask(np.array([0, 1]), np.array([0, 1]))
    assert thin[0, 0] == pytest.approx(0.000001, rel=1e-9)
    strip = compiled(box(-1000, 0.01, 1000, 0.02)).mask(np.arange(5), np.array([0, 1]))
    np.testing.assert_allclose(strip, 0.01, rtol=1e-12)


def test_varied_concave_rings_match_fractional_intersection_reference() -> None:
    """Deterministic varied edge slopes and holes match independent GEOS masks."""
    rng = np.random.default_rng(713)
    xs = np.linspace(-2, 2, 19)
    ys = np.linspace(-1.8, 1.8, 17)
    for _ in range(12):
        angles = np.linspace(0, 2 * np.pi, 24, endpoint=False)
        radii = rng.uniform(0.7, 1.7, len(angles))
        vertices = np.column_stack((np.cos(angles) * radii, np.sin(angles) * radii))
        geometry = Polygon(vertices, [box(-0.23, -0.31, 0.28, 0.19).exterior.coords])
        expected = np.array(
            [
                [
                    geometry.intersection(box(x0, y0, x1, y1)).area
                    / ((x1 - x0) * (y1 - y0))
                    for x0, x1 in zip(xs[:-1], xs[1:], strict=True)
                ]
                for y0, y1 in zip(ys[:-1], ys[1:], strict=True)
            ]
        )
        actual = compiled(geometry).mask(xs, ys)
        np.testing.assert_allclose(actual, expected, rtol=1e-9, atol=1e-12)
        np.testing.assert_array_equal(actual > 0, expected > 0)
