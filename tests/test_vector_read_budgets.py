"""Vector source reads honor caller time budgets without relaxing other limits."""

from pathlib import Path
from typing import Any

import pytest
from shapely.geometry import box, mapping

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
    source: ResolvedCatalogSelection,
    monkeypatch: pytest.MonkeyPatch,
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
        ("MAX_SCANNED_FEATURES", 1, "1-feature budget"),
        ("MAX_FEATURE_COORDINATES", 4, "coordinate buffer"),
    ],
)
def test_longer_reads_preserve_feature_and_coordinate_limits(
    source: ResolvedCatalogSelection,
    monkeypatch: pytest.MonkeyPatch,
    setting: str,
    value: int,
    message: str,
) -> None:
    """Keep work ceilings independent of a caller's extended time allowance.

    Args:
        source: Original two-feature source.
        monkeypatch: Reduce one native-reader budget.
        setting: Budget constant to reduce for this fixture.
        value: Limit below the fixture's required work.
        message: Distinct diagnostic expected for the exhausted budget.
    """
    monkeypatch.setattr(f"eolab_app.bounded_vector.{setting}", value)
    with pytest.raises(GeometryValidationError, match=message):
        with polygon_records(source, (), timeout_seconds=600) as records:
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
