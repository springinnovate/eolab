"""Exercise the installed Habitat condition runner with EOlab's dependencies."""

from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import box

from nhi_terrestrial_integrity_modeling.habitat_training import IntegrityConfiguration
from nhi_terrestrial_integrity_modeling.prepared_rasters import RasterBand
from nhi_terrestrial_integrity_modeling.prepared_runner import run_habitat_condition


def test_installed_runner_fits_and_writes_condition_maps(tmp_path: Path) -> None:
    """Fit reference sites and read the runner's five completed GeoTIFF outputs.

    Args:
        tmp_path: Directory for the aligned input stack and calculated maps.
    """
    rows, columns = np.indices((16, 24))
    environment = rows * 0.3 + columns * 0.07
    habitat_type = (rows + columns) % 3
    reference_sites = rows < 6
    observed_condition = (
        1
        + 0.3 * environment
        + 0.1 * habitat_type
        + 0.04 * np.sin(rows + columns)
        + 0.2 * (columns % 3) * ~reference_sites
    )
    grid = from_origin(0, 16000, 1000, 1000)
    path = tmp_path / "inputs.tif"
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        count=4,
        width=24,
        height=16,
        dtype="float64",
        crs="EPSG:6933",
        transform=grid,
    ) as source:
        source.write(
            np.stack((environment, habitat_type, observed_condition, reference_sites))
        )
    configuration = IntegrityConfiguration(
        fold_count=3,
        sampling_block_size_meters=2000,
        validation_block_size_meters=4000,
        minimum_predictor_coverage=0.8,
        maximum_row_missing_fraction=0.5,
        minimum_response_coverage=0.5,
        spline_knot_count=3,
        ridge_alpha=1.0,
    )
    result = run_habitat_condition(
        [RasterBand("environment", path), RasterBand("habitat_type", path, 2)],
        [RasterBand("observed_condition", path, 3)],
        RasterBand("reference_sites", path, 4),
        box(100, 100, 23900, 15900),
        tmp_path / "output",
        configuration,
        categorical_predictor_name="habitat_type",
        samples_per_class_per_block=100,
        random_seed=17,
        tile_size_pixels=8,
        window_size_pixels=5,
        covariance_shrinkage=0.1,
    )

    for output, band_count, nodata in (
        (result.reference_similarity, 1, -9999),
        (result.expected_reference, 1, -9999),
        (result.observed_minus_expected, 1, -9999),
        (result.standardized_deviation, 1, -9999),
        (result.inference_status, 2, 255),
    ):
        with rasterio.open(output) as source:
            assert source.shape == (16, 24)
            assert source.crs == "EPSG:6933"
            assert source.transform == grid
            assert source.count == band_count
            assert source.nodata == nodata
            values = source.read(masked=True)
            assert values.count() > 0
            assert np.isfinite(values.compressed()).all()

    with rasterio.open(result.reference_similarity) as source:
        similarity = source.read(1, masked=True)
        assert similarity.min() >= 0
        assert similarity.max() <= 1
        assert similarity.mask[reference_sites].all()
