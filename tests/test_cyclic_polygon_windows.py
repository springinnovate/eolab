"""Cyclic polygon windows preserve native cells across selection callers."""

from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest
import rasterio
from affine import Affine
from rasterio.crs import CRS
from rasterio.features import geometry_mask
from rasterio.transform import from_origin
from rasterio.windows import Window
from rasterio.windows import transform as window_transform
from shapely.affinity import translate
from shapely.geometry import MultiPolygon, Polygon, box, mapping

from catalog_selection_support import write_selection
from eolab_app.bounded_vector import PolygonRasterizer, pixels_inside_area
from eolab_app.polygon_areas import PolygonAreaReference, PolygonSummaryInput
from eolab_app.processing.raster_input import select_area
from eolab_app.raster.bounded_window import (
    prepare_raster_for_wgs84_bounds,
    selected_raster_area_for_wgs84_polygons,
)
from eolab_app.raster.source_contract import read_native_raster_window
from eolab_app.raster.statistics import read_raster_statistics
from eolab_app.raster.temporal import TemporalObservation, TemporalRasterDataset
from eolab_app.sampling_area import (
    CatalogSelectionSamplingArea,
    PolygonInputSamplingArea,
    SelectedBoundsSamplingArea,
)


@pytest.mark.parametrize(("width", "west"), [(360, -180), (361, -180.5), (360, 0)])
def test_full_longitude_bounds_include_every_native_column(
    tmp_path: Path, width: int, west: float
) -> None:
    """Include both seam samples on point-registered global grids exactly once.

    Args:
        tmp_path: Directory for a real global GeoTIFF.
        width: Number of distinct native columns.
        west: Longitude at the raster's left edge.
    """
    path = tmp_path / "full-longitude.tif"
    values = np.arange(3 * width, dtype="int16").reshape(3, width)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=3,
        width=width,
        count=1,
        dtype="int16",
        crs="EPSG:4326",
        transform=from_origin(west, 1.5, 1, 1),
    ) as dataset:
        dataset.write(values, 1)
    bounds = (-180, -1, 180, 1)
    with rasterio.open(path) as dataset:
        selected = select_area(dataset, "bounds", bounds, (), None)
        assert selected.source_window == Window(0, 0, width, 3)
    stats = read_raster_statistics(path, SelectedBoundsSamplingArea(bounds))
    assert stats.valid_sample_count == values.size
    assert stats.sample_minimum == 0
    assert stats.sample_maximum == values.size - 1


@pytest.fixture
def seam_observation(tmp_path: Path) -> TemporalObservation:
    """Write a global grid with distinct values and both native invalidity masks.

    Args:
        tmp_path: Isolated raster directory.

    Returns:
        Admitted cyclic observation with a source cell crossing longitude 180.
    """
    path = tmp_path / "global.tif"
    transform = Affine(0.25, 0, -180.125, 0, -0.25, 8.125)
    values = np.arange(64 * 1440, dtype="float32").reshape(64, 1440)
    values[31, 0] = -9999
    valid = np.full(values.shape, 255, dtype="uint8")
    valid[32, 1439] = 0
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=64,
        width=1440,
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=transform,
        nodata=-9999,
        tiled=True,
        blockxsize=16,
        blockysize=16,
    ) as dataset:
        dataset.write(values, 1)
        dataset.write_mask(valid)
    time = datetime(2000, 1, 1, tzinfo=timezone.utc)
    return TemporalObservation(
        path, time, None, time, time, transform, CRS.from_epsg(4326), -9999, True
    )


