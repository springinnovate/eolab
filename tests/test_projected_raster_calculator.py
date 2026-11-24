"""Locate calculator inputs with a projected grid over a non-Greenwich meridian."""

import math
from pathlib import Path

import numpy as np
from pyproj import Transformer
import pytest
import rasterio
import tifffile

from eolab_app.processing.aggregate_models import RasterAggregateLimits
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
from eolab_app.raster.models import Wgs84Bounds
from eolab_app.raster.pixel import read_raster_pixel
from raster_source_support import SOURCE


@pytest.fixture
def survey_mercator(tmp_path: Path, request: pytest.FixtureRequest) -> Path:
    """Write a metre-based Mercator with a surveyed longitude of 2.137 degrees.

    Args:
        tmp_path: Directory for the standalone input.
        request: Whether the numeric keys also have an ESRI projection citation.
    Returns:
        Big-endian TIFF with values 0–51 on a 1,000-metre grid.
    """
    meridian_grads = 2.137 / 0.9
    citation = "GCS Name = Local survey|Primem = Survey meridian|"
    projection = "Local Mercator|"
    if request.param:
        projection = (
            'ESRI PE String = PROJCS["Local Mercator",GEOGCS["Local survey",'
            'DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],'
            f'PRIMEM["Survey",{meridian_grads}],UNIT["Grad",{math.pi / 200}]],'
            'PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],'
            'PARAMETER["scale_factor",1],PARAMETER["false_easting",0],'
            'PARAMETER["false_northing",0],UNIT["Meter",1]]|'
        )
    keys = (
        (1024, 0, 1, 32767 if request.param else 1),
        (1025, 0, 1, 1),
        (2048, 0, 1, 32767),
        (2049, 34737, len(citation), 0),
        (2050, 0, 1, 6326),
        (2051, 0, 1, 32767),
        (2054, 0, 1, 9105),
        (2056, 0, 1, 7030),
        (2061, 34736, 1, 0),
        (3072, 0, 1, 32767),
        (3073, 34737, len(projection), len(citation)),
        (3074, 0, 1, 32767),
        (3075, 0, 1, 7),
        (3076, 0, 1, 9001),
        (3080, 34736, 1, 1),
        (3081, 34736, 1, 1),
        (3082, 34736, 1, 1),
        (3083, 34736, 1, 1),
        (3092, 34736, 1, 2),
    )
    directory = (1, 1, 1, len(keys), *(n for entry in keys for n in entry))
    path = tmp_path / "survey-mercator.tif"
    tifffile.imwrite(
        path,
        np.arange(52, dtype="int16").reshape(4, 13),
        metadata=None,
        byteorder=">",
        extratags=[
            (33550, "d", 3, (1000, 1000, 0), False),
            (33922, "d", 6, (0, 0, 0, 0, 4000, 0), False),
            (34735, "H", len(directory), directory, False),
            (34736, "d", 3, (meridian_grads, 0, 1), False),
            (34737, "s", 0, citation + projection, False),
        ],
    )
    return path


@pytest.mark.parametrize("survey_mercator", [False, True], indirect=True)
def test_projected_base_meridian_locates_original_cell(survey_mercator: Path) -> None:
    """Pick opposite corners at their independent World Mercator positions.

    Args:
        survey_mercator: Numeric or citation-based survey grid.
    """
    geographic = Transformer.from_crs(3395, 4326, always_xy=True)
    for row, column in ((0, 0), (3, 12)):
        lon, lat = geographic.transform(1000 * column + 500, 3500 - 1000 * row)
        pixel = read_raster_pixel(survey_mercator, lon + 2.137, lat)
        assert (pixel.row, pixel.column, pixel.value) == (
            row,
            column,
            13 * row + column,
        )


def calculate_survey_grid(
    directory: Path, reference: Path, grid: CustomRasterGrid | MatchRasterGrid
) -> Path:
    """Copy the survey samples onto the requested grid over its measured footprint.

    Args:
        directory: Existing directory for the result.
        reference: Four-by-thirteen Mercator raster at 2.137 degrees east.
        grid: Requested calculator output grid.
    Returns:
        Published single-band COG from the ordinary calculator workflow.
    """
    bounds = Wgs84Bounds(west=2.1371, south=0.0001, east=2.2536, north=0.0361)
    request = RasterCalculatorRequest(
        calculation=RasterFormulaInput(
            layers=(
                RasterFormulaLayer(alias="a", source=SOURCE, resampling="nearest"),
            ),
            expression="a",
            grid=grid,
        ),
        selectedBounds=bounds,
    )
    sources = RasterCalculatorSources({"a": reference}, None)
    spec = plan_calculator_grid(
        sources, QueuedRasterCalculator(request=request, polygonArea=None)
    )
    result = calculate_raster(sources, spec, directory, RasterAggregateLimits())
    return directory / result.filename


@pytest.mark.parametrize("survey_mercator", [False, True], indirect=True)
def test_warp_uses_projected_base_meridian(
    survey_mercator: Path, tmp_path: Path
) -> None:
    """Check every WGS84 output cell against an independent World Mercator lookup.

    Args:
        survey_mercator: Numeric or citation-based custom Mercator input.
        tmp_path: Directory for the WGS84 result.
    """
    grid = CustomRasterGrid(kind="custom", crs="EPSG:4326", pixelSize=(0.01, 0.01))
    path = calculate_survey_grid(tmp_path, survey_mercator, grid)
    mercator = Transformer.from_crs(4326, 3395, always_xy=True)
    with rasterio.open(path) as output:
        values = output.read(1)
        rows, columns = np.indices(values.shape)
        lon, lat = output.transform * (columns + 0.5, rows + 0.5)
        x, y = mercator.transform(lon - 2.137, lat)
        source_col = np.floor(x / 1000).astype(int)
        source_row = np.floor((4000 - y) / 1000).astype(int)
        inside = (
            (source_col >= 0) & (source_col < 13) & (source_row >= 0) & (source_row < 4)
        )
        assert np.count_nonzero(inside) >= 35
        np.testing.assert_array_equal(
            values, np.where(inside, 13 * source_row + source_col, np.nan)
        )


@pytest.mark.parametrize("survey_mercator", [False, True], indirect=True)
def test_matched_mercator_cog_preserves_survey_grid(
    survey_mercator: Path, tmp_path: Path
) -> None:
    """Read all published samples at their original metre and longitude coordinates.

    Args:
        survey_mercator: Original Mercator reference.
        tmp_path: Directory for the matched output.
    """
    path = calculate_survey_grid(
        tmp_path, survey_mercator, MatchRasterGrid(kind="match", alias="a")
    )
    with tifffile.TiffFile(path) as published:
        keys = published.pages[0].geotiff_tags
        assert keys["GeogAngularUnitsGeoKey"] == 9105
        assert keys["GeogPrimeMeridianLongGeoKey"] == pytest.approx(2.137 / 0.9)
    with rasterio.Env(OSR_WKT_FORMAT="WKT2_2019"), rasterio.open(path) as output:
        assert output.tags(ns="IMAGE_STRUCTURE")["LAYOUT"] == "COG"
        assert output.transform.to_gdal() == (0, 1000, 0, 4000, 0, -1000)
        np.testing.assert_array_equal(output.read(1), np.arange(52).reshape(4, 13))
    geographic = Transformer.from_crs(3395, 4326, always_xy=True)
    lon, lat = geographic.transform(12500, 500)
    assert read_raster_pixel(path, lon + 2.137, lat).value == 51
