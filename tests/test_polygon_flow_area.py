"""Check polygon flow masks against independently specified drainage paths."""

from importlib.metadata import version
import json
from pathlib import Path

import fiona
import numpy
import pytest
import rasterio
from numpy.typing import NDArray
from pyproj import Transformer
from rasterio.transform import Affine
from rasterio.transform import from_origin
from shapely import contains_xy, segmentize
from shapely.geometry import Polygon, box, mapping
from shapely.ops import transform as transform_geometry

from catalog_selection_support import write_selection
from eolab_app.catalog_selection import CatalogSelection, ResolvedCatalogSelection
from eolab_app.processing.aggregate_models import RasterAggregateLimits
from eolab_app.processing.d8 import build_d8_flow_graph
from eolab_app.processing.flow_area import (
    FlowAreaInputs,
    FlowAreaPlan,
    calculate_flow_area,
    plan_flow_grid,
)
from eolab_app.processing.models import ProcessingError
from raster_source_support import SOURCE


def _trace_both_directions(
    directory: Path,
    elevations: NDArray[numpy.int16],
    transform: Affine,
    crs: str,
    selection: ResolvedCatalogSelection,
) -> NDArray[numpy.uint8]:
    """Write a DEM and read the published flow mask for a catalog selection.

    Args:
        directory: Disposable source and calculation directory.
        elevations: Native DEM cells, with -9999 marking missing values.
        transform: Pixel-to-map transform of the DEM.
        crs: Coordinate reference system for the DEM.
        selection: Authorized original polygon layer.

    Returns:
        Published upstream and downstream mask with the polygon cells excluded.
    """
    dem = directory / "dem.tif"
    with rasterio.open(
        dem,
        "w",
        driver="GTiff",
        height=elevations.shape[0],
        width=elevations.shape[1],
        count=1,
        dtype=elevations.dtype,
        crs=crs,
        transform=transform,
        nodata=-9999,
    ) as dataset:
        dataset.write(elevations, 1)
    plan = FlowAreaPlan(
        inputs=FlowAreaInputs(
            dem=SOURCE, polygon=selection.selection, upstream=True, downstream=True
        ),
        grid=plan_flow_grid(dem),
    )
    attempt = directory / "attempt"
    attempt.mkdir()
    calculate_flow_area((dem, selection), plan, attempt, RasterAggregateLimits())
    with rasterio.open(attempt / "result.tif") as result:
        return result.read(1)


@pytest.mark.parametrize(
    "subdivide", [False, True], ids=["four-corners", "5km-vertices"]
)
def test_flow_mask_preserves_projected_source_edges(
    tmp_path: Path, subdivide: bool
) -> None:
    """Trace the same polar rectangle with or without intermediate vertices.

    Args:
        tmp_path: Directory for the native GeoPackage, DEM and result.
        subdivide: Add collinear vertices every five kilometres to the rectangle.
    """
    crs = "EPSG:3413"
    rectangle = box(-300000, -1300000, 300000, -1100000)
    geometry = segmentize(rectangle, 5000) if subdivide else rectangle
    selection = write_selection(tmp_path / "polar.gpkg", [mapping(geometry)], crs=crs)
    elevations = numpy.full((56, 80), -9999, dtype="int16")
    elevations[::2] = numpy.arange(79, -1, -1)
    result = _trace_both_directions(
        tmp_path,
        elevations,
        from_origin(-400000, -900000, 10000, 10000),
        crs,
        selection,
    )
    expected = numpy.where(elevations == -9999, 255, 0).astype("uint8")
    expected[20:40:2, :10] = 1
    expected[20:40:2, 70:] = 1
    numpy.testing.assert_array_equal(result, expected)


