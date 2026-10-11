"""Compare EOlab outputs with an independent invocation of the original model CLI."""

import asyncio
import csv
from dataclasses import replace
from importlib.resources import files
import json
import os
from pathlib import Path
import subprocess
import sys
from time import perf_counter

import fiona
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import box, mapping
import yaml

from eolab_app.processing.downstream_calculation import (
    downstream_process_target,
    plan_downstream,
)
from eolab_app.processing.native_processes import create_native_process
from eolab_app.processing.aggregate_models import AggregateArtifact
from test_downstream_model import downstream_fixture, scaled_downstream_fixture
from test_prepared_hydrology import prepare_sources
from eolab_app.processing.hydrology_validation import (
    validate_hydrology_sources,
    HydrologyValidationLimits,
)


def assert_same_raster(actual: Path, expected: Path) -> None:
    """Compare every pixel, validity flag and grid property without a tolerance.

    Args:
        actual: Raster returned by EOlab's wrapper.
        expected: Raster produced independently by the original command line.
    """
    with rasterio.open(actual) as left, rasterio.open(expected) as right:
        assert (
            left.crs,
            left.transform,
            left.width,
            left.height,
            left.dtypes,
            left.nodatavals,
        ) == (
            right.crs,
            right.transform,
            right.width,
            right.height,
            right.dtypes,
            right.nodatavals,
        )
        np.testing.assert_array_equal(left.read(), right.read())
        np.testing.assert_array_equal(left.read_masks(), right.read_masks())


