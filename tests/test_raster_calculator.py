"""Check raster calculator values, source alignment, and output masks with real TIFFs."""

import json
import math
from pathlib import Path

from affine import Affine
import numpy as np
from pyproj import CRS as ProjCRS, Transformer
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.features import geometry_mask
from rasterio.transform import from_bounds, from_origin
from rasterio.warp import transform_bounds
from shapely import contains_xy
from shapely.geometry import MultiPolygon, Point, Polygon, box, mapping

from eolab_app.processing.aggregate_models import RasterAggregateLimits
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.raster_calculator import (
    RasterCalculatorSources,
    calculate_raster,
    plan_calculator_grid,
    project_calculator_area,
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
    monkeypatch: pytest.MonkeyPatch,
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
    raster_writes: list[str] = []
    open_raster = rasterio.open

    def record_raster_writes(
        path: str | Path, mode: str = "r", **kwargs: object
    ) -> rasterio.io.DatasetReader | rasterio.io.DatasetWriter:
        """Observe data TIFFs created by the normal calculator entry point."""
        if mode == "w" and Path(path).suffix == ".tif":
            raster_writes.append(Path(path).name)
        return open_raster(path, mode, **kwargs)

    monkeypatch.setattr(rasterio, "open", record_raster_writes)
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
    assert sorted(raster_writes) == ["calculated.tif", "polygon-mask.tif"]
    assert not list(tmp_path.rglob("*.vrt"))
    assert not list(tmp_path.rglob("polygon-mask.tif"))


def test_match_grid_preserves_native_polygon_edges(tmp_path: Path) -> None:
    """Publish exactly the cells inside a polygon already on the matching grid."""
    crs = "EPSG:32610"
    extent = (350_000, 4_250_000, 650_000, 4_550_000)
    source = write_source(
        tmp_path / "source.tif",
        np.ones((340, 340), dtype="uint8"),
        transform=from_origin(330_000, 4_570_000, 1000, 1000),
        crs=crs,
    )
    area = write_selection(tmp_path / "area.gpkg", [mapping(box(*extent))], crs=crs)
    request = RasterCalculatorRequest(
        calculation=RasterFormulaInput(
            layers=(
                RasterFormulaLayer(alias="a", source=SOURCE, resampling="nearest"),
            ),
            expression="a",
            grid=MatchRasterGrid(kind="match", alias="a"),
        ),
        catalogSelection=area.selection,
    )
    sources = RasterCalculatorSources({"a": source}, area)
    plan = plan_calculator_grid(
        sources, QueuedRasterCalculator(request=request, polygonArea=None)
    )
    result = calculate_raster(sources, plan, tmp_path, RasterAggregateLimits())
    assert result.valid_pixels == 90_000
    with rasterio.open(tmp_path / "result.tif") as output:
        assert tuple(output.bounds) == extent
        np.testing.assert_array_equal(output.read(1), np.ones((300, 300)))


@pytest.mark.parametrize("single_feature", [False, True])
def test_projected_dateline_parts_preserve_polygon_holes(
    tmp_path: Path, single_feature: bool
) -> None:
    """Keep the same area when dateline parts meet on a continuous output grid.

    Args:
        tmp_path: Original catalog polygon, raster and calculator output directory.
        single_feature: Store the parts in one MultiPolygon or as two features.
    """
    west = Polygon(
        box(179.41, 0.24, 180, 1.03).exterior.coords,
        [box(179.54, 0.43, 179.80, 0.62).exterior.coords],
    )
    east = Polygon(
        box(-180, 0.24, -179.43, 1.03).exterior.coords,
        [box(-179.82, 0.47, -179.61, 0.65).exterior.coords],
    )
    original = MultiPolygon([west, east])
    assert original.is_valid
    area = write_selection(
        tmp_path / "area.gpkg",
        [mapping(original)] if single_feature else [mapping(west), mapping(east)],
    )
    source = write_source(
        tmp_path / "source.tif",
        np.ones((2, 360), dtype="uint8"),
        transform=from_origin(-180, 2, 1, 1),
    )
    request = RasterCalculatorRequest(
        calculation=RasterFormulaInput(
            layers=(
                RasterFormulaLayer(alias="a", source=SOURCE, resampling="nearest"),
            ),
            expression="a",
            grid=CustomRasterGrid(
                kind="custom", crs="EPSG:32660", pixelSize=(9500, 7900)
            ),
        ),
        catalogSelection=area.selection,
    )
    sources = RasterCalculatorSources({"a": source}, area)
    plan = plan_calculator_grid(
        sources, QueuedRasterCalculator(request=request, polygonArea=None)
    )
    result = calculate_raster(sources, plan, tmp_path, RasterAggregateLimits())
    with rasterio.open(tmp_path / "result.tif") as output:
        rows, columns = np.indices(output.shape, dtype="float64") + 0.5
        lon, lat = Transformer.from_crs(32660, 4326, always_xy=True).transform(
            output.transform.c + columns * output.transform.a,
            output.transform.f + rows * output.transform.e,
        )
        inside = np.array(
            [
                original.contains(Point(x, y))
                for x, y in zip(lon.ravel(), lat.ravel(), strict=True)
            ]
        ).reshape(output.shape)
        assert output.shape == (12, 15)
        assert result.valid_pixels == inside.sum() == 130
        np.testing.assert_array_equal(output.read(1), np.where(inside, 1, np.nan))


def test_projected_box_refines_edges_at_output_cell_size() -> None:
    """Compare a 30 m boundary tile against inverse-projected cell centers."""
    crs = CRS.from_epsg(32610)
    request = RasterCalculatorRequest(
        calculation=RasterFormulaInput(
            layers=(
                RasterFormulaLayer(alias="a", source=SOURCE, resampling="nearest"),
            ),
            expression="a",
            grid=CustomRasterGrid(kind="custom", crs="EPSG:32610", pixelSize=(30, 30)),
        ),
        selectedBounds=Wgs84Bounds(west=-126, south=38, east=-118, north=45),
    )
    grid = from_origin(570_300, 4_207_350, 30, 30)
    rows, columns = np.indices((80, 80), dtype="float64") + 0.5
    xs, ys = grid.c + columns * grid.a, grid.f + rows * grid.e
    longitudes, latitudes = Transformer.from_crs(
        "EPSG:32610", "EPSG:4326", always_xy=True
    ).transform(xs, ys)
    inside = (
        (-126 <= longitudes)
        & (longitudes <= -118)
        & (38 <= latitudes)
        & (latitudes <= 45)
    )
    projected = project_calculator_area(request, None, None, crs, (30, 30))
    np.testing.assert_array_equal(
        geometry_mask(projected, (80, 80), grid, invert=True), inside
    )


@pytest.mark.parametrize("angular_unit", ["degree", "grad"])
def test_native_polygon_preserves_both_sides_of_the_dateline(
    tmp_path: Path, angular_unit: str
) -> None:
    """Publish native polygon membership on geographic grids with different units.

    Args:
        tmp_path: Native vector, reference raster and calculator output directory.
        angular_unit: Geographic reference grid's coordinate unit.
    """
    crs = CRS.from_epsg(4326)
    if angular_unit == "grad":
        definition = ProjCRS.from_epsg(4326).to_json_dict()
        del definition["id"]
        for axis in definition["coordinate_system"]["axis"]:
            axis["unit"] = {
                "type": "AngularUnit",
                "name": "grad",
                "conversion_factor": math.pi / 200,
            }
        crs = CRS.from_wkt(ProjCRS.from_json_dict(definition).to_wkt())
    degrees_to_units = math.radians(1) / crs.units_factor[1]
    source = write_source(
        tmp_path / "source.tif",
        np.ones((10, 3600), dtype="uint8"),
        transform=from_origin(
            -180 * degrees_to_units,
            71 * degrees_to_units,
            0.1 * degrees_to_units,
            0.1 * degrees_to_units,
        ),
        crs=crs.to_wkt(),
    )
    native_bounds = (-1_520_000, 1_510_000, -1_510_000, 1_520_000)
    area = write_selection(
        tmp_path / "arctic.gpkg", [mapping(box(*native_bounds))], crs="EPSG:3413"
    )
    request = RasterCalculatorRequest(
        calculation=RasterFormulaInput(
            layers=(
                RasterFormulaLayer(alias="a", source=SOURCE, resampling="nearest"),
            ),
            expression="a",
            grid=MatchRasterGrid(kind="match", alias="a"),
        ),
        catalogSelection=area.selection,
    )
    sources = RasterCalculatorSources({"a": source}, area)
    plan = plan_calculator_grid(
        sources, QueuedRasterCalculator(request=request, polygonArea=None)
    )
    result = calculate_raster(sources, plan, tmp_path, RasterAggregateLimits())
    with rasterio.open(tmp_path / "result.tif") as output:
        rows, columns = np.indices(output.shape, dtype="float64") + 0.5
        horizontal = output.transform.c + columns * output.transform.a
        vertical = output.transform.f + rows * output.transform.e
        assert output.crs == crs
        x, y = Transformer.from_crs(crs, "EPSG:3413", always_xy=True).transform(
            horizontal, vertical
        )
        west, south, east, north = native_bounds
        inside = (west < x) & (x < east) & (south < y) & (y < north)
        assert result.valid_pixels == inside.sum() == 2
        assert set((horizontal[inside] / degrees_to_units).round(2)) == {
            -179.95,
            179.95,
        }
        np.testing.assert_array_equal(output.read(1), np.where(inside, 1, np.nan))


@pytest.mark.parametrize("include_island", [False, True])
def test_geographic_output_preserves_a_hole_enclosing_the_pole(
    tmp_path: Path, include_island: bool
) -> None:
    """Keep a polar hole and any separate island when projecting to longitude.

    Args:
        tmp_path: Native polar vector, geographic raster and calculator output.
        include_island: Add a separate polygon inside the other part's hole.
    """
    shell = box(-49001, -31013, 37001, 46003)
    hole = box(-7111, -20101, 14999, 16003)
    polygon = Polygon(shell.exterior.coords, [hole.exterior.coords])
    original = (
        MultiPolygon([polygon, box(-6000, -10000, -3000, -4000)])
        if include_island
        else polygon
    )
    assert original.is_valid
    area = write_selection(
        tmp_path / "polar.gpkg", [mapping(original)], crs="EPSG:3031"
    )
    values = np.arange(24 * 720, dtype="int16").reshape(24, 720)
    source = write_source(
        tmp_path / "source.tif",
        values,
        transform=from_origin(-180, -88.8, 0.5, 0.05),
    )
    request = RasterCalculatorRequest(
        calculation=RasterFormulaInput(
            layers=(
                RasterFormulaLayer(alias="a", source=SOURCE, resampling="nearest"),
            ),
            expression="a",
            grid=MatchRasterGrid(kind="match", alias="a"),
        ),
        catalogSelection=area.selection,
    )
    sources = RasterCalculatorSources({"a": source}, area)
    plan = plan_calculator_grid(
        sources, QueuedRasterCalculator(request=request, polygonArea=None)
    )
    result = calculate_raster(sources, plan, tmp_path, RasterAggregateLimits())
    with rasterio.open(tmp_path / "result.tif") as output:
        rows, columns = np.indices(output.shape, dtype="float64") + 0.5
        lon = output.transform.c + columns * output.transform.a
        lat = output.transform.f + rows * output.transform.e
        x, y = Transformer.from_crs(4326, 3031, always_xy=True).transform(lon, lat)
        inside = contains_xy(original, x, y)
        source_rows = np.floor((-88.8 - lat) / 0.05).astype(int)
        source_columns = np.floor((lon + 180) / 0.5).astype(int)
        assert output.shape == (13 if include_island else 12, 720)
        assert output.crs == CRS.from_epsg(4326)
        assert result.valid_pixels == inside.sum()
        if include_island:
            assert inside.sum() > 3983
        else:
            assert inside.sum() == 3983
        np.testing.assert_array_equal(
            output.read(1),
            np.where(inside, values[source_rows, source_columns], np.nan),
        )


@pytest.mark.parametrize("area_kind", ["bounds", "samplingBox"])
def test_calculator_reports_a_cut_inside_the_output_projection(
    tmp_path: Path, area_kind: str
) -> None:
    """Reject a small box across the Pacific Mercator cut before making a world grid."""
    source = write_source(
        tmp_path / "source.tif",
        np.ones((1, 360), dtype="uint8"),
        transform=from_origin(-180, 1, 1, 1),
    )
    area = (
        {
            "selectedBounds": {
                "west": -30.49,
                "south": 0.02,
                "east": -29.51,
                "north": 0.98,
            }
        }
        if area_kind == "bounds"
        else {
            "samplingBox": {
                "center": {"longitude": -30, "latitude": 0.5},
                "sideLengthKm": 100,
            }
        }
    )
    request = RasterCalculatorRequest.model_validate(
        {
            "calculation": {
                "layers": [{"alias": "a", "source": SOURCE, "resampling": "nearest"}],
                "expression": "a",
                "grid": {
                    "kind": "custom",
                    "crs": "EPSG:3832",
                    "pixelSize": (55659.74539663678, 111319.49079327357),
                },
            },
            **area,
        }
    )
    with pytest.raises(ProcessingError, match="crosses a cut in the output projection"):
        plan_calculator_grid(
            RasterCalculatorSources({"a": source}, None),
            QueuedRasterCalculator(request=request, polygonArea=None),
        )
    assert not (tmp_path / "result.tif").exists()
    if area_kind == "bounds":
        # A polygon wholly on either branch still has a valid, compact grid.
        for shift in (-1, 1):
            adjacent = request.model_copy(
                update={
                    "selectedBounds": Wgs84Bounds(
                        west=-30.49 + shift, south=0.02, east=-29.51 + shift, north=0.98
                    )
                }
            )
            sources = RasterCalculatorSources({"a": source}, None)
            spec = plan_calculator_grid(
                sources, QueuedRasterCalculator(request=adjacent, polygonArea=None)
            )
            attempt = tmp_path / str(shift)
            attempt.mkdir()
            result = calculate_raster(sources, spec, attempt, RasterAggregateLimits())
            assert result.valid_pixels == 2


@pytest.mark.parametrize(
    "polar_epsg,longitude,latitude,half_width,pixel_size",
    [
        (3413, 135, 70, 1000, (500, 500)),
        (3413, 180, 70, 1000, (500, 500)),
        (3031, 180, -70, 10, (100187.45, 1000)),
    ],
)
def test_polar_selection_distinguishes_source_and_target_cuts(
    tmp_path: Path,
    polar_epsg: int,
    longitude: int,
    latitude: int,
    half_width: int,
    pixel_size: tuple[float, float],
) -> None:
    """Accept a continuous target footprint while still rejecting a real target cut.

    Args:
        tmp_path: Polar vector, Mercator reference and calculator output directory.
        polar_epsg: Native polar projection, including a coincident inverse cut.
        longitude: A source inverse cut or the actual Mercator longitude cut.
        latitude: Center of the selection in the appropriate hemisphere.
        half_width: Native selection half-width in meters.
        pixel_size: Output cell sizes, including a wide anisotropic grid.
    """
    x, y = Transformer.from_crs(4326, polar_epsg, always_xy=True).transform(
        longitude, latitude
    )
    if polar_epsg == 3031:
        x = 0
    native_bounds = (x - half_width, y - 1000, x + half_width, y + 1000)
    area = write_selection(
        tmp_path / "polar.gpkg",
        [mapping(box(*native_bounds))],
        crs=f"EPSG:{polar_epsg}",
    )
    center_x, center_y = Transformer.from_crs(4326, 3857, always_xy=True).transform(
        longitude, latitude
    )
    source = write_source(
        tmp_path / "source.tif",
        np.full((16, 16), 7, dtype="uint8"),
        transform=from_origin(center_x - 4000, center_y + 4000, *pixel_size),
        crs="EPSG:3857",
    )
    request = RasterCalculatorRequest(
        calculation=RasterFormulaInput(
            layers=(
                RasterFormulaLayer(alias="a", source=SOURCE, resampling="nearest"),
            ),
            expression="3 * a",
            grid=MatchRasterGrid(kind="match", alias="a"),
        ),
        catalogSelection=area.selection,
    )
    sources = RasterCalculatorSources({"a": source}, area)
    queued = QueuedRasterCalculator(request=request, polygonArea=None)
    if longitude == 180:
        with pytest.raises(
            ProcessingError, match="crosses a cut in the output projection"
        ):
            plan_calculator_grid(sources, queued)
        return
    plan = plan_calculator_grid(sources, queued)
    result = calculate_raster(sources, plan, tmp_path, RasterAggregateLimits())
    with rasterio.open(tmp_path / "result.tif") as output:
        rows, columns = np.indices(output.shape, dtype="float64") + 0.5
        xs, ys = Transformer.from_crs(3857, 3413, always_xy=True).transform(
            output.transform.c + columns * output.transform.a,
            output.transform.f + rows * output.transform.e,
        )
        west, south, east, north = native_bounds
        inside = (west < xs) & (xs < east) & (south < ys) & (ys < north)
        assert output.shape == (12, 12)
        assert result.valid_pixels == inside.sum() == 144
        np.testing.assert_array_equal(output.read(1), np.where(inside, 21, np.nan))


@pytest.mark.parametrize("source_left", [0, -180])
@pytest.mark.parametrize("crs", ["EPSG:4326", "EPSG:3857"])
@pytest.mark.parametrize("longitude_shear", [0, 0.2])
@pytest.mark.parametrize(
    ("west", "east", "expected"), [(179.5, 180, 179.25), (-180, -179.5, 179.75)]
)
def test_global_bilinear_samples_agree_across_longitude_encodings(
    tmp_path: Path,
    source_left: int,
    crs: str,
    west: float,
    east: float,
    expected: float,
    longitude_shear: float,
) -> None:
    """Use periodic neighbors in either longitude encoding, including sheared rows.

    Args:
        tmp_path: Original source and published calculator output directory.
        source_left: Equivalent longitude origin of the global input.
        crs: Geographic or projected output coordinate system.
        west: Western edge of the analysis area in degrees.
        east: Eastern edge of the analysis area in degrees.
        expected: Unshifted seam interpolation for the axis-aligned control.
        longitude_shear: Longitude displacement per source row.
    """
    values = (source_left + np.arange(360, dtype="int16")) % 360
    source = write_source(
        tmp_path / "source.tif",
        np.tile(values, (2, 1)),
        transform=Affine(1, longitude_shear, source_left, 0, -1, 2),
    )
    project = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    dx, top = project.transform(0.5, 2)
    left, _ = project.transform(west, 2)
    request = RasterCalculatorRequest(
        calculation=RasterFormulaInput(
            layers=(
                RasterFormulaLayer(alias="a", source=SOURCE, resampling="bilinear"),
            ),
            expression="a",
            grid=CustomRasterGrid(kind="custom", crs=crs, pixelSize=(dx, top / 2)),
        ),
        selectedBounds=Wgs84Bounds(west=west, south=0, east=east, north=2),
    )
    sources = RasterCalculatorSources({"a": source}, None)
    spec = plan_calculator_grid(
        sources, QueuedRasterCalculator(request=request, polygonArea=None)
    )
    result = calculate_raster(sources, spec, tmp_path, RasterAggregateLimits())
    assert result.valid_pixels == 2
    with rasterio.open(tmp_path / "result.tif") as output:
        assert output.transform.almost_equals(from_origin(left, top, dx, top / 2))
        if longitude_shear:
            rows, columns = np.indices(output.shape, dtype="float64") + 0.5
            lon, lat = Transformer.from_crs(crs, 4326, always_xy=True).transform(
                output.transform.c + columns * output.transform.a,
                output.transform.f + rows * output.transform.e,
            )
            source_x = lon - (2 - lat) * longitude_shear
            expected_values = np.interp(
                source_x, source_left + np.arange(360) + 0.5, values, period=360
            )
        else:
            expected_values = [[expected], [expected]]
        np.testing.assert_allclose(output.read(1), expected_values, rtol=0, atol=1e-7)


@pytest.mark.parametrize("method", ["nearest", "bilinear", "mean"])
def test_disconnected_area_can_have_an_unprojectable_grid_center(
    tmp_path: Path, method: str
) -> None:
    """Publish both valid projection lobes although their envelope center is a gap.

    Args:
        tmp_path: Original sources, selected vector and calculator output directory.
        method: Native resampler used for the constant global input.
    """
    source = write_source(
        tmp_path / "source.tif",
        np.full((180, 360), 7, dtype="uint8"),
        transform=from_origin(-180, 90, 1, 1),
    )
    reference = write_source(
        tmp_path / "reference.tif",
        np.ones((30, 830), dtype="uint8"),
        transform=from_origin(-8300000, 7600000, 10000, 10000),
        crs="ESRI:54052",
    )
    original = MultiPolygon(
        [box(-41.3, 69.8, -40.7, 70.2), box(-39.3, 69.8, -38.7, 70.2)]
    )
    area = write_selection(tmp_path / "lobes.gpkg", [mapping(original)])
    request = RasterCalculatorRequest(
        calculation=RasterFormulaInput(
            layers=(
                RasterFormulaLayer(alias="a", source=SOURCE, resampling=method),
                RasterFormulaLayer(alias="b", source=SOURCE, resampling="nearest"),
            ),
            expression="a",
            grid=MatchRasterGrid(kind="match", alias="b"),
        ),
        catalogSelection=area.selection,
    )
    sources = RasterCalculatorSources({"a": source, "b": reference}, area)
    plan = plan_calculator_grid(
        sources, QueuedRasterCalculator(request=request, polygonArea=None)
    )
    result = calculate_raster(sources, plan, tmp_path, RasterAggregateLimits())
    with rasterio.open(tmp_path / "result.tif") as output:
        rows, columns = np.indices(output.shape, dtype="float64") + 0.5
        x = output.transform.c + columns * output.transform.a
        y = output.transform.f + rows * output.transform.e
        inverse = Transformer.from_crs(output.crs, 4326, always_xy=True)
        lon, lat = inverse.transform(x, y)
        back_x, back_y = Transformer.from_crs(
            4326, output.crs, always_xy=True
        ).transform(lon, lat)
        # Some inverse coordinates in the interrupted gaps map to another lobe.
        inside = (
            contains_xy(original, lon, lat)
            & np.isclose(back_x, x, rtol=0, atol=0.01)
            & np.isclose(back_y, y, rtol=0, atol=0.01)
        )
        assert not np.isfinite(
            inverse.transform(
                *(output.transform * (output.width / 2, output.height / 2))
            )
        ).all()
        assert result.valid_pixels == inside.sum() == 18
        np.testing.assert_allclose(output.read(1), np.where(inside, 7, np.nan))


@pytest.mark.parametrize("source_left", [0, -180])
@pytest.mark.parametrize("columns", [1, 505])
@pytest.mark.parametrize("y_size", [35000, 97517.9])
@pytest.mark.parametrize("epsg", [4326, 4807])
def test_bilinear_values_do_not_depend_on_aoi_width(
    tmp_path: Path, source_left: int, columns: int, y_size: float, epsg: int
) -> None:
    """Keep global bilinear samples stable across source encodings and AOI widths.

    Args:
        tmp_path: Input rasters and published calculator output directory.
        source_left: Equivalent longitude origin of the full-period source.
        columns: Narrow or nearly full-world selection on the same output grid.
        y_size: Output Y resolution, upsampling or downsampling the source rows.
        epsg: Source CRS, including grads and the Paris prime meridian.
    """
    crs = CRS.from_epsg(epsg)
    degrees_to_units = math.radians(1) / crs.units_factor[1]
    values = ((np.arange(360) * 153 + 79) % 360) // 9
    source = write_source(
        tmp_path / "source.tif",
        np.tile(np.roll(values, -source_left), (9, 1)).astype("uint8"),
        transform=from_origin(
            source_left * degrees_to_units,
            2.93 * degrees_to_units,
            degrees_to_units,
            0.5 * degrees_to_units,
        ),
        crs=crs.to_wkt(),
    )
    axes = from_origin(-20037508.0, 291588.7, 79235.0, y_size)
    reference = write_source(
        tmp_path / "reference.tif",
        np.ones((4, 505), dtype="uint8"),
        transform=axes,
        crs="EPSG:3857",
    )
    to_geographic = Transformer.from_crs(3857, 4326, always_xy=True)
    west, south = to_geographic.transform(axes.c, axes.f + 4 * axes.e)
    east, north = to_geographic.transform(axes.c + columns * axes.a, axes.f)
    request = RasterCalculatorRequest(
        calculation=RasterFormulaInput(
            layers=(
                RasterFormulaLayer(alias="a", source=SOURCE, resampling="bilinear"),
                RasterFormulaLayer(alias="b", source=SOURCE, resampling="nearest"),
            ),
            expression="a",
            grid=MatchRasterGrid(kind="match", alias="b"),
        ),
        selectedBounds=Wgs84Bounds(west=west, south=south, east=east, north=north),
    )
    sources = RasterCalculatorSources({"a": source, "b": reference}, None)
    spec = plan_calculator_grid(
        sources, QueuedRasterCalculator(request=request, polygonArea=None)
    )
    result = calculate_raster(sources, spec, tmp_path, RasterAggregateLimits())
    with rasterio.open(tmp_path / "result.tif") as output:
        rows, cells = np.indices((4, columns), dtype="float64") + 0.5
        lon, _ = Transformer.from_crs(3857, crs, always_xy=True).transform(
            axes.c + cells * axes.a, axes.f + rows * axes.e
        )
        # Values are constant in Y; X is upsampled, so periodic 1D interpolation
        # independently gives every cell, including the antimeridian neighbor.
        expected = np.interp(
            lon / degrees_to_units, np.arange(360) + 0.5, values, period=360
        )
        assert output.transform == axes
        assert output.shape == (4, columns)
        assert result.valid_pixels == 4 * columns
        np.testing.assert_allclose(output.read(1), expected, rtol=0, atol=1e-9)


@pytest.mark.parametrize("crs", ["EPSG:4326", "EPSG:3857"])
def test_regional_longitudes_keep_a_fractional_cell_size(
    tmp_path: Path, crs: str
) -> None:
    """Read a shifted regional source whose pixels do not divide a full period."""
    source = write_source(
        tmp_path / "source.tif",
        np.tile(np.arange(100, 110, dtype="int16"), (2, 1)),
        transform=from_origin(350, 1, 0.7, 0.5),
    )
    dx, top = Transformer.from_crs("EPSG:4326", crs, always_xy=True).transform(0.7, 1)
    request = RasterCalculatorRequest(
        calculation=RasterFormulaInput(
            layers=(
                RasterFormulaLayer(alias="a", source=SOURCE, resampling="nearest"),
            ),
            expression="a",
            grid=CustomRasterGrid(kind="custom", crs=crs, pixelSize=(dx, top / 2)),
        ),
        selectedBounds=Wgs84Bounds(west=-9.8, south=0, east=-7.7, north=1),
    )
    sources = RasterCalculatorSources({"a": source}, None)
    spec = plan_calculator_grid(
        sources, QueuedRasterCalculator(request=request, polygonArea=None)
    )
    result = calculate_raster(sources, spec, tmp_path, RasterAggregateLimits())
    assert result.valid_pixels == 6
    with rasterio.open(tmp_path / "result.tif") as output:
        np.testing.assert_array_equal(
            output.read(1), [[100, 101, 102], [100, 101, 102]]
        )


@pytest.mark.parametrize(
    "crs,pixel_size", [("EPSG:4326", (0.05, 0.08)), ("EPSG:3857", (8000, 8000))]
)
@pytest.mark.parametrize(
    "axes,extent,shape",
    [
        (
            Affine(0.137, 0.038, -0.63, 0.064, -0.21, 1.36),
            (-0.55, 0.32, 0.53, 1.27),
            (6, 9),
        ),
        (Affine(-1, 0, -178, 0, -1, 2), (-179.99, 1.01, -178.01, 1.99), (4, 4)),
    ],
    ids=["rotated", "west-going"],
)
def test_regional_wrap_preserves_affine_samples(
    tmp_path: Path,
    crs: str,
    pixel_size: tuple[float, float],
    axes: Affine,
    extent: tuple[float, float, float, float],
    shape: tuple[int, int],
) -> None:
    """Read rotated and reversed longitude grids at independently located centers.

    Args:
        tmp_path: Original source and calculator output directory.
        crs: Geographic or projected output coordinate system.
        pixel_size: Output X/Y spacing in that coordinate system.
        axes: Canonical source transform before shifting it one full turn.
        extent: Selected geographic bounds inside the original coverage.
        shape: Source rows and columns.
    """
    values = np.arange(np.prod(shape), dtype="int16").reshape(shape)
    values[1, 3] = -9999
    shifted = Affine(axes.a, axes.b, axes.c + 360, axes.d, axes.e, axes.f)
    source = write_source(
        tmp_path / "source.tif", values, nodata=-9999, transform=shifted
    )
    request = RasterCalculatorRequest(
        calculation=RasterFormulaInput(
            layers=(
                RasterFormulaLayer(alias="a", source=SOURCE, resampling="nearest"),
            ),
            expression="a",
            grid=CustomRasterGrid(kind="custom", crs=crs, pixelSize=pixel_size),
        ),
        selectedBounds=Wgs84Bounds.model_validate(
            dict(zip(("west", "south", "east", "north"), extent, strict=True))
        ),
    )
    sources = RasterCalculatorSources({"a": source}, None)
    plan = plan_calculator_grid(
        sources, QueuedRasterCalculator(request=request, polygonArea=None)
    )
    result = calculate_raster(sources, plan, tmp_path, RasterAggregateLimits())
    with rasterio.open(tmp_path / "result.tif") as output:
        rows, columns = np.indices(output.shape, dtype="float64") + 0.5
        lon, lat = Transformer.from_crs(crs, "EPSG:4326", always_xy=True).transform(
            output.transform.c + columns * output.transform.a,
            output.transform.f + rows * output.transform.e,
        )
        source_columns, source_rows = ~axes * (lon, lat)
        source_columns, source_rows = np.floor(source_columns).astype(int), np.floor(
            source_rows
        ).astype(int)
        west, south, east, north = extent
        inside = (west < lon) & (lon < east) & (south < lat) & (lat < north)
        inside &= (
            (source_columns >= 0)
            & (source_columns < shape[1])
            & (source_rows >= 0)
            & (source_rows < shape[0])
        )
        expected = np.full(output.shape, np.nan)
        expected[inside] = values[source_rows[inside], source_columns[inside]]
        expected[expected == -9999] = np.nan
        assert result.valid_pixels == np.isfinite(expected).sum() > 0
        np.testing.assert_array_equal(output.read(1), expected)


def test_regional_longitudes_do_not_pad_to_a_world_grid(tmp_path: Path) -> None:
    """Warp a six-column raster near 180° without large virtual column offsets."""
    west = 180 - 3e-7
    source = write_source(
        tmp_path / "source.tif",
        np.tile(np.arange(1, 7, dtype="uint8"), (4, 1)),
        transform=from_origin(west, 10, 1e-7, 1e-7),
    )
    request = RasterCalculatorRequest(
        calculation=RasterFormulaInput(
            layers=(
                RasterFormulaLayer(alias="a", source=SOURCE, resampling="nearest"),
            ),
            expression="a",
            grid=MatchRasterGrid(kind="match", alias="a"),
        ),
        selectedBounds=Wgs84Bounds(west=west, south=10 - 4e-7, east=180, north=10),
    )
    sources = RasterCalculatorSources({"a": source}, None)
    spec = plan_calculator_grid(
        sources, QueuedRasterCalculator(request=request, polygonArea=None)
    )
    result = calculate_raster(sources, spec, tmp_path, RasterAggregateLimits())
    assert result.valid_pixels == 12
    with rasterio.open(tmp_path / "result.tif") as output:
        assert output.transform == from_origin(west, 10, 1e-7, 1e-7)
        np.testing.assert_array_equal(output.read(1), [[1, 2, 3, np.nan]] * 4)


@pytest.mark.parametrize(
    ("east", "expected"),
    [(-2, [356, 357]), (4, [356, 357, 358, 359, 0, 1, 2, 3])],
)
def test_match_grid_reads_wrapped_longitudes(
    tmp_path: Path, east: int, expected: list[int]
) -> None:
    """Find western cell values on a global raster that starts at Greenwich."""
    source = write_source(
        tmp_path / "source.tif",
        np.arange(360, dtype="int16").reshape(1, 360),
        transform=from_origin(0, 1, 1, 1),
    )
    request = RasterCalculatorRequest(
        calculation=RasterFormulaInput(
            layers=(
                RasterFormulaLayer(alias="a", source=SOURCE, resampling="nearest"),
            ),
            expression="a",
            grid=MatchRasterGrid(kind="match", alias="a"),
        ),
        selectedBounds=Wgs84Bounds(west=-4, south=0, east=east, north=1),
    )
    sources = RasterCalculatorSources({"a": source}, None)
    plan = plan_calculator_grid(
        sources, QueuedRasterCalculator(request=request, polygonArea=None)
    )
    result = calculate_raster(sources, plan, tmp_path, RasterAggregateLimits())
    assert result.valid_pixels == len(expected)
    with rasterio.open(tmp_path / "result.tif") as output:
        assert output.transform == from_origin(-4, 1, 1, 1)
        np.testing.assert_array_equal(output.read(1), [expected])


@pytest.mark.parametrize("method", ["bilinear", "mean"])
def test_warp_uses_native_neighbours_across_greenwich(
    tmp_path: Path, method: str
) -> None:
    """Interpolate with native source values on both sides of the longitude seam."""
    source = write_source(
        tmp_path / "source.tif",
        np.tile(np.arange(360, dtype="int16"), (2, 1)),
        transform=from_origin(0, 2, 1, 1),
    )
    reference = write_source(
        tmp_path / "reference.tif",
        np.zeros((2, 1), dtype="uint8"),
        transform=from_origin(-0.5, 2, 1, 1),
    )
    request = RasterCalculatorRequest(
        calculation=RasterFormulaInput.model_validate(
            {
                "layers": [
                    {"alias": "a", "source": SOURCE, "resampling": method},
                    {"alias": "b", "source": SOURCE, "resampling": "nearest"},
                ],
                "expression": "a",
                "grid": {"kind": "match", "alias": "b"},
            }
        ),
        selectedBounds=Wgs84Bounds(west=-0.5, south=0, east=0.5, north=2),
    )
    sources = RasterCalculatorSources({"a": source, "b": reference}, None)
    plan = plan_calculator_grid(
        sources, QueuedRasterCalculator(request=request, polygonArea=None)
    )
    calculate_raster(sources, plan, tmp_path, RasterAggregateLimits())
    with rasterio.open(tmp_path / "result.tif") as output:
        np.testing.assert_array_equal(output.read(1), [[179.5], [179.5]])


@pytest.mark.parametrize("source_left", [0, -180])
@pytest.mark.parametrize("epsg", [4326, 3857])
@pytest.mark.parametrize(
    "method,expected", [("mean", 57.2), ("min", 20), ("max", 80), ("mode", 80)]
)
def test_aggregate_cell_crossing_dateline_uses_only_adjacent_values(
    tmp_path: Path, source_left: int, epsg: int, method: str, expected: float
) -> None:
    """Aggregate the cell footprint across the seam without distant longitudes.

    Args:
        tmp_path: Original inputs and published calculator output directory.
        source_left: Equivalent longitude origin of the full-period input.
        epsg: Geographic or projected reference grid.
        method: Requested aggregate resampling method.
        expected: Independently weighted mean or selected adjacent value.
    """
    values = np.full(360, 40, dtype="int16")
    values[178:180] = 80
    values[180:182] = [20, 50]
    values[5], values[100] = 999, 1
    source = write_source(
        tmp_path / "source.tif",
        np.tile(np.roll(values, -source_left), (8, 1)),
        transform=from_origin(source_left, 2, 1, 0.5),
    )
    project = Transformer.from_crs(4326, epsg, always_xy=True)
    left, top = project.transform(178.76, 0.9)
    _, bottom = project.transform(178.76, 0.5)
    # Web Mercator has a continuous X spacing even beyond its canonical seam.
    cell_width = 2 * (math.pi * 6378137 / 180 if epsg == 3857 else 1)
    axes = from_origin(left, top, cell_width, top - bottom)
    reference = write_source(
        tmp_path / "reference.tif",
        np.ones((1, 1), dtype="uint8"),
        transform=axes,
        crs=f"EPSG:{epsg}",
    )
    request = RasterCalculatorRequest(
        calculation=RasterFormulaInput(
            layers=(
                RasterFormulaLayer(alias="a", source=SOURCE, resampling=method),
                RasterFormulaLayer(alias="b", source=SOURCE, resampling="nearest"),
            ),
            expression="a",
            grid=MatchRasterGrid(kind="match", alias="b"),
        ),
        selectedBounds=Wgs84Bounds(west=178.8, south=0.5, east=180, north=0.9),
    )
    sources = RasterCalculatorSources({"a": source, "b": reference}, None)
    plan = plan_calculator_grid(
        sources, QueuedRasterCalculator(request=request, polygonArea=None)
    )
    result = calculate_raster(sources, plan, tmp_path, RasterAggregateLimits())
    with rasterio.open(tmp_path / "result.tif") as output:
        assert output.transform == axes
        assert result.valid_pixels == 1
        # 1.24 degrees of value 80 and 0.76 degrees of value 20 give mean 57.2.
        np.testing.assert_allclose(output.read(1), [[expected]], rtol=0, atol=1e-9)


@pytest.mark.parametrize("epsg", [4269, 4979])
@pytest.mark.parametrize("area_kind", ["bounds", "mercator"])
def test_geographic_projection_preserves_wide_bounds(
    tmp_path: Path, epsg: int, area_kind: str
) -> None:
    """Keep a wide nonwrapping selection instead of its narrow dateline complement.

    Args:
        tmp_path: Source raster and calculator output directory.
        epsg: Geographic target distinct from the source's two-dimensional WGS84.
        area_kind: WGS84 bounds or the same straight-edged area in Web Mercator.
    """
    source = write_source(
        tmp_path / "source.tif",
        np.tile(np.arange(1, 361, dtype="int16"), (8, 1)),
        transform=from_origin(-180, 4, 1, 1),
    )
    selected_bounds = Wgs84Bounds(west=-179, south=-1.99, east=179, north=2.99)
    area = (
        None
        if area_kind == "bounds"
        else write_selection(
            tmp_path / "area.gpkg",
            [
                mapping(
                    box(
                        *transform_bounds(
                            "EPSG:4326", "EPSG:3857", *selected_bounds.canonical_tuple()
                        )
                    )
                )
            ],
            crs="EPSG:3857",
        )
    )
    request = RasterCalculatorRequest(
        calculation=RasterFormulaInput(
            layers=(
                RasterFormulaLayer(alias="a", source=SOURCE, resampling="nearest"),
            ),
            expression="a",
            grid=CustomRasterGrid(kind="custom", crs=f"EPSG:{epsg}", pixelSize=(1, 1)),
        ),
        selectedBounds=selected_bounds if area is None else None,
        catalogSelection=area.selection if area is not None else None,
    )
    sources = RasterCalculatorSources({"a": source}, area)
    plan = plan_calculator_grid(
        sources, QueuedRasterCalculator(request=request, polygonArea=None)
    )
    result = calculate_raster(sources, plan, tmp_path, RasterAggregateLimits())
    assert result.valid_pixels == 1790
    with rasterio.open(tmp_path / "result.tif") as output:
        assert output.transform == from_origin(-179, 3, 1, 1)
        assert output.crs == CRS.from_epsg(epsg)
        np.testing.assert_array_equal(
            output.read(1), np.tile(np.arange(2, 360), (5, 1))
        )


def test_custom_grid_accepts_equivalent_crs_in_published_tiff(tmp_path: Path) -> None:
    """Publish a NAD83 grid after GDAL normalizes its stored CRS definition."""
    source = write_source(
        tmp_path / "source.tif",
        np.ones((10, 10), dtype="uint8"),
        transform=from_origin(-124, 46, 0.1, 0.1),
    )
    request = RasterCalculatorRequest(
        calculation=RasterFormulaInput(
            layers=(
                RasterFormulaLayer(alias="a", source=SOURCE, resampling="nearest"),
            ),
            expression="a",
            grid=CustomRasterGrid(
                kind="custom", crs="EPSG:4269", pixelSize=(0.25, 0.25)
            ),
        ),
        selectedBounds=Wgs84Bounds(west=-124, south=45, east=-123, north=46),
    )
    sources = RasterCalculatorSources({"a": source}, None)
    plan = plan_calculator_grid(
        sources, QueuedRasterCalculator(request=request, polygonArea=None)
    )
    result = calculate_raster(sources, plan, tmp_path, RasterAggregateLimits())
    assert result.valid_pixels == 16
    with rasterio.open(tmp_path / "result.tif") as output:
        assert output.crs == CRS.from_epsg(4269)
        assert output.transform == from_origin(-124, 46, 0.25, 0.25)
        np.testing.assert_array_equal(output.read(1), np.ones((4, 4)))


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
    assert not list(tmp_path.rglob("*.vrt"))
    assert not list(tmp_path.rglob("polygon-mask.tif"))
