"""Read temporal observations through the existing raster analysis algorithms."""

from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import numpy
import pytest
import rasterio
from affine import Affine
from rasterio.crs import CRS

from catalog_selection_support import write_selection
from eolab_app.raster.categorical_statistics import read_raster_categorical_statistics
from eolab_app.raster.paired_statistics import read_raster_paired_statistics
from eolab_app.raster.pixel import read_raster_pixel
from eolab_app.raster.statistics import read_raster_statistics
from eolab_app.raster.temporal import TemporalObservation, TemporalRasterDataset
from eolab_app.raster.bounded_window import (
    selected_raster_area_for_wgs84_bounds,
    project_wgs84_polygons,
)
from eolab_app.sampling_area import (
    CatalogSelectionSamplingArea,
    SelectedBoundsSamplingArea,
    WholeRasterSamplingArea,
)


@pytest.fixture
def cyclic_observation(tmp_path: Path) -> TemporalObservation:
    """Create a small global grid with distinguishable native columns.

    Args:
        tmp_path: Isolated source directory.

    Returns:
        First of two observations in their published longitude order.
    """
    path = tmp_path / "grid_0.tif"
    values = numpy.arange(24, dtype="float32").reshape(3, 8)
    for index in range(2):
        with rasterio.open(
            tmp_path / f"grid_{index}.tif",
            "w",
            driver="GTiff",
            height=3,
            width=8,
            count=1,
            dtype="float32",
            crs="EPSG:4326",
            transform=Affine(45, 0, -202.5, 0, -45, 67.5),
            tiled=True,
            blockxsize=16,
            blockysize=16,
        ) as target:
            target.write(numpy.roll(values + index * 100, -4, axis=1), 1)
    time = datetime(2000, 1, 1, tzinfo=timezone.utc)
    return TemporalObservation(
        root=tmp_path,
        path=path,
        time=time,
        reference_time=None,
        interval_start=time,
        interval_end=time,
        transform=Affine(45, 0, -202.5, 0, -45, 67.5),
        crs=CRS.from_epsg(4326),
        nodata=None,
        cyclic_x=True,
    )


@pytest.mark.parametrize(
    "bounds, expected",
    [
        ((179, -1, 180, 1), 12),
        ((-180, -1, -179, 1), 12),
        ((-1, -1, 1, 1), 8),
    ],
)
def test_narrow_cyclic_bounds_match_native_point(
    cyclic_observation: TemporalObservation,
    bounds: tuple[float, float, float, float],
    expected: int,
) -> None:
    """Select the same native cell on both sides of either longitude seam.

    Args:
        cyclic_observation: Small real temporal grid.
        bounds: Narrow selected WGS84 region.
        expected: Original value within that region.
    """
    pixel = read_raster_pixel(cyclic_observation, (bounds[0] + bounds[2]) / 2, 0)
    statistics = read_raster_statistics(
        cyclic_observation, SelectedBoundsSamplingArea(bounds)
    )
    assert pixel.value == expected
    assert statistics.sample_minimum == statistics.sample_maximum == expected
    assert statistics.valid_sample_count == 1
    assert statistics.source_width <= 3


def test_full_world_selection_counts_each_cell_and_its_area_once(
    cyclic_observation: TemporalObservation,
) -> None:
    """Preserve counts and seam-cell area when a rectangle covers the full grid.

    Args:
        cyclic_observation: Small real temporal grid.
    """
    whole = read_raster_categorical_statistics(
        cyclic_observation,
        WholeRasterSamplingArea(),
        category_values=tuple(range(24)),
    )
    selected = read_raster_categorical_statistics(
        cyclic_observation,
        SelectedBoundsSamplingArea((-180, -67.5, 180, 67.5)),
        category_values=tuple(range(24)),
    )
    assert selected.valid_sample_count == whole.valid_sample_count == 24
    assert selected.categorical_distribution is not None
    assert whole.categorical_distribution is not None
    numpy.testing.assert_allclose(
        selected.categorical_distribution.areas_hectares,
        whole.categorical_distribution.areas_hectares,
        rtol=1e-12,
    )


def _write_reference(path: Path, center: float) -> None:
    """Create one regional reference cell centered at the requested longitude.

    Args:
        path: Destination GeoTIFF.
        center: Longitude of its only cell center.
    """
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=1,
        height=1,
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=Affine(0.2, 0, center - 0.1, 0, -1, 0.5),
    ) as dataset:
        dataset.write(numpy.array([[99]], dtype="float32"), 1)


