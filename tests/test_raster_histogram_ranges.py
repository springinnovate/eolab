"""Exercise fixed histogram bins at float64 precision and magnitude limits."""

from pathlib import Path

import numpy
import pytest
from rasterio.transform import from_origin

from eolab_app.raster.paired_statistics import read_raster_paired_statistics
from eolab_app.raster.statistics import read_raster_statistics
from eolab_app.sampling_area import WholeRasterSamplingArea
from raster_fixture_support import write_source

FLOAT64_MAXIMUM = float(numpy.finfo(numpy.float64).max)
SAMPLE_VALUES = [
    pytest.param((1.0, numpy.nextafter(1.0, 2.0)), id="adjacent-positive"),
    pytest.param((-1.0, numpy.nextafter(-1.0, 0.0)), id="adjacent-negative"),
    pytest.param((0.0, numpy.nextafter(0.0, 1.0)), id="adjacent-subnormal"),
    pytest.param(
        (numpy.nextafter(FLOAT64_MAXIMUM, 0.0), FLOAT64_MAXIMUM),
        id="adjacent-maximum",
    ),
    pytest.param(
        (-FLOAT64_MAXIMUM, numpy.nextafter(-FLOAT64_MAXIMUM, 0.0)),
        id="adjacent-minimum",
    ),
    pytest.param((FLOAT64_MAXIMUM,), id="constant-maximum"),
    pytest.param((-FLOAT64_MAXIMUM,), id="constant-minimum"),
    pytest.param((0.0,), id="constant-zero"),
    pytest.param((-FLOAT64_MAXIMUM, 0.0, FLOAT64_MAXIMUM), id="full-finite-span"),
    pytest.param((1.0, 2.0, 3.0), id="ordinary"),
]


@pytest.mark.parametrize("values", SAMPLE_VALUES)
def test_single_histogram_keeps_fixed_bins_and_exact_extrema(
    tmp_path: Path, values: tuple[float, ...]
) -> None:
    """Return all finite samples through the real reader and response contract.

    Args:
        tmp_path: Temporary directory for the float64 GeoTIFF source.
        values: Finite samples spanning ordinary or difficult float64 ranges.
    """
    source = write_source(
        tmp_path / "single.tif",
        numpy.array([values], dtype=numpy.float64),
        transform=from_origin(0, 1, 1, 1),
    )

    result = read_raster_statistics(source, WholeRasterSamplingArea())

    assert result.sample_minimum == min(values)
    assert result.sample_maximum == max(values)
    assert result.valid_sample_count == sum(result.histogram.counts) == len(values)
    assert len(result.histogram.counts) == 64
    edges = numpy.array(result.histogram.edges)
    assert len(edges) == 65
    assert numpy.isfinite(edges).all()
    assert numpy.all(edges[1:] > edges[:-1])
    assert edges[0] <= min(values) <= max(values) <= edges[-1]
    expected_percentiles = numpy.percentile(values, (5, 50, 95))
    assert (
        result.percentiles.p05,
        result.percentiles.p50,
        result.percentiles.p95,
    ) == tuple(expected_percentiles)


@pytest.mark.parametrize("values", SAMPLE_VALUES)
def test_paired_histogram_keeps_fixed_bins_and_exact_extrema(
    tmp_path: Path, values: tuple[float, ...]
) -> None:
    """Keep paired counts and marginals coherent for finite float64 samples.

    Args:
        tmp_path: Temporary directory for the two float64 GeoTIFF sources.
        values: Finite samples spanning ordinary or difficult float64 ranges.
    """
    x_source = write_source(
        tmp_path / "x.tif",
        numpy.array([values], dtype=numpy.float64),
        transform=from_origin(0, 1, 1, 1),
    )
    y_source = write_source(
        tmp_path / "y.tif",
        -numpy.array([values], dtype=numpy.float64),
        transform=from_origin(0, 1, 1, 1),
    )

    result = read_raster_paired_statistics(x_source, y_source, None)

    assert result.x_minimum == min(values)
    assert result.x_maximum == max(values)
    assert result.y_minimum == -max(values)
    assert result.y_maximum == -min(values)
    counts = numpy.array(result.histogram.counts)
    assert counts.shape == (32, 32)
    assert result.paired_sample_count == int(counts.sum()) == len(values)
    assert counts.sum(axis=0).tolist() == result.histogram.x_marginal_counts
    assert counts.sum(axis=1).tolist() == result.histogram.y_marginal_counts
    for edge_values, minimum, maximum in (
        (result.histogram.x_edges, min(values), max(values)),
        (result.histogram.y_edges, -max(values), -min(values)),
    ):
        edges = numpy.array(edge_values)
        assert len(edges) == 33
        assert numpy.isfinite(edges).all()
        assert numpy.all(edges[1:] > edges[:-1])
        assert edges[0] <= minimum <= maximum <= edges[-1]
    if len(values) == 3:
        assert counts[31, 0] == 1
        assert counts[0, 31] == 1