@pytest.mark.parametrize(
    ("polygon", "vector_crs", "dem_crs", "grid", "shape"),
    [
        pytest.param(
            box(
                *Transformer.from_crs(4326, 3832, always_xy=True).transform(178, 10),
                *Transformer.from_crs(4326, 3832, always_xy=True).transform(-178, 14),
            ),
            "EPSG:3832",
            "EPSG:3857",
            from_origin(
                -20037508.342789244, 1550000, 111319.49079327358, 111319.49079327358
            ),
            (3, 360),
            id="projected-dateline",
        ),
        pytest.param(
            box(-1e6, -1e6, 1e6, 1e6),
            "EPSG:3413",
            "EPSG:4326",
            from_origin(-180, 90, 1, 1),
            (20, 360),
            id="polar-cap",
        ),
        pytest.param(
            Polygon(
                box(-1e6, -1e6, 1e6, 1e6).exterior.coords,
                [box(-4e5, -4e5, 4e5, 4e5).exterior.coords],
            ),
            "EPSG:3413",
            "EPSG:4326",
            from_origin(-180, 90, 1, 1),
            (20, 360),
            id="polar-hole",
        ),
    ],
)
def test_projected_flow_seeds_match_original_polygon(
    tmp_path: Path,
    polygon: Polygon,
    vector_crs: str,
    dem_crs: str,
    grid: Affine,
    shape: tuple[int, int],
) -> None:
    """Compare published paths with native polygon membership on isolated drainage rows.

    Args:
        tmp_path: Private directory for the GeoPackage, DEM and output.
        polygon: Original polygon with straight edges in its source CRS.
        vector_crs: Coordinate system of the selected vector.
        dem_crs: Coordinate system of the DEM.
        grid: Pixel-to-map transform.
        shape: Native row and column counts.
    """
    selection = write_selection(
        tmp_path / "sites.gpkg", [mapping(polygon)], crs=vector_crs
    )
    elevations = numpy.full(shape, -9999, dtype="int16")
    elevations[::2] = numpy.arange(shape[1] - 1, -1, -1)
    rows, cols = numpy.indices(shape, dtype="float64") + 0.5
    x, y = grid * (cols, rows)
    vx, vy = Transformer.from_crs(dem_crs, vector_crs, always_xy=True).transform(x, y)
    seeds = contains_xy(polygon, vx, vy) & (elevations != -9999)
    expected = numpy.where(
        elevations == -9999, 255, seeds.any(axis=1)[:, None] & ~seeds
    ).astype("uint8")
    result = _trace_both_directions(tmp_path, elevations, grid, dem_crs, selection)
    numpy.testing.assert_array_equal(result, expected)


@pytest.mark.parametrize(
    ("crs", "west"),
    [("EPSG:4326", -4), ("+proj=longlat +datum=WGS84 +pm=180 +type=crs", 176)],
    ids=["greenwich", "shifted-prime-meridian"],
)
@pytest.mark.parametrize("shape", ["small", "with-hole", "wide"])
@pytest.mark.parametrize("vector_crs", ["EPSG:4326", "EPSG:3857"])
def test_flow_mask_crosses_the_native_longitude_seam(
    tmp_path: Path, crs: str, west: int, shape: str, vector_crs: str
) -> None:
    """Keep polygon interiors and holes on equivalent geographic grids.

    Args:
        tmp_path: Directory for the original vector, DEM and mask.
        crs: Greenwich or Pacific prime meridian.
        west: Left grid edge in native degrees.
        shape: Boundary and expected membership on the valid drainage row.
        vector_crs: Original coordinate system of the same rectangular polygon.
    """
    geometry, expected_row = {
        "small": (box(-1.8, 1.2, 1.8, 1.8), [1, 1, 0, 0, 0, 0, 1, 1]),
        "with-hole": (
            Polygon(
                box(-2.8, 1.1, 2.8, 1.9).exterior.coords,
                [box(-0.8, 1.2, 0.8, 1.8).exterior.coords],
            ),
            [1, 0, 0, 1, 1, 0, 0, 1],
        ),
        "wide": (box(-178, 1.2, 178, 1.8), [0] * 8),
    }[shape]
    projected = transform_geometry(
        Transformer.from_crs("EPSG:4326", vector_crs, always_xy=True).transform,
        geometry,
    )
    selection = write_selection(
        tmp_path / "greenwich.gpkg", [mapping(projected)], crs=vector_crs
    )
    elevations = numpy.full((3, 8), -9999, dtype="int16")
    elevations[1] = numpy.arange(7, -1, -1)
    result = _trace_both_directions(
        tmp_path, elevations, from_origin(west, 3, 1, 1), crs, selection
    )
    numpy.testing.assert_array_equal(result, [[255] * 8, expected_row, [255] * 8])