def test_temporal_y_wraps_from_regional_reference_cell(
    cyclic_observation: TemporalObservation,
    tmp_path: Path,
) -> None:
    """Align a regional reference point beyond the temporal affine's east edge.

    Args:
        cyclic_observation: Cyclic Y grid.
        tmp_path: Reference raster directory.
    """
    reference = tmp_path / "reference.tif"
    _write_reference(reference, 179.9)
    result = read_raster_paired_statistics(
        reference, cyclic_observation, (179.8, -0.5, 180, 0.5)
    )
    assert result.paired_sample_count == 1
    assert result.x_minimum == 99
    assert result.y_minimum == 12


def test_temporal_x_uses_requested_longitude_domain(
    cyclic_observation: TemporalObservation,
    tmp_path: Path,
) -> None:
    """Keep the east-edge X cell when its native longitude is equivalent to -180.

    Args:
        cyclic_observation: Cyclic X grid.
        tmp_path: Reference raster directory.
    """
    reference = tmp_path / "reference.tif"
    _write_reference(reference, 180)
    result = read_raster_paired_statistics(
        cyclic_observation, reference, (179.9, -0.5, 180, 0.5)
    )
    assert result.paired_sample_count == 1
    assert result.x_minimum == 12
    assert result.y_minimum == 99


def test_polygon_selection_uses_paired_reference_view(
    cyclic_observation: TemporalObservation,
    tmp_path: Path,
) -> None:
    """Reuse the X overlap view while masking a wider filtered polygon.

    Args:
        cyclic_observation: First temporal input.
        tmp_path: Polygon and regional raster directory.
    """
    selection = CatalogSelectionSamplingArea(
        write_selection(
            tmp_path / "area.gpkg",
            [
                {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            (170, -1),
                            (180, -1),
                            (180, 1),
                            (170, 1),
                            (170, -1),
                        ]
                    ],
                }
            ],
        )
    )
    result = read_raster_statistics(cyclic_observation, selection)
    assert result.valid_sample_count == 1
    assert result.sample_minimum == 12
    paired = read_raster_paired_statistics(
        cyclic_observation,
        replace(cyclic_observation, path=cyclic_observation.root / "grid_1.tif"),
        None,
        catalog_selection=selection,
    )
    assert paired.paired_sample_count == 1
    assert paired.x_minimum == 12
    assert paired.y_minimum == 112


def test_cyclic_window_planning_preserves_native_block_cost(
    cyclic_observation: TemporalObservation,
) -> None:
    """Keep chunk-aligned blocks for both interior and seam selections.

    Args:
        cyclic_observation: Original grid with a four-column logical block.
    """
    for bounds in ((-1, -1, 1, 1), (179, -1, 180, 1)):
        with TemporalRasterDataset(cyclic_observation) as dataset:
            shape = dataset.block_shapes
            cost = dataset.maximum_decoded_block_bytes
            selected_raster_area_for_wgs84_bounds(dataset, bounds)
            assert dataset.block_shapes == shape
            assert dataset.maximum_decoded_block_bytes == cost
            if bounds[0] == -1:
                assert dataset.transform == cyclic_observation.transform


def test_projected_temporal_statistics_keep_the_admitted_grid(
    cyclic_observation: TemporalObservation,
) -> None:
    """Use an ordinary regional projected grid without longitude rotation.

    Args:
        cyclic_observation: Native values reused under admitted regional metadata.
    """
    projected = replace(
        cyclic_observation,
        transform=Affine(30, 0, 500000, 0, -30, 1000),
        crs=CRS.from_epsg(32632),
        cyclic_x=False,
    )
    result = read_raster_categorical_statistics(
        projected,
        WholeRasterSamplingArea(),
        category_values=tuple(range(24)),
    )
    assert result.valid_sample_count == 24
    assert result.sample_minimum == 0
    assert result.sample_maximum == 23
    assert result.categorical_distribution is not None
    assert result.categorical_distribution.valid_area_hectares == pytest.approx(
        2.16, rel=0.002
    )


def test_periodic_polygon_copies_share_the_geometry_budget(
    cyclic_observation: TemporalObservation,
) -> None:
    """Charge the seam copy before allocating it, with explicit unlimited work.

    Args:
        cyclic_observation: Source whose first cell straddles the canonical seam.
    """
    polygon = {
        "type": "Polygon",
        "coordinates": [
            [
                (-180, -1),
                (180, -1),
                (180, 1),
                (-180, 1),
                (-180, -1),
            ]
        ],
    }
    with TemporalRasterDataset(cyclic_observation) as dataset:
        with pytest.raises(ValueError, match="projected-coordinate limit"):
            project_wgs84_polygons(dataset, (polygon,), 5, maximum_output_coordinates=5)
        copied = project_wgs84_polygons(
            dataset, (polygon,), 5, maximum_output_coordinates=None
        )
        assert len(copied) == 2
