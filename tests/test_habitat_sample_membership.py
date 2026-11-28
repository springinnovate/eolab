"""Compare the native Habitat sampler and its outputs with full-grid AOI membership."""

from dataclasses import replace
from pathlib import Path
from unittest.mock import patch
from zipfile import ZipFile

import numpy as np
import pandas as pd
import rasterio
from affine import Affine
from rasterio.enums import Resampling
from rasterio.io import MemoryFile
from rasterio.transform import from_origin
from rasterio.warp import transform_bounds
from shapely.geometry import box, mapping

from catalog_selection_support import write_selection

from nhi_terrestrial_integrity_modeling import prepared_runner
from nhi_terrestrial_integrity_modeling.habitat_training import IntegrityConfiguration
from nhi_terrestrial_integrity_modeling.prepared_rasters import RasterBand

from eolab_app.processing import habitat_calculation as habitat, habitat_raster_cache
from eolab_app.processing.aggregate_models import AggregateArea, RasterAggregateLimits
from eolab_app.processing.habitat_models import HabitatRequest
from eolab_app.processing.model_definitions import ModelRegistry
from eolab_app.processing.raster_preparation import RasterGrid, prepare_raster_stack


def test_rotated_whole_raster_matches_full_grid_training_and_outputs(
    tmp_path: Path,
) -> None:
    """Preserve seeded sample cells, weights and all five maps on cold and warm runs.

    Args:
        tmp_path: Private source rasters, reusable band cache and attempt directories.
    """
    rotated = Affine(351.5625, 70.3125, -8635250, 70.3125, -351.5625, 5122750)
    north_up = from_origin(-8670000, 5150000, 500, 500)
    roles = ("predictor_0", "response_0", "reference_mask")
    paths = {role: tmp_path / f"{role}.tif" for role in roles}
    descriptors = {
        role: {"collectionId": "eolab-mounted-geotiffs", "itemId": f"geotiff-{i:024x}"}
        for i, role in enumerate(roles)
    }
    for role in roles:
        size = 256 if role == "predictor_0" else 352
        transform = rotated if role == "predictor_0" else north_up
        rows, cols = np.indices((size, size))
        x, y = (~north_up) * (transform * (cols + 0.5, rows + 0.5))
        relief = np.sin(x / 15.4) + np.cos(y / 21.2)
        values = relief
        if role == "response_0":
            values = relief + 0.3 * np.sin((x + 2 * y) / 21)
            values[120:125, 130:135] = -9999
            values[125:130, 130:135] = 0
        elif role == "reference_mask":
            values = (x // 28 + y // 28) % 3 == 0
        with rasterio.open(
            paths[role],
            "w",
            driver="GTiff",
            height=size,
            width=size,
            count=1,
            dtype="float32",
            crs="EPSG:6933",
            transform=transform,
            nodata=-9999,
        ) as output:
            output.write(values.astype("float32"), 1)
            if role == "response_0":
                valid = np.full(values.shape, 255, dtype="uint8")
                valid[130:135, 130:135] = 0
                output.write_mask(valid)
    bands = {
        "predictor_0": "cubic",
        "response_0": "nearest",
        "reference_mask": "nearest",
    }
    definition = ModelRegistry.load_installed().get("habitat-condition", "1.0.0")
    request = HabitatRequest.model_validate(
        {
            "stack": {
                "predictors": [
                    {"name": "relief", "source": descriptors["predictor_0"]}
                ],
                "responses": [
                    {"name": "vegetation", "source": descriptors["response_0"]}
                ],
            },
            "references": {"kind": "raster", "source": descriptors["reference_mask"]},
            "habitat_mask": None,
            "wholeRaster": True,
            "settings": definition.to_document()["steps"][0]["inputs"]["settings"][
                "value"
            ],
            "preparation": {"resampling": bands},
        }
    )
    sources = habitat.HabitatSources(
        paths,
        {},
        band_cache_directories={key: tmp_path / "cache" / key for key in roles[:2]},
    )
    whole = AggregateArea(kind="wholeRaster")
    original = habitat.read_habitat_area(
        whole, sources, rasterio.crs.CRS.from_epsg(6933), (500, 500)
    )
    hole = box(*north_up * (145, 150), *north_up * (172, 122))
    selected = write_selection(
        tmp_path / "area.gpkg", [mapping(original.difference(hole))], crs="EPSG:6933"
    )
    changed = AggregateArea(
        kind="catalogSelection",
        catalogSelection=selected.selection,
        bounds=transform_bounds("EPSG:6933", "EPSG:4326", *original.bounds),
    )
    inputs = [
        (whole, sources, request, ("cold", "warm")),
        (
            changed,
            replace(sources, vectors={"area": selected}),
            request.model_copy(
                update={"wholeRaster": None, "catalogSelection": selected.selection}
            ),
            ("new-hole",),
        ),
    ]
    for area, run_sources, run_request, attempts in inputs:
        plan = habitat.prepare_habitat_inputs(run_sources, run_request, area, None)
        grid = RasterGrid(
            rasterio.crs.CRS.from_epsg(6933),
            Affine(*plan.grid.transform),
            plan.grid.width,
            plan.grid.height,
        )
        polygon = habitat.read_habitat_area(area, run_sources, grid.crs, (500, 500))
        limits = RasterAggregateLimits()
        golden = tmp_path / f"full-grid-{area.kind}"
        golden.mkdir()
        # The original alignment contract rasterizes the entire AOI once and writes
        # each band with NaN outside it before the scientific sampler sees a window.
        settings = request.settings
        with (
            prepare_raster_stack(
                {key: (path, Resampling[bands[key]]) for key, path in paths.items()},
                grid,
                (mapping(polygon),),
                golden,
                limits,
                all_touched=False,
            ) as full_grid,
            patch.object(
                prepared_runner,
                "fit_habitat_condition",
                wraps=prepared_runner.fit_habitat_condition,
            ) as fit,
        ):
            expected_run = prepared_runner.run_habitat_condition(
                [RasterBand("relief", full_grid["predictor_0"])],
                [RasterBand("vegetation", full_grid["response_0"])],
                RasterBand("reference_sites", full_grid["reference_mask"]),
                polygon,
                golden / "maps",
                IntegrityConfiguration(
                    **{
                        key: getattr(settings, key)
                        for key in IntegrityConfiguration.__dataclass_fields__
                    }
                ),
                categorical_predictor_name=None,
                samples_per_class_per_block=settings.samples_per_class_per_block,
                random_seed=settings.random_seed,
                tile_size_pixels=settings.tile_size_pixels,
                tile_origin=settings.tile_origin,
                window_size_pixels=settings.window_size_pixels,
                covariance_shrinkage=settings.covariance_shrinkage,
            )
            expected_samples = fit.call_args.args[0]

        cols, rows = (~north_up) * (
            grid.transform
            * (
                expected_samples["column"].to_numpy() + 0.5,
                expected_samples["row"].to_numpy() + 0.5,
            )
        )
        for top, missing in ((120, True), (125, False), (130, True)):
            selected_values = expected_samples.loc[
                (cols >= 130) & (cols < 135) & (rows >= top) & (rows < top + 5),
                "vegetation",
            ]
            assert len(selected_values) > 0
            if missing:
                assert selected_values.isna().all()
            else:
                assert (selected_values == 0).all()

        for attempt in attempts:
            actual = tmp_path / attempt
            actual.mkdir()
            with (
                patch.object(
                    prepared_runner,
                    "fit_habitat_condition",
                    wraps=prepared_runner.fit_habitat_condition,
                ) as fit,
                patch.object(
                    habitat_raster_cache,
                    "_write_aligned_band",
                    wraps=habitat_raster_cache._write_aligned_band,
                ) as write_band,
            ):
                habitat.calculate_habitat(run_sources, plan, actual, limits)
            assert write_band.call_count == (1 if attempt == "cold" else 0)
            assert not list(actual.glob("habitat-area-*"))
            pd.testing.assert_frame_equal(
                fit.call_args.args[0], expected_samples, check_exact=True
            )
            with (
                rasterio.open(actual / "result.tif") as got,
                rasterio.open(expected_run.reference_similarity) as expected,
            ):
                np.testing.assert_array_equal(got.read(), expected.read())
                np.testing.assert_array_equal(got.read_masks(), expected.read_masks())
            with ZipFile(actual / "diagnostics.zip") as diagnostics:
                for name in (
                    "expected_reference",
                    "observed_minus_expected",
                    "standardized_deviation",
                    "inference_status",
                ):
                    with (
                        MemoryFile(diagnostics.read(f"{name}.tif")) as got_file,
                        got_file.open() as got,
                        rasterio.open(getattr(expected_run, name)) as expected,
                    ):
                        np.testing.assert_array_equal(got.read(), expected.read())
                        np.testing.assert_array_equal(
                            got.read_masks(), expected.read_masks()
                        )