@pytest.mark.parametrize("kind", ["polygons", "catalogSelection"])
@pytest.mark.parametrize("maximum_coordinates", [500000, None])
@pytest.mark.parametrize(
    "case", ["seam", "interior", "noncyclic", "full-period", "partial", "multipart"]
)
def test_polygon_windows_preserve_native_cells(
    seam_observation: TemporalObservation,
    tmp_path: Path,
    kind: str,
    maximum_coordinates: int | None,
    case: str,
) -> None:
    """Compare compact polygon reads with an independent full-source mask.

    Args:
        seam_observation: Real source with distinguishable cells and native masks.
        tmp_path: Isolated Catalog vector directory.
        kind: In-memory polygons or an authorized Catalog descriptor.
        maximum_coordinates: Finite interactive budget or unlimited Processing.
        case: Seam, interior, noncyclic, full-period, partial or multipart coverage.
    """
    geometry = {
        "seam": box(179.8, -1, 180, 1),
        "interior": box(-1, -1, 1, 1),
        "noncyclic": box(179.8, -1, 180, 1),
        "full-period": box(-180, -1, 180, 1),
        "partial": box(179.8, 7, 180, 10),
        "multipart": MultiPolygon(
            [
                Polygon(
                    box(178, -3, 180, 3).exterior.coords,
                    [box(178.5, -1, 179.5, 1).exterior.coords],
                ),
                box(177, -3, 177.5, -2),
            ]
        ),
    }[case]
    observation = replace(seam_observation, cyclic_x=case != "noncyclic")
    geometries = (mapping(geometry),)
    resolved = (
        write_selection(tmp_path / "area.gpkg", list(geometries))
        if kind == "catalogSelection"
        else None
    )
    with rasterio.open(observation.path) as source:
        values = source.read(1, masked=True)
        expected_mask = geometry_mask(
            [
                mapping(translate(geometry, xoff=offset))
                for offset in ((-360, 0, 360) if observation.cyclic_x else (0,))
            ],
            values.shape,
            source.transform,
            all_touched=True,
            invert=True,
        )
        expected = values[expected_mask].compressed()
        expected = expected[expected != observation.nodata]
    with TemporalRasterDataset(observation) as dataset:
        selected = select_area(
            dataset,
            kind,
            geometry.bounds,
            geometries,
            maximum_coordinates,
            resolved,
            max_retained_polygon_bytes=None if maximum_coordinates is None else 0,
        )
        try:
            values = read_native_raster_window(dataset, selected.source_window)
            inside = pixels_inside_area(
                selected.projected_geometries,
                out_shape=values.shape,
                transform=window_transform(selected.source_window, dataset.transform),
                all_touched=True,
            )
            actual = values[inside].compressed()
            np.testing.assert_array_equal(np.sort(actual), np.sort(expected))
            assert len(actual) == len(np.unique(actual))
            if case in {"seam", "partial"}:
                assert selected.source_window.width == 4
            if case in {"interior", "noncyclic", "full-period"}:
                assert dataset.transform == observation.transform
            if case == "full-period":
                assert selected.source_window.width == dataset.width
        finally:
            if isinstance(selected.projected_geometries, PolygonRasterizer):
                selected.projected_geometries.close()
                assert selected.projected_geometries.retained_bytes == 0


@pytest.mark.parametrize("kind", ["polygons", "catalogSelection"])
def test_polygon_planning_preserves_the_first_view(
    seam_observation: TemporalObservation, tmp_path: Path, kind: str
) -> None:
    """Leave a prior interior selection's origin unchanged for a later seam mask.

    Args:
        seam_observation: Global source whose seam selection would rotate a new view.
        tmp_path: Isolated vector directory.
        kind: Owned or Catalog polygon path using unlimited geometry.
    """
    geometry = mapping(box(179.8, -1, 180, 1))
    resolved = write_selection(tmp_path / "area.gpkg", [geometry])
    with TemporalRasterDataset(seam_observation) as dataset:
        prepare_raster_for_wgs84_bounds(dataset, (-1, -1, 1, 1))
        selected = select_area(
            dataset, kind, (179.8, -1, 180, 1), (geometry,), None, resolved
        )
        assert dataset.transform == seam_observation.transform
        assert selected.source_window.width == dataset.width
        if isinstance(selected.projected_geometries, PolygonRasterizer):
            selected.projected_geometries.close()


def test_neutral_polygon_helper_prepares_a_view_without_captured_bounds(
    seam_observation: TemporalObservation,
) -> None:
    """Derive the envelope from supplied geometry when no caller has cached it.

    Args:
        seam_observation: Admitted cyclic raster.
    """
    with TemporalRasterDataset(seam_observation) as dataset:
        selected = selected_raster_area_for_wgs84_polygons(
            dataset, (mapping(box(179.8, -1, 180, 1)),), None
        )
        assert selected.source_window.width == 4


def test_interactive_polygons_use_the_exact_compact_window(
    seam_observation: TemporalObservation, tmp_path: Path
) -> None:
    """Use exact native samples for both polygon contracts beside the seam.

    Args:
        seam_observation: Global source with seam cells and native invalid values.
        tmp_path: Isolated original vector source.
    """
    geometry = mapping(box(179.8, -1, 180, 1))
    polygons = PolygonSummaryInput(polygons=(geometry,))
    reference = read_raster_statistics(
        seam_observation, SelectedBoundsSamplingArea(polygons.bounds())
    )
    for area in (
        PolygonInputSamplingArea(
            PolygonAreaReference(id="a" * 32, sha256=polygons.geometry_hash()), polygons
        ),
        CatalogSelectionSamplingArea(
            write_selection(tmp_path / "area.gpkg", [geometry])
        ),
    ):
        actual = read_raster_statistics(seam_observation, area)
        assert actual.source_width == 4
        assert actual.sampling_method == "exactSourceWindow"
        assert actual.valid_sample_count == reference.valid_sample_count
        assert actual.sample_minimum == reference.sample_minimum
        assert actual.sample_maximum == reference.sample_maximum
        assert actual.histogram == reference.histogram
