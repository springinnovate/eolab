"""Check raster calculator values, source alignment, and output masks with real TIFFs."""

import json
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_bounds, from_origin
from rasterio.warp import transform_bounds

from eolab_app.processing.aggregate_models import RasterAggregateLimits
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.raster_calculator import (
    RasterCalculatorSources,
    calculate_raster,
    plan_calculator_grid,
)
from eolab_app.processing.raster_calculator_models import (
    CustomRasterGrid,
    MatchRasterGrid,
    QueuedRasterCalculator,
    RasterCalculatorRequest,
    RasterFormulaInput,
    RasterFormulaLayer,
)
from eolab_app.processing.raster_expression import (
    compile_pixel_expression,
    evaluate_pixel_expression,
)
from eolab_app.raster.models import Wgs84Bounds
from catalog_selection_support import write_selection
from raster_fixture_support import write_source
from raster_source_support import SOURCE


def test_pixel_formula_keeps_power_precedence_and_undefined_intermediates() -> None:
    """Evaluate numeric operators against checked independent pixel values."""
    aliases = frozenset({"a", "b"})
    samples = {
        "a": np.array([2.0, -2.0, 0.0, np.nan]),
        "b": np.array([1.0, 3.0, 1.0, 4.0]),
    }
    root = compile_pixel_expression("max(-a^2 + 2^3^2, min(b^2, 10)) / 2", aliases)
    np.testing.assert_array_equal(
        evaluate_pixel_expression(root, samples), [254, 254, 256, np.nan]
    )
    invalid = compile_pixel_expression("(a / (b - b)) ^ 0", aliases)
    assert np.isnan(evaluate_pixel_expression(invalid, samples)).all()
    fractional = compile_pixel_expression("min(10, a^0.5)", aliases)
    np.testing.assert_allclose(
        evaluate_pixel_expression(fractional, samples), [2**0.5, np.nan, 0, np.nan]
    )


@pytest.mark.parametrize(
    "expression", ["a + missing", "mean(a)", "a >= 2", "min(a)", "max(a, 1, 2)", "42"]
)
def test_calculator_rejects_names_and_operators_outside_its_grammar(
    expression: str,
) -> None:
    """Require a bound raster and pixel arithmetic at the formula boundary."""
    with pytest.raises(ProcessingError, match="."):
        compile_pixel_expression(expression, frozenset({"a"}))


def test_match_grid_warps_shifted_projection_and_keeps_polygon_hole(
    tmp_path: Path,
) -> None:
    """Read different native grids and publish the actual masked output on a's lattice."""
    extent = (0.0025, 0.0025, 0.0425, 0.0425)
    reference_transform = from_origin(0.0025, 0.0425, 0.01, 0.01)
    a = write_source(
        tmp_path / "a.tif",
        np.arange(16, dtype="int16").reshape(4, 4),
        transform=reference_transform,
    )
    covered = transform_bounds("EPSG:4326", "EPSG:3857", *extent[:2], 0.0325, extent[3])
    b = write_source(
        tmp_path / "b.tif",
        np.full((8, 6), 6, dtype="int16"),
        transform=from_bounds(*covered, 6, 8),
        crs="EPSG:3857",
    )
    unused = write_source(tmp_path / "c.tif", np.array([[100]], dtype="int16"))
    area = write_selection(
        tmp_path / "area.gpkg",
        [
            {
                "type": "Polygon",
                "coordinates": [
                    [
                        [0.0025, 0.0025],
                        [0.0425, 0.0025],
                        [0.0425, 0.0425],
                        [0.0025, 0.0425],
                        [0.0025, 0.0025],
                    ],
                    [
                        [0.013, 0.023],
                        [0.022, 0.023],
                        [0.022, 0.032],
                        [0.013, 0.032],
                        [0.013, 0.023],
                    ],
                ],
            }
        ],
    )
    request = RasterCalculatorRequest(
        calculation=RasterFormulaInput(
            layers=tuple(
                RasterFormulaLayer(alias=alias, source=SOURCE, resampling="nearest")
                for alias in ("a", "b", "c")
            ),
            expression="max(0, b - a)",
            grid=MatchRasterGrid(kind="match", alias="a"),
        ),
        catalogSelection=area.selection,
    )
    queued = QueuedRasterCalculator(request=request, polygonArea=None)
    sources = RasterCalculatorSources({"a": a, "b": b, "c": unused}, area)
    plan = plan_calculator_grid(sources, queued)
    result = calculate_raster(sources, plan, tmp_path, RasterAggregateLimits())
    assert result.valid_pixels == 11
    with rasterio.open(tmp_path / "result.tif") as output:
        assert output.tags(ns="IMAGE_STRUCTURE")["LAYOUT"] == "COG"
        assert output.crs.to_epsg() == 4326
        assert output.transform == reference_transform
        assert output.dtypes == ("float64",)
        assert np.isnan(output.nodata)
        np.testing.assert_array_equal(
            output.read(1),
            [
                [6, 5, 4, np.nan],
                [2, np.nan, 0, np.nan],
                [0, 0, 0, np.nan],
                [0, 0, 0, np.nan],
            ],
        )
    provenance = json.loads((tmp_path / "provenance.json").read_text(encoding="utf-8"))
    assert provenance["sourceBands"]["a"] == {
        "scale": "2.0",
        "offset": "-1.0",
        "unit": "m",
    }
    assert "c" not in provenance["sourceBands"]
    assert provenance["inputs"]["calculation"]["expression"] == "max(0, b - a)"
    assert str(a) not in json.dumps(provenance)
    assert not list(tmp_path.glob("aligned-*"))


