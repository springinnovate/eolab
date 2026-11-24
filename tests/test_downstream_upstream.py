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

from catalog_selection_support import write_selection
from eolab_app.attribute_filter import VectorFilter
from eolab_app.processing.downstream_calculation import (
    calculate_downstream,
    downstream_process_target,
    plan_downstream,
)
from eolab_app.processing.downstream_models import VectorStartingMask
from eolab_app.processing.native_processes import create_native_process
from eolab_app.processing.aggregate_models import AggregateArtifact
from test_downstream_model import downstream_fixture, scaled_downstream_fixture
from test_prepared_hydrology import prepare_sources
from eolab_app.processing.prepared_hydrology import HydrologySources


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
    ("polygon_edges", "drain_extents", "seed_columns", "total"),
    [
        pytest.param((3.31, 3.69), [(0, 9)], (3,), 20, id="one-cell-corridor"),
        # The second drainage's centers are a quarter cell farther east.
        # Its center at 5.75 lies outside the polygon even though 5.5 is inside.
        pytest.param(
            (2.125, 5.625),
            [(0, 4), (4.25, 8.25)],
            (2, 3, 4),
            24,
            id="offset-drainages",
        ),
    ],
)
def test_selected_polygon_matches_raster_starts_on_routing_grids(
    tmp_path: Path,
    polygon_edges: tuple[float, float],
    drain_extents: list[tuple[float, float]],
    seed_columns: tuple[int, ...],
    total: int,
) -> None:
    """Compare exact starts, downstream coverage and CSV totals on an eastward corridor.

    Args:
        tmp_path: Isolated catalog sources and native model outputs.
        polygon_edges: West and east edges in fractional source columns.
        drain_extents: West and east edges of each independent terminal drainage.
        seed_columns: Hand-located centers on the routing grids, in output columns.
        total: Sum of the positive values downstream of those centers.
    """
    pixel_size = 1 / 128
    grid = from_origin(-61, 13, pixel_size, pixel_size)
    records = [
        {
            "id": sink,
            "next": 0,
            "sink": sink,
            "geometry": mapping(box(*(grid @ (west, 3)), *(grid @ (east, 0)))),
        }
        for sink, (west, east) in enumerate(drain_extents, start=1)
    ]
    sources, request, limits = downstream_fixture(tmp_path / "inputs", records=records)
    request = request.model_copy(
        update={"wgs84_pixel_size": pixel_size, "travel_time_pixel_size_m": 850}
    )
    dem = np.full((3, 9), -9999, dtype="float32")
    dem[1, 1:8] = np.arange(107, 100, -1)
    values = np.full((3, 9), -9999, dtype="int16")
    values[1, 1:8] = [9, 4, 2, 0, -9999, 7, 11]
    starts = np.zeros((3, 9), dtype="int16")
    starts[1, seed_columns] = 1
    coverage = np.zeros_like(starts)
    coverage[1, seed_columns[0] : 8] = 1
    for name, data in (("dem", dem), ("values", values), ("starting_mask", starts)):
        with rasterio.open(
            sources.rasters[name],
            "w",
            driver="GTiff",
            width=9,
            height=3,
            count=1,
            dtype=data.dtype,
            crs="EPSG:4326",
            transform=grid,
            nodata=-9999,
        ) as dataset:
            dataset.write(data, 1)

    west, east = polygon_edges
    selected = box(*(grid @ (west, 1.88)), *(grid @ (east, 1.10)))
    excluded = box(*(grid @ (1, 2)), *(grid @ (2, 1)))
    selection = write_selection(
        tmp_path / "starts.gpkg",
        [mapping(selected), mapping(excluded)],
        values=[1, 0],
        candidate=VectorFilter.model_validate(
            {
                "enabled": True,
                "match": "all",
                "rules": [{"field": "selected", "operator": "eq", "value": 1}],
            }
        ),
    )
    polygon_request = request.model_copy(
        update={
            "starting_mask": VectorStartingMask(
                kind="catalogSelection", selection=selection.selection
            )
        }
    )
    raster_run = tmp_path / "raster"
    polygon_run = tmp_path / "polygon"
    for directory, inputs, settings in (
        (raster_run, sources, request),
        (polygon_run, replace(sources, starting=selection), polygon_request),
    ):
        directory.mkdir()
        calculate_downstream(
            inputs, plan_downstream(inputs, settings), directory, limits
        )
        with (directory / "result.csv").open(newline="") as stream:
            assert float(next(csv.DictReader(stream))["value"]) == total
        for name, expected in (("starting_mask", starts), ("coverage", coverage)):
            with rasterio.open(directory / f"{name}.tif") as result:
                assert result.transform == grid
                np.testing.assert_array_equal(result.read(1), expected)
        assert len(list(directory.glob("routing_dem_*.tif"))) == len(drain_extents)
    for name in ("starting_mask.tif", "coverage.tif", "masked_values.tif"):
        assert_same_raster(polygon_run / name, raster_run / name)


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
        "dem-nodata",
        "dem-pit",
        "closed-dem-edge",
    ],
)
def test_wrapper_matches_original_command_line(tmp_path: Path, case: str) -> None:
    """The CLI and EOlab return identical results with the same pit-filling options.

    The reference prepares canonical HydroBASINS fields and a known AOI itself;
    it does not use EOlab's input conversion or calculation helpers. The original
    CLI runs its own TaskGraph, separate from EOlab's sequential native adapter.

    Args:
        tmp_path: Independent reference and wrapper workspaces.
        case: Exercise routing, buffering/cutoff, terrain NoData or value rules.
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
    if case in {"dem-nodata", "dem-pit", "closed-dem-edge"}:
        with rasterio.open(sources.rasters["dem"], "r+") as raster:
            elevations = raster.read(1)
            if case == "dem-nodata":
                elevations[1, 4] = raster.nodata
            elif case == "closed-dem-edge":
                elevations[0, 2] = 0
            else:
                elevations[1, 2] = -50
            raster.write(elevations, 1)
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
        topology = request.hydrology.topology.model_dump(
            by_alias=True, exclude_none=True
        )
        topology["terminal"] = {"field": "sink", "equalsField": "id"}
        definition, dem, network_source, _ = prepare_sources(
            tmp_path / "drains",
            records=records,
            definition_changes={"topology": topology},
        )
        configured = HydrologySources(
            dem=definition.dem,
            watersheds=definition.watersheds,
            topology=definition.topology,
        )
        sources = replace(
            sources,
            rasters={**sources.rasters, "dem": dem.source_path},
            network=network_source,
        )
        request = request.model_copy(update={"hydrology": configured})
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
                    "max_pixel_fill_count": request.settings.pit_fill_search_limit,
                    "treat_nodata_as_closed": True,
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
        cwd=reference,
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
    plan = plan_downstream(sources, request)
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
    reference_routing_dems = {
        path.parent.name: path
        for path in (reference / "work").rglob("pit_filled_*_clipped.tif")
    }
    assert reference_routing_dems
    retained_routing_dems = {
        item.name.removeprefix("routing_dem_"): item
        for item in artifact.additional_outputs
        if item.output_name == "routing_dem"
    }
    assert set(retained_routing_dems) == set(reference_routing_dems)
    if case == "multiple-drains":
        assert len(retained_routing_dems) == 3
    for drain, file in retained_routing_dems.items():
        assert_same_raster(wrapped / file.storage_name, reference_routing_dems[drain])
        assert file.member_label == f"Drain {drain.removeprefix('drain_')}"
    if case == "dem-pit":
        filled_path = next(iter(reference_routing_dems.values()))
        clipped_path = filled_path.with_name(
            filled_path.name.removeprefix("pit_filled_")
        )
        with (
            rasterio.open(filled_path) as filled,
            rasterio.open(clipped_path) as clipped,
        ):
            assert np.any(filled.read(1) != clipped.read(1))
    if case == "closed-dem-edge":
        # This edge depression drained immediately with the old open-edge rule.
        with rasterio.open(next(iter(reference_routing_dems.values()))) as filled:
            assert filled.read(1)[0, 2] > 0
    with next(output.glob("comparison_*.csv")).open(newline="") as stream:
        rows = list(csv.DictReader(stream))
    assert len(rows) == 1
    assert float(artifact.rows[0]["value"]) == float(rows[0]["union_population"])
    assert not (wrapped / "upstream").exists()
    print(
        f"{case}: direct CLI {direct_seconds:.3f}s; EOlab plan {planning_seconds:.3f}s; plan + wrapper {wrapped_seconds:.3f}s"
    )
