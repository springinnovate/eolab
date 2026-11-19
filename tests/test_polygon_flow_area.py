"""Check polygon flow masks against independently specified drainage paths."""

from pathlib import Path

import fiona
import numpy
import pytest
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import box, mapping

from eolab_app.catalog_selection import CatalogSelection, ResolvedCatalogSelection
from eolab_app.processing.aggregate_models import RasterAggregateLimits
from eolab_app.processing.flow_area import (
    FlowAreaInputs,
    FlowAreaPlan,
    calculate_flow_area,
    plan_flow_grid,
)
from eolab_app.processing.models import ProcessingError
from raster_source_support import SOURCE


@pytest.fixture
def drainage_corridor(tmp_path: Path) -> tuple[Path, ResolvedCatalogSelection]:
    """Write a descending corridor, disjoint rows and a filtered polygon layer.

    Args:
        tmp_path: Disposable directory for admitted native inputs.

    Returns:
        A DEM draining east along each valid row and a selection in the middle row.
    """
    dem = tmp_path / "elevation.tif"
    elevations = numpy.full((5, 7), -9999, dtype="float64")
    elevations[::2] = numpy.arange(12, -1, -2)
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
            dtype="float64",
            crs="EPSG:4326",
            transform=from_origin(0, 5, 1, 1),
            nodata=-9999,
        ) as dataset,
    ):
        dataset.write(elevations, 1)
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
                "geometry": mapping(box(3.2, 2.2, 3.8, 3.8)),
                "properties": {"site": "chosen"},
            }
        )
        layer.write(
            {
                "geometry": mapping(box(2.2, 4.2, 2.8, 4.8)),
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
    pytest.importorskip("ecoshard.geoprocessing.routing")
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

    with rasterio.open(directory / "result.tif") as result:
        expected = numpy.full((5, 7), 255, dtype="uint8")
        expected[::2] = 0
        expected[2] = expected_corridor
        numpy.testing.assert_array_equal(result.read(1), expected)
        assert result.nodata == 255
        assert result.transform == from_origin(0, 5, 1, 1)
        assert result.crs.to_epsg() == 4326
        assert result.tags(ns="IMAGE_STRUCTURE")["LAYOUT"] == "COG"
    assert artifact.valid_pixels == 21
    assert {path.name for path in directory.iterdir()} == {
        "provenance.json",
        "progress.json",
        "result.tif",
    }


def test_flow_crosses_an_interior_pit_after_filling(
    tmp_path: Path, drainage_corridor: tuple[Path, ResolvedCatalogSelection]
) -> None:
    """A depression upstream still drains through its lowest rim toward the polygon.

    Args:
        tmp_path: Disposable source and run directory parent.
        drainage_corridor: Supplies the original selected polygon on the middle row.
    """
    pytest.importorskip("ecoshard.geoprocessing.routing")
    original_dem, selection = drainage_corridor
    dem = tmp_path / "interior-pit.tif"
    elevations = numpy.full((5, 7), 100, dtype="float64")
    elevations[2] = [12, 10, 0, 6, 4, 2, 0]
    with rasterio.open(original_dem) as original:
        with rasterio.open(dem, "w", **original.profile) as dataset:
            dataset.write(elevations, 1)
    inputs = FlowAreaInputs(
        dem=SOURCE, polygon=selection.selection, upstream=True, downstream=False
    )
    plan = FlowAreaPlan(inputs=inputs, grid=plan_flow_grid(dem))
    directory = tmp_path / "attempt"
    directory.mkdir()
    calculate_flow_area((dem, selection), plan, directory, RasterAggregateLimits())
    with rasterio.open(directory / "result.tif") as result:
        numpy.testing.assert_array_equal(result.read(1)[2], [1, 1, 1, 0, 0, 0, 0])


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