@pytest.fixture(
    params=(
        ("float64", 0, 1),
        ("float32", 0, 1),
        ("float32", 178, 1),
        ("float32", -182, 1),
        ("float64", 356, 1),
        ("float32", 0, -0.5),
        ("float32", 0, 0),
    ),
    ids=(
        "float64",
        "float32",
        "east-of-dateline",
        "west-of-dateline",
        "positive-longitudes",
        "negative-scale",
        "zero-scale",
    ),
)
def drainage_corridor(
    tmp_path: Path, request: pytest.FixtureRequest
) -> tuple[Path, ResolvedCatalogSelection]:
    """Write a descending corridor, disjoint rows and a filtered polygon layer.

    Args:
        tmp_path: Disposable directory for admitted native inputs.
        request: Supplies the storage type, western longitude and band scale.

    Returns:
        Isolated rows draining east, or flat for a zero scale, with a middle-row seed.
    """
    dtype, west, scale = request.param
    chosen_longitude = (west + 3.5 + 180) % 360 - 180
    other_longitude = (west + 2.5 + 180) % 360 - 180
    dem = tmp_path / "elevation.tif"
    elevations = numpy.full((5, 7), -9999, dtype=dtype)
    elevations[::2] = numpy.arange(12, -1, -2) / (scale or 1)
    elevations[1, :3] = [numpy.nan, numpy.inf, 100]
    mask = numpy.full(elevations.shape, 255, dtype="uint8")
    mask[1, 2] = 0
    with (
        rasterio.Env(GDAL_TIFF_INTERNAL_MASK=True),
        rasterio.open(
            dem,
            "w",
            driver="GTiff",
            width=7,
            height=5,
            count=1,
            dtype=elevations.dtype,
            crs="EPSG:4326",
            transform=from_origin(west, 5, 1, 1),
            nodata=-9999,
        ) as dataset,
    ):
        dataset.write(elevations, 1)
        dataset.scales = (scale,)
        dataset.offsets = (100,)
        dataset.write_mask(mask)

    vector = tmp_path / "sites.gpkg"
    with fiona.open(
        vector,
        "w",
        driver="GPKG",
        layer="sites",
        crs="EPSG:4326",
        schema={"geometry": "Polygon", "properties": {"site": "str"}},
    ) as layer:
        layer.write(
            {
                "geometry": mapping(
                    box(chosen_longitude - 0.3, 2.2, chosen_longitude + 0.3, 3.8)
                ),
                "properties": {"site": "chosen"},
            }
        )
        layer.write(
            {
                "geometry": mapping(
                    box(other_longitude - 0.3, 4.2, other_longitude + 0.3, 4.8)
                ),
                "properties": {"site": "other"},
            }
        )
    selection = CatalogSelection.model_validate(
        {
            "collectionId": "eolab-mounted-vectors",
            "itemId": "drainage-sites",
            "assetKey": "data",
            "layerName": "sites",
            "filter": {
                "enabled": True,
                "match": "all",
                "rules": [
                    {"field": "site", "operator": "eq", "value": "chosen"},
                ],
            },
        }
    )
    return dem, ResolvedCatalogSelection(
        selection, vector, "GPKG", "\"site\" = 'chosen'"
    )