@pytest.mark.parametrize(
    ("method", "expected"),
    [
        ("nearest", [[6, 12], [7, 16]]),
        ("mean", [[3, 9], [4, 7]]),
        ("min", [[2, 8], [3, 4]]),
        ("max", [[6, 12], [7, 16]]),
        ("mode", [[2, 8], [3, 4]]),
    ],
)
def test_calculator_custom_grid_uses_the_layer_method(
    tmp_path: Path, method: str, expected: list[list[int]]
) -> None:
    """Apply the selected native warp before evaluating a formula on a custom grid."""
    transform = from_origin(0, 0.04, 0.01, 0.01)
    source = write_source(
        tmp_path / "source.tif",
        np.array(
            [[2, 2, 8, 8], [2, 6, 8, 12], [3, 3, 4, 4], [3, 7, 4, 16]], dtype="int16"
        ),
        transform=transform,
    )
    calculation = RasterFormulaInput.model_validate(
        {
            "layers": [{"alias": "a", "source": SOURCE, "resampling": method}],
            "expression": "a",
            "grid": {"kind": "custom", "crs": "EPSG:4326", "pixelSize": [0.02, 0.02]},
        }
    )
    request = RasterCalculatorRequest(
        calculation=calculation,
        selectedBounds=Wgs84Bounds(west=0, south=0, east=0.04, north=0.04),
    )
    sources = RasterCalculatorSources({"a": source}, None)
    plan = plan_calculator_grid(
        sources, QueuedRasterCalculator(request=request, polygonArea=None)
    )
    calculate_raster(sources, plan, tmp_path, RasterAggregateLimits())
    with rasterio.open(tmp_path / "result.tif") as output:
        assert output.transform == from_origin(0, 0.04, 0.02, 0.02)
        np.testing.assert_allclose(output.read(1), expected)


def test_bilinear_uses_source_neighbours_at_the_area_edge(tmp_path: Path) -> None:
    """Retain source samples just outside the area while warping its output cells."""
    ramp = (np.arange(4)[:, None] * 10 + np.arange(4)[None, :]).astype("int16")
    source = write_source(
        tmp_path / "ramp.tif", ramp, transform=from_origin(-0.0025, 0.0325, 0.01, 0.01)
    )
    request = RasterCalculatorRequest(
        calculation=RasterFormulaInput(
            layers=(
                RasterFormulaLayer(alias="a", source=SOURCE, resampling="bilinear"),
            ),
            expression="a",
            grid=CustomRasterGrid(
                kind="custom", crs="EPSG:4326", pixelSize=(0.01, 0.01)
            ),
        ),
        selectedBounds=Wgs84Bounds(west=0, south=0, east=0.03, north=0.03),
    )
    sources = RasterCalculatorSources({"a": source}, None)
    plan = plan_calculator_grid(
        sources, QueuedRasterCalculator(request=request, polygonArea=None)
    )
    calculate_raster(sources, plan, tmp_path, RasterAggregateLimits())
    with rasterio.open(tmp_path / "result.tif") as output:
        np.testing.assert_allclose(output.read(1), ramp[:3, :3] + 2.75)


@pytest.mark.parametrize(
    ("sample", "expression", "code"),
    [
        (-9999, "a", "no_shared_raster_coverage"),
        (1, "a / 0", "no_valid_calculator_values"),
    ],
)
def test_calculator_distinguishes_missing_coverage_from_invalid_arithmetic(
    tmp_path: Path, sample: int, expression: str, code: str
) -> None:
    """Report the reason an entire run would contain only NoData cells."""
    source = write_source(
        tmp_path / "source.tif",
        np.full((2, 2), sample, dtype="int16"),
        nodata=-9999,
        transform=from_origin(0, 0.02, 0.01, 0.01),
    )
    request = RasterCalculatorRequest(
        calculation=RasterFormulaInput(
            layers=(
                RasterFormulaLayer(alias="a", source=SOURCE, resampling="nearest"),
            ),
            expression=expression,
            grid=CustomRasterGrid(
                kind="custom", crs="EPSG:4326", pixelSize=(0.01, 0.01)
            ),
        ),
        selectedBounds=Wgs84Bounds(west=0, south=0, east=0.02, north=0.02),
    )
    sources = RasterCalculatorSources({"a": source}, None)
    plan = plan_calculator_grid(
        sources, QueuedRasterCalculator(request=request, polygonArea=None)
    )
    with pytest.raises(ProcessingError) as error:
        calculate_raster(sources, plan, tmp_path, RasterAggregateLimits())
    assert error.value.code == code
    assert not (tmp_path / "result.tif").exists()