@pytest.mark.parametrize(
    "case",
    [
        "plain",
        "buffer-cutoff",
        "resampled-signed-values",
        "vector-filter",
        "multiple-drains",
        "virtual-link",
        "resampled-dem",
    ],
)
def test_wrapper_matches_original_command_line(tmp_path: Path, case: str) -> None:
    """The unchanged CLI and EOlab return exactly the same rasters and sum.

    The reference prepares canonical HydroBASINS fields and a known AOI itself;
    it does not use EOlab's input conversion or calculation helpers. The original
    CLI runs its own TaskGraph, separate from EOlab's sequential native adapter.

    Args:
        tmp_path: Independent reference and wrapper workspaces.
        case: Exercise routing, buffering/cutoff or values-grid/value-domain rules.
    """
    original = files("wwf_es_beneficiaries") / "workflow_runner.py"
    sources, request, limits = downstream_fixture(tmp_path / "inputs")
    area = box(0, 0, 1, 4)
    if case == "resampled-dem":
        sources, request, limits = scaled_downstream_fixture(
            tmp_path / "fine-dem", 1200, 800
        )
        request = request.model_copy(
            update={
                "wgs84_pixel_size": 0.01,
                "travel_time_pixel_size_m": 900,
                "buffer_m": 5000,
                "cutoff_m": 50000,
            }
        )
        # The reference AOI is the known first native-mask column, independently
        # of EOlab's polygonization; two seed columns survive nearest resampling.
        with rasterio.open(sources.rasters["starting_mask"], "r+") as raster:
            values = raster.read(1)
            values[:, :4] = 1
            raster.write(values, 1)
        area = box(0, 0, 0.02, 4)
    reference_mask = sources.rasters["starting_mask"]
    if case == "vector-filter":
        from eolab_app.attribute_filter import VectorFilter

        selection = sources.network.selection.model_copy(
            update={
                "filter": VectorFilter.model_validate(
                    {
                        "enabled": True,
                        "match": "all",
                        "rules": [{"field": "id", "operator": "eq", "value": 1}],
                    }
                )
            }
        )
        sources = replace(
            sources,
            starting=replace(sources.network, selection=selection, where='"id" = 1'),
        )
        request = request.model_copy(
            update={
                "starting_mask": request.__class__.model_validate(
                    {
                        **request.model_dump(mode="json", by_alias=True),
                        "starting_mask": {
                            "kind": "catalogSelection",
                            "selection": selection,
                        },
                    }
                ).starting_mask
            }
        )
        area = box(0, 0, 2, 4)
        reference_mask = tmp_path / "independent-vector-mask.tif"
        # Independently rasterize the known selected polygon on the requested
        # grid. This does not call EOlab's vector conversion helper.
        with rasterio.open(
            reference_mask,
            "w",
            driver="GTiff",
            width=2,
            height=4,
            count=1,
            dtype="uint8",
            nodata=0,
            crs="EPSG:4326",
            transform=from_origin(0, 4, 1, 1),
        ) as raster:
            raster.write(np.ones((4, 2), dtype="uint8"), 1)
    if case in {"multiple-drains", "virtual-link"}:
        records = [
            {
                "id": i,
                "next": (i + 1 if i < 3 else 0) if case == "virtual-link" else 0,
                "sink": (2 if i < 3 else 3) if case == "virtual-link" else i,
                "geometry": mapping(box((i - 1) * 2, 0, i * 2, 4)),
            }
            for i in range(1, 4)
        ]
        topology = request.hydrology.definition.topology.model_dump(
            by_alias=True, exclude_none=True
        )
        topology["terminal"] = {"field": "sink", "equalsField": "id"}
        definition, dem, network_source, _ = prepare_sources(
            tmp_path / "drains",
            records=records,
            definition_changes={"topology": topology},
        )
        report = validate_hydrology_sources(
            definition, dem, network_source, HydrologyValidationLimits()
        )
        sources = replace(
            sources,
            rasters={**sources.rasters, "dem": dem.source_path},
            network=network_source,
        )
        request = request.model_copy(update={"hydrology": report})
        if case == "multiple-drains":
            with rasterio.open(reference_mask, "r+") as raster:
                raster.write(np.ones((4, 6), dtype="int16"), 1)
            area = box(0, 0, 6, 4)
    if case == "buffer-cutoff":
        request = request.model_copy(update={"buffer_m": 100000, "cutoff_m": 200000})
    if case == "resampled-signed-values":
        with rasterio.open(
            sources.rasters["values"],
            "w",
            driver="GTiff",
            width=12,
            height=8,
            count=1,
            dtype="float32",
            nodata=-9999,
            crs="EPSG:4326",
            transform=from_origin(0, 4, 0.5, 0.5),
        ) as raster:
            values = np.arange(-48, 48, dtype="float32").reshape(8, 12)
            values[5, 5] = -9999
            raster.write(values, 1)
    reference = tmp_path / "reference"
    reference.mkdir()
    aoi = reference / "reference-area.geojson"
    aoi.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {"type": "Feature", "properties": {}, "geometry": mapping(area)}
                ],
            }
        ),
        encoding="utf-8",
    )
    network = reference / "hydrobasins.gpkg"
    with fiona.open(sources.network.path, layer="watersheds") as source:
        with fiona.open(
            network,
            "w",
            driver="GPKG",
            layer="hydrobasins",
            crs=source.crs,
            schema={
                "geometry": "Polygon",
                "properties": {
                    "HYBAS_ID": "int64",
                    "NEXT_DOWN": "int64",
                    "NEXT_SINK": "int64",
                },
            },
        ) as target:
            for feature in source:
                target.write(
                    {
                        "geometry": feature["geometry"],
                        "properties": {
                            "HYBAS_ID": feature["properties"]["id"],
                            "NEXT_DOWN": feature["properties"]["next"],
                            "NEXT_SINK": feature["properties"]["sink"],
                        },
                    }
                )
    output = reference / "outputs"
    config = reference / "comparison.yaml"
    config.write_text(
        yaml.safe_dump(
            {
                "run_name": "comparison",
                "work_dir": str(reference / "work"),
                "output_dir": str(output),
                "inputs": {
                    "population_raster_path": str(sources.rasters["values"]),
                    # The CLI requires this path even when no travel-time section exists.
                    # Its conditional-raster workflow never reads this unused input.
                    "traveltime_raster_path": str(sources.rasters["values"]),
                    "dem_raster_path": str(sources.rasters["dem"]),
                    "subwatershed_vector_path": str(network),
                    "aoi_vector_pattern": [str(aoi)],
                    "wgs84_pixel_size": request.wgs84_pixel_size,
                    "travel_time_pixel_size_m": request.travel_time_pixel_size_m,
                    "buffer_size_m": request.buffer_m,
                    "taskgraph_workers": 1,
                    "gdal_cachemax_mb": 128,
                },
                "sections": [
                    {
                        "masks": [
                            {
                                "id": "starting",
                                "type": "conditional_raster",
                                "params": {
                                    "condition_raster_path": str(reference_mask),
                                    "expression": "value > 0",
                                    "max_downstream_distance_m": request.cutoff_m,
                                },
                            }
                        ]
                    },
                    {"combine": [{"logic": "OR"}]},
                ],
                "logging": {
                    "level": "INFO",
                    "to_file": str(reference / "original.log"),
                },
            }
        ),
        encoding="utf-8",
    )
    started = perf_counter()
    completed = subprocess.run(
        [sys.executable, str(original), str(config)],
        capture_output=True,
        text=True,
        timeout=180,
        env={
            **os.environ,
            "OPENBLAS_NUM_THREADS": "1",
            "OMP_NUM_THREADS": "1",
            "NUMEXPR_NUM_THREADS": "1",
        },
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    direct_seconds = perf_counter() - started
    wrapped = tmp_path / "wrapped"
    wrapped.mkdir()
    started = perf_counter()
    plan = plan_downstream(sources, request, limits)
    planning_seconds = perf_counter() - started

    async def execute_wrapped() -> AggregateArtifact:
        """Execute through the real native supervisor, including process startup.

        Returns:
            Completed upstream outputs returned by the supervised calculation.
        """
        native = create_native_process(limits)
        try:
            status, artifact = await native.run(
                downstream_process_target,
                ("calculate", (sources, plan, wrapped, limits)),
                180,
            )
            assert status == "ok", artifact
            return artifact
        finally:
            await native.close()

    artifact = asyncio.run(execute_wrapped())
    wrapped_seconds = perf_counter() - started
    assert_same_raster(
        wrapped / "coverage.tif", output / "reference-area_union_coverage.tif"
    )
    assert_same_raster(
        wrapped / "masked_values.tif", output / "reference-area_union_population.tif"
    )
    with next(output.glob("comparison_*.csv")).open(newline="") as stream:
        rows = list(csv.DictReader(stream))
    assert len(rows) == 1
    assert float(artifact.rows[0]["value"]) == float(rows[0]["union_population"])
    assert not (wrapped / "upstream").exists()
    print(
        f"{case}: direct CLI {direct_seconds:.3f}s; EOlab plan {planning_seconds:.3f}s; plan + wrapper {wrapped_seconds:.3f}s"
    )