@pytest.mark.parametrize(
    ("upstream", "downstream", "expected_corridor"),
    [
        (True, False, [1, 1, 1, 0, 0, 0, 0]),
        (False, True, [0, 0, 0, 0, 1, 1, 1]),
        (True, True, [1, 1, 1, 0, 1, 1, 1]),
    ],
)
def test_flow_mask_counts_connected_cells_outside_selected_polygon(
    tmp_path: Path,
    drainage_corridor: tuple[Path, ResolvedCatalogSelection],
    upstream: bool,
    downstream: bool,
    expected_corridor: list[int],
) -> None:
    """Keep valid zeros, exclude seeds and preserve missing DEM cells in each mode.

    Args:
        tmp_path: Disposable run directory parent.
        drainage_corridor: Real DEM and original filtered vector.
        upstream: Whether to include cells draining into the polygon.
        downstream: Whether to mark flow paths leaving the polygon.
        expected_corridor: Expected output in the test's single selected drainage row.
    """
    dem, selection = drainage_corridor
    inputs = FlowAreaInputs(
        dem=SOURCE,
        polygon=selection.selection,
        upstream=upstream,
        downstream=downstream,
    )
    plan = FlowAreaPlan(inputs=inputs, grid=plan_flow_grid(dem))
    directory = tmp_path / "attempt"
    directory.mkdir()
    artifact = calculate_flow_area(
        (dem, selection), plan, directory, RasterAggregateLimits()
    )

    with (
        rasterio.open(dem) as original,
        rasterio.open(directory / "result.tif") as result,
    ):
        expected = numpy.full((5, 7), 255, dtype="uint8")
        expected[::2] = 0
        # PyFlwDir's deterministic flat row drains to the west edge.
        expected[2] = (
            expected_corridor[::-1] if original.scales[0] == 0 else expected_corridor
        )
        numpy.testing.assert_array_equal(result.read(1), expected)
        assert result.nodata == 255
        assert result.transform == original.transform
        assert result.crs.to_epsg() == 4326
        assert result.tags(ns="IMAGE_STRUCTURE")["LAYOUT"] == "COG"
    assert artifact.valid_pixels == 21
    provenance = json.loads((directory / "provenance.json").read_text(encoding="utf-8"))
    assert provenance["numericalPolicy"]["engine"] == "pyflwdir"
    assert provenance["numericalPolicy"]["engineVersion"] == version("pyflwdir")
    assert provenance["numericalPolicy"]["valueDomain"] == "physical_elevation_order"
    assert {path.name for path in directory.iterdir()} == {
        "provenance.json",
        "progress.json",
        "result.tif",
    }


@pytest.mark.parametrize(
    ("elevation_row", "direction", "expected"),
    [
        ([12, 10, 0, 6, 4, 2, 0], "upstream", [1, 1, 1, 0, 0, 0, 0]),
        ([12, 10, 8, 6, 6, 6, 0], "downstream", [0, 0, 0, 0, 1, 1, 1]),
    ],
    ids=("filled-depression", "flat-toward-outlet"),
)
@pytest.mark.parametrize(
    ("storage", "datum"),
    [(None, 0), ("int32", 2**30), ("float64", 2**45)],
    ids=["native", "int32-high-datum", "float64-high-datum"],
)
def test_flow_traces_across_an_interior_depression_or_flat(
    tmp_path: Path,
    drainage_corridor: tuple[Path, ResolvedCatalogSelection],
    elevation_row: list[int],
    direction: str,
    expected: list[int],
    storage: str | None,
    datum: int,
) -> None:
    """Reach an outlet across a filled depression or a flat in a single valley.

    Args:
        tmp_path: Disposable source and run directory parent.
        drainage_corridor: Supplies the original selected polygon on the middle row.
        elevation_row: The valley floor, draining toward its low east edge.
        direction: Direction to trace from the selected middle cell.
        expected: Exact mask values along the valley.
        storage: Override the fixture band type for high-precision encodings.
        datum: Uniform elevation offset that must preserve the drainage path.
    """
    original_dem, selection = drainage_corridor
    dem = tmp_path / "valley.tif"
    elevations = numpy.full((5, 7), 100, dtype="float64")
    elevations[2] = elevation_row
    elevations += datum
    with rasterio.open(original_dem) as original:
        profile = original.profile
        if storage is not None:
            profile.update(dtype=storage)
        with rasterio.open(dem, "w", **profile) as dataset:
            dataset.write(elevations, 1)
    inputs = FlowAreaInputs(
        dem=SOURCE,
        polygon=selection.selection,
        upstream=direction == "upstream",
        downstream=direction == "downstream",
    )
    plan = FlowAreaPlan(inputs=inputs, grid=plan_flow_grid(dem))
    directory = tmp_path / "attempt"
    directory.mkdir()
    calculate_flow_area((dem, selection), plan, directory, RasterAggregateLimits())
    with rasterio.open(directory / "result.tif") as result:
        numpy.testing.assert_array_equal(result.read(1)[2], expected)


