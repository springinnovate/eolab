"""Verify native category membership and bounded selected ground-area estimates."""

from pathlib import Path

import numpy
import pytest
import rasterio
from numpy.typing import NDArray
from pydantic import ValidationError
from rasterio.enums import Resampling
from rasterio.transform import Affine, from_origin

from catalog_selection_support import write_selection
from eolab_app.raster.categorical_statistics import read_raster_categorical_statistics
from eolab_app.raster.models import CatalogRasterStatisticsRequest
from eolab_app.raster.read_cancellation import RasterReadCancelled
from eolab_app.sampling_area import (
    CatalogSelectionSamplingArea,
    SelectedBoundsSamplingArea,
    WholeRasterSamplingArea,
)


def write_categories(
    path: Path,
    values: NDArray[numpy.float32],
    transform: Affine,
    crs: str = "EPSG:4326",
) -> Path:
    """Write native band-one codes with an explicit NoData value.

    Args:
        path: New fixture GeoTIFF path.
        values: Native numeric category grid.
        transform: Source cell affine transform.
        crs: Georeferencing authority.

    Returns:
        Created source path.
    """
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=values.shape[0],
        width=values.shape[1],
        count=1,
        dtype="float32",
        crs=crs,
        transform=transform,
        nodata=-9999,
        tiled=True,
        blockxsize=16,
        blockysize=16,
    ) as dataset:
        dataset.write(values, 1)
    return path


def test_geographic_categories_weight_latitude_and_separate_nodata(
    tmp_path: Path,
) -> None:
    """Equal sample counts have unequal ground area; fractional values stay Unmapped."""
    values = numpy.array([[1, 1, -9999], [2, 2.5, numpy.nan]], dtype=numpy.float32)
    path = write_categories(
        tmp_path / "latitude.tif", values, from_origin(0, 61, 1, 30)
    )
    result = read_raster_categorical_statistics(
        path, WholeRasterSamplingArea(), category_values=(1, 2)
    )
    distribution = result.categorical_distribution
    assert distribution is not None
    assert result.valid_sample_count == 4
    # The high-latitude category has twice as many samples but less than twice the ground area.
    assert 1 < distribution.areas_hectares[0] / distribution.areas_hectares[1] < 1.6
    assert distribution.unmapped_area_hectares == pytest.approx(
        distribution.areas_hectares[1]
    )
    assert distribution.nodata_area_hectares > 0
    assert distribution.valid_area_hectares == pytest.approx(
        sum(distribution.areas_hectares) + distribution.unmapped_area_hectares
    )
    assert distribution.area_estimated is True


def test_equal_area_rotated_raster_uses_affine_ground_footprint(tmp_path: Path) -> None:
    """Rotation and skew retain the determinant's ground area."""
    path = write_categories(
        tmp_path / "rotated.tif",
        numpy.ones((2, 2), dtype=numpy.float32),
        Affine(100, 25, 0, 30, -100, 1000),
        "EPSG:6933",
    )
    result = read_raster_categorical_statistics(
        path, WholeRasterSamplingArea(), category_values=(1,)
    )
    assert result.categorical_distribution.valid_area_hectares == pytest.approx(
        4.3, rel=1e-7
    )


def test_selected_rectangle_weights_fractional_cell_coverage(tmp_path: Path) -> None:
    """A partial-cell selection estimates its footprint instead of counting whole pixels."""
    path = write_categories(
        tmp_path / "box.tif",
        numpy.ones((1, 1), dtype=numpy.float32),
        from_origin(0, 1, 1, 1),
    )
    whole = read_raster_categorical_statistics(
        path, WholeRasterSamplingArea(), category_values=(1,)
    )
    selected = read_raster_categorical_statistics(
        path, SelectedBoundsSamplingArea((0, 0, 0.5, 1)), category_values=(1,)
    )
    assert selected.scope == "selectedArea"
    assert selected.categorical_distribution.valid_area_hectares == pytest.approx(
        whole.categorical_distribution.valid_area_hectares / 2
    )


def test_catalog_polygons_preserve_holes_and_union_overlaps(tmp_path: Path) -> None:
    """Streaming original polygons excludes holes and never counts overlaps twice."""
    path = write_categories(
        tmp_path / "polygon.tif",
        numpy.ones((4, 4), dtype=numpy.float32),
        from_origin(0, 4, 1, 1),
    )
    geometry = {
        "type": "Polygon",
        "coordinates": [
            [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
            [[1, 1], [1, 3], [3, 3], [3, 1], [1, 1]],
        ],
    }
    one = write_selection(tmp_path / "one.gpkg", [geometry])
    duplicate = write_selection(tmp_path / "duplicate.gpkg", [geometry, geometry])
    first = read_raster_categorical_statistics(
        path, CatalogSelectionSamplingArea(one), category_values=(1,)
    )
    second = read_raster_categorical_statistics(
        path, CatalogSelectionSamplingArea(duplicate), category_values=(1,)
    )
    whole = read_raster_categorical_statistics(
        path, WholeRasterSamplingArea(), category_values=(1,)
    )
    assert first.scope == "catalogSelection"
    assert first.categorical_distribution.valid_area_hectares == pytest.approx(
        second.categorical_distribution.valid_area_hectares
    )
    assert (
        first.categorical_distribution.valid_area_hectares
        / whole.categorical_distribution.valid_area_hectares
        == pytest.approx(0.75, rel=1e-3)
    )


def test_category_sampling_bypasses_averaged_overview(tmp_path: Path) -> None:
    """An averaged overview code never becomes a native category."""
    values = numpy.tile(numpy.array([1, 3], dtype=numpy.float32), (512, 256))
    path = write_categories(
        tmp_path / "overview.tif", values, from_origin(0, 1, 1 / 512, 1 / 512)
    )
    with rasterio.open(path, "r+") as dataset:
        dataset.build_overviews([2, 4], Resampling.average)
    result = read_raster_categorical_statistics(
        path, WholeRasterSamplingArea(), category_values=(1, 2, 3)
    )
    assert result.sampling_method == "sampleGrid"
    assert max(result.sample_width, result.sample_height) <= 127
    assert result.categorical_distribution.areas_hectares[1] == 0
    assert result.categorical_distribution.unmapped_area_hectares == 0


def test_category_area_cancellation_and_longitude_domain(tmp_path: Path) -> None:
    """Cancellation and unsupported wrap domains fail explicitly."""
    path = write_categories(
        tmp_path / "wrap.tif",
        numpy.ones((1, 1), dtype=numpy.float32),
        from_origin(179, 1, 3, 1),
    )
    with pytest.raises(RasterReadCancelled):
        read_raster_categorical_statistics(
            path, WholeRasterSamplingArea(), lambda: True, category_values=(1,)
        )
    with pytest.raises(ValueError, match="continuous longitude"):
        read_raster_categorical_statistics(
            path, WholeRasterSamplingArea(), category_values=(1,)
        )


@pytest.mark.parametrize(
    "codes", [[], [1, 1], [True], [1.5], ["1"], [2**53], list(range(257))]
)
def test_category_request_rejects_unbounded_or_inexact_codes(codes: object) -> None:
    """User-input validation rejects codes outside the exact bounded contract."""
    with pytest.raises(ValidationError):
        CatalogRasterStatisticsRequest(
            collectionId="eolab-mounted-geotiffs",
            itemId="geotiff-0123456789abcdef01234567",
            categoryValues=codes,
        )
