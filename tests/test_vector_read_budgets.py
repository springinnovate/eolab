"""Vector source reads honor caller time budgets without relaxing other limits."""

from pathlib import Path
from typing import Any, NoReturn

import pytest
from shapely.geometry import Polygon, box, mapping

from catalog_selection_support import write_selection
from eolab_app.bounded_geometry import GeometryValidationError
from eolab_app.bounded_vector import polygon_records
from eolab_app.catalog_selection import ResolvedCatalogSelection
from eolab_app.raster.read_cancellation import RasterReadCancelled


@pytest.fixture
def source(tmp_path: Path) -> ResolvedCatalogSelection:
    """Authorize a real two-feature GeoPackage for source-reader budget checks.

    Args:
        tmp_path: Isolated native source directory.

    Returns:
        Original-source capability issued through the catalog selection boundary.
    """
    return write_selection(
        tmp_path / "watersheds.gpkg",
        [mapping(box(0, 0, 1, 1)), mapping(box(1, 0, 2, 1))],
    )


@pytest.mark.parametrize("timeout", [None, 10, 30])
def test_read_uses_default_or_supplied_time_budget(
    monkeypatch: pytest.MonkeyPatch,
    source: ResolvedCatalogSelection,
    timeout: int | None,
) -> None:
    """Allow a longer supervised read while retaining the ordinary 15-second default.

    Args:
        source: Original two-feature source.
        monkeypatch: Advance only the vector reader's clock, without sleeping.
        timeout: Explicit read allowance, or None to leave the argument omitted.
    """
    times = iter((0.0, 16.0, 20.0))
    monkeypatch.setattr("eolab_app.bounded_vector.monotonic", lambda: next(times))
    options = {} if timeout is None else {"timeout_seconds": timeout}
    with polygon_records(source, ("selected",), **options) as records:
        if timeout == 30:
            assert [properties["selected"] for _, properties in records] == [1, 1]
        else:
            with pytest.raises(
                GeometryValidationError,
                match=f"{15 if timeout is None else timeout}-second time budget after 0 features",
            ):
                list(records)


@pytest.mark.parametrize("timeout", [0, -1, float("inf"), float("nan"), True, "30"])
def test_read_rejects_invalid_time_budgets(
    source: ResolvedCatalogSelection, timeout: Any
) -> None:
    """Reject values that would disable or corrupt the native-reader deadline.

    Args:
        source: Authorized source that should not be opened with an invalid budget.
        timeout: Invalid value supplied at the reader boundary.
    """
    with pytest.raises(ValueError, match="positive finite number"):
        with polygon_records(source, (), timeout_seconds=timeout) as records:
            list(records)


@pytest.mark.parametrize(
    "setting,value,message",
    [
        ("max_features", 1, "1-feature budget"),
        ("max_feature_coordinates", 4, "coordinate buffer"),
    ],
)
def test_longer_reads_preserve_feature_and_coordinate_limits(
    source: ResolvedCatalogSelection,
    setting: str,
    value: int,
    message: str,
) -> None:
    """Keep work ceilings independent of a caller's extended time allowance.

    Args:
        source: Original two-feature source.
        setting: Reader budget to reduce for this fixture.
        value: Limit below the fixture's required work.
        message: Distinct diagnostic expected for the exhausted budget.
    """
    with pytest.raises(GeometryValidationError, match=message):
        with polygon_records(
            source, (), timeout_seconds=600, **{setting: value}
        ) as records:
            list(records)


def test_longer_reads_still_stop_on_cancellation(
    source: ResolvedCatalogSelection,
) -> None:
    """Honor cancellation before reading features even with an extended deadline.

    Args:
        source: Authorized two-feature source.
    """
    with pytest.raises(RasterReadCancelled):
        with polygon_records(
            source, (), cancellation_requested=lambda: True, timeout_seconds=600
        ) as records:
            list(records)


@pytest.mark.parametrize(
    "x,y,z,message",
    [
        (0, 0, float("inf"), "finite positions"),
        (0, 0, float("nan"), "finite positions"),
        (181, 0, 1, "canonical WGS 84 bounds"),
        (0, 91, 1, "canonical WGS 84 bounds"),
    ],
)
def test_native_polygon_validation_checks_z_and_canonical_bounds(
    tmp_path: Path, x: float, y: float, z: float, message: str
) -> None:
    """Reject invalid native ordinates without weakening the original-source contract.

    Args:
        tmp_path: Isolated native vector directory.
        x: Longitude for the source polygon's southwest vertex.
        y: Latitude for the source polygon's southwest vertex.
        z: Third ordinate, which must be finite even though analysis uses x/y.
        message: Source-validation diagnostic expected from the original reader.
    """
    geometry = Polygon(
        [(x, y, z), (x + 0.1, y, z), (x + 0.1, y + 0.1, z), (x, y + 0.1, z), (x, y, z)]
    )
    source = write_selection(tmp_path / "invalid.gpkg", [mapping(geometry)])
    with pytest.raises(GeometryValidationError, match=message):
        with polygon_records(source, (), max_feature_coordinates=None) as records:
            list(records)


def test_native_ring_validation_counts_holes_and_preserves_finite_z(
    tmp_path: Path,
) -> None:
    """Count all native rings while retaining legitimate finite three-dimensional data.

    Args:
        tmp_path: Isolated original GeoPackage.
    """
    geometry = Polygon(
        [(0, 0, 3), (2, 0, 3), (2, 2, 3), (0, 2, 3), (0, 0, 3)],
        [[(0.5, 0.5, 3), (1, 0.5, 3), (1, 1, 3), (0.5, 1, 3), (0.5, 0.5, 3)]],
    )
    source = write_selection(tmp_path / "rings.gpkg", [mapping(geometry)])
    with polygon_records(source, (), max_feature_coordinates=10) as records:
        result, _ = next(records)
        assert all(
            position[2] == 3 for ring in result["coordinates"] for position in ring
        )
    with pytest.raises(GeometryValidationError, match="coordinate buffer"):
        with polygon_records(source, (), max_feature_coordinates=9) as records:
            list(records)


def test_coordinate_ceiling_rejects_before_allocating_native_array(
    source: ResolvedCatalogSelection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Enforce an interactive coordinate budget before allocating a numeric ring copy.

    Args:
        source: Real original polygon containing more than four coordinates.
        monkeypatch: Detect an allocation that should be avoided by the budget.
    """

    def forbid_array(*args: Any, **kwargs: Any) -> NoReturn:
        """Fail if coordinate conversion happens before the oversized-ring rejection.

        Args:
            args: Numeric ring passed for conversion.
            kwargs: NumPy conversion options.

        Raises:
            AssertionError: An over-budget ring reached numeric-array allocation.
        """
        raise AssertionError("Coordinate ceiling must precede array allocation")

    monkeypatch.setattr("eolab_app.bounded_vector.np.asarray", forbid_array)
    with pytest.raises(GeometryValidationError, match="coordinate buffer"):
        with polygon_records(source, (), max_feature_coordinates=4) as records:
            list(records)