def test_float32_depression_keeps_the_stock_outlet_path() -> None:
    """Follow the stock Float32 spill path across two equal-height outlets."""
    spill = 7.293817
    elevations = numpy.array(
        [
            [30, 30, 30, 30],
            [spill, 0, 2.1081684, 30],
            [30, 0, 0, spill],
            [30, 30, 30, 30],
        ],
        dtype="float32",
    )
    graph = build_d8_flow_graph(elevations, from_origin(0, 4, 1, 1), latlon=False)
    paths, _ = graph.path(idxs=numpy.array([11]))
    numpy.testing.assert_array_equal(paths[0], [11, 10, 5, 4])


def test_flow_plan_rejects_nonsquare_cells(tmp_path: Path) -> None:
    """Report the routing grid constraint for an otherwise valid elevation raster.

    Args:
        tmp_path: Disposable source directory.
    """
    dem = tmp_path / "rectangular.tif"
    with rasterio.open(
        dem,
        "w",
        driver="GTiff",
        width=2,
        height=2,
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=from_origin(0, 5, 1, 2),
    ):
        pass
    with pytest.raises(ProcessingError, match="square DEM cells"):
        plan_flow_grid(dem)


@pytest.mark.parametrize(
    "upstream,downstream", [(True, False), (False, True), (True, True)]
)
def test_flow_mask_excludes_the_only_dem_cell(
    tmp_path: Path, upstream: bool, downstream: bool
) -> None:
    """Publish a zero mask when the selected cell is the entire elevation grid.

    Args:
        tmp_path: Disposable native source and output directory.
        upstream: Whether to trace cells draining into the polygon.
        downstream: Whether to trace paths leaving the polygon.
    """
    dem = tmp_path / "one-cell.tif"
    transform = from_origin(0, 1, 1, 1)
    with rasterio.open(
        dem,
        "w",
        driver="GTiff",
        width=1,
        height=1,
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=transform,
    ) as dataset:
        dataset.write(numpy.array([[100]], dtype="float32"), 1)
    selection = write_selection(
        tmp_path / "site.gpkg", [mapping(box(0.2, 0.2, 0.8, 0.8))]
    )
    plan = FlowAreaPlan(
        inputs=FlowAreaInputs(
            dem=SOURCE,
            polygon=selection.selection,
            upstream=upstream,
            downstream=downstream,
        ),
        grid=plan_flow_grid(dem),
    )
    directory = tmp_path / "attempt"
    directory.mkdir()
    artifact = calculate_flow_area(
        (dem, selection), plan, directory, RasterAggregateLimits()
    )
    with rasterio.open(directory / "result.tif") as result:
        numpy.testing.assert_array_equal(result.read(1), [[0]])
        assert result.transform == transform
        assert result.crs.to_epsg() == 4326
        assert result.nodata == 255
        assert result.tags(ns="IMAGE_STRUCTURE")["LAYOUT"] == "COG"
    assert artifact.valid_pixels == 1
