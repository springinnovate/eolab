"""Reference grids and real Processing boundaries for downstream model execution."""

import asyncio
from dataclasses import asdict, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from eolab_app.processing.downstream_calculation import (
    DownstreamSources,
    calculate_downstream,
    plan_downstream,
    within_geodesic_distance,
)
from eolab_app.processing.downstream_models import DownstreamRequest
from eolab_app.processing.hydrology_validation import (
    validate_hydrology_sources,
    HydrologyValidationLimits,
)
from eolab_app.processing.clip_models import RasterClipLimits
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.prepared_hydrology import NetworkTermination
from eolab_app.raster.models import AuthorizedRaster
from eolab_app.raster.source_identity import RasterSourceIdentity
from test_prepared_hydrology import prepare_sources


def scaled_downstream_fixture(
    directory: Path, width: int, height: int
) -> tuple[DownstreamSources, DownstreamRequest, RasterClipLimits]:
    """Generate the same three-basin reference at a larger native resolution.

    Args:
        directory: Isolated sources for cancellation and resource measurements.
        width: Bounded native column count.
        height: Bounded native row count.

    Returns:
        Revalidated prepared terrain, captured inputs and deployment limits.
    """
    sources, request, limits = downstream_fixture(directory)
    for name in ("dem", "starting_mask", "values"):
        data = np.ones((height, width), dtype="float32")
        if name == "dem":
            data[:] = np.arange(width, 0, -1)
        elif name == "starting_mask":
            data[:, 1:] = 0
        with rasterio.open(
            sources.rasters[name],
            "w",
            driver="GTiff",
            width=width,
            height=height,
            count=1,
            dtype="float32",
            nodata=-9999,
            crs="EPSG:4326",
            transform=from_origin(0, 4, 6 / width, 4 / height),
            tiled=True,
            blockxsize=256,
            blockysize=256,
        ) as target:
            target.write(data, 1)
    dem = AuthorizedRaster(
        sources.rasters["dem"], RasterSourceIdentity.read(sources.rasters["dem"])
    )
    report = validate_hydrology_sources(
        request.hydrology.definition, dem, sources.network, HydrologyValidationLimits()
    )
    return sources, request.model_copy(update={"hydrology": report}), limits


def downstream_fixture(
    directory: Path, *, values: np.ndarray | None = None, formula: str = "sum(a)"
) -> tuple[DownstreamSources, DownstreamRequest, RasterClipLimits]:
    """Create a prepared three-basin eastward slope and a first-column raster mask.

    Args:
        directory: Isolated fixture files.
        values: Optional native 4-by-6 values raster.
        formula: Scalar result formula.

    Returns:
        Native sources, captured request and test deployment limits.
    """
    definition, dem, network, _ = prepare_sources(directory)
    hydrology = validate_hydrology_sources(
        definition, dem, network, HydrologyValidationLimits()
    )
    for name, data in (
        ("mask", np.tile([1, 0, 0, 0, 0, 0], (4, 1)).astype("int16")),
        ("values", np.ones((4, 6), dtype="int16") if values is None else values),
    ):
        with rasterio.open(
            directory / (name + ".tif"),
            "w",
            driver="GTiff",
            width=6,
            height=4,
            count=1,
            dtype=data.dtype,
            crs="EPSG:4326",
            transform=from_origin(0, 4, 1, 1),
            nodata=-9999,
        ) as target:
            target.write(data, 1)
    request = DownstreamRequest(
        requestId="a" * 32,
        label="Beneficiaries",
        starting_mask={
            "kind": "catalogRaster",
            "source": {
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": "geotiff-" + "3" * 24,
            },
        },
        hydrology=hydrology,
        values={
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-" + "2" * 24,
        },
        buffer_m=0,
        cutoff_m=None,
        summary=formula,
    )
    sources = DownstreamSources(
        {
            "dem": dem.source_path,
            "starting_mask": directory / "mask.tif",
            "values": directory / "values.tif",
        },
        network,
        None,
    )
    return sources, request, RasterClipLimits(free_space_floor=0)


def test_field_comparison_stops_virtual_downstream_links() -> None:
    """NEXT_SINK equals HYBAS_ID identifies a real sink even with NEXT_DOWN present."""
    rule = NetworkTermination(field="NEXT_SINK", equalsField="HYBAS_ID")
    assert rule.matches({"NEXT_SINK": 12, "HYBAS_ID": 12, "NEXT_DOWN": 99})
    assert not rule.matches({"NEXT_SINK": 12, "HYBAS_ID": 11, "NEXT_DOWN": 12})
    with pytest.raises(ValueError):
        rule.matches({"NEXT_SINK": "12", "HYBAS_ID": 12})


@pytest.mark.parametrize("latitude", [0.0, 60.0])
def test_buffers_measure_metres_on_geographic_grids(latitude: float) -> None:
    """The same longitude increment has a smaller physical distance at high latitude.

    Args:
        latitude: Reference latitude for the exact WGS84 distance check.
    """
    pytest.importorskip("scipy")
    lon = np.array([[0.0, 0.01, 0.02]])
    lat = np.full_like(lon, latitude)
    selected = within_geodesic_distance(lon, lat, np.array([[True, False, False]]), 700)
    assert selected.tolist() == [[True, latitude == 60, False]]


def test_downstream_native_mask_crosses_watersheds_and_preserves_signed_values(
    tmp_path: Path,
) -> None:
    """Only mask cells seed routing; all downstream native values retain zeros and signs.

    Args:
        tmp_path: Isolated prepared sources and calculation artifacts.
    """
    pytest.importorskip("ecoshard.geoprocessing.routing")
    data = np.arange(-12, 12, dtype="int16").reshape(4, 6)
    sources, request, limits = downstream_fixture(tmp_path / "sources", values=data)
    spec = plan_downstream(sources, request, limits)
    directory = tmp_path / "run"
    directory.mkdir()
    artifact = calculate_downstream(sources, spec, directory, limits)
    assert float(artifact.rows[0]["value"]) == float(data.sum())
    assert spec.watersheds == (1, 2, 3)
    with rasterio.open(directory / "starting_mask.tif") as mask:
        assert np.count_nonzero(mask.read(1) == 1) == 4
    with rasterio.open(directory / "coverage.tif") as coverage:
        assert np.all(coverage.read(1) == 1)
    assert {item.name for item in artifact.additional_outputs} == {
        "coverage",
        "starting_mask",
    }


def test_nodata_values_have_explicit_empty_result(tmp_path: Path) -> None:
    """Missing values produce the shared no-valid-data result without changing coverage.

    Args:
        tmp_path: Isolated model sources and outputs.
    """
    pytest.importorskip("ecoshard.geoprocessing.routing")
    sources, request, limits = downstream_fixture(
        tmp_path / "sources", values=np.full((4, 6), -9999, dtype="int16")
    )
    spec = plan_downstream(sources, request, limits)
    directory = tmp_path / "run"
    directory.mkdir()
    artifact = calculate_downstream(sources, spec, directory, limits)
    assert artifact.rows[0]["state"] == "no_valid_data"
    with rasterio.open(directory / "coverage.tif") as dataset:
        assert np.all(dataset.read(1) == 1)


def test_empty_starting_raster_is_rejected_before_routing(tmp_path: Path) -> None:
    """A raster with no positive valid seed cells fails with a useful admission error.

    Args:
        tmp_path: Isolated native sources.
    """
    sources, request, limits = downstream_fixture(tmp_path)
    with rasterio.open(sources.rasters["starting_mask"], "r+") as dataset:
        dataset.write(np.zeros((4, 6), dtype="int16"), 1)
    with pytest.raises(ProcessingError, match="no positive valid cells"):
        plan_downstream(sources, request, limits)


def test_downstream_admission_rejects_excessive_native_work(tmp_path: Path) -> None:
    """Even tiny grids fail admission when the deployment memory budget cannot fit them.

    Args:
        tmp_path: Native reference sources.
    """
    sources, request, _ = downstream_fixture(tmp_path)
    with pytest.raises(ProcessingError, match="native cells"):
        plan_downstream(sources, request, RasterClipLimits(process_memory_bytes=1024))


@pytest.mark.parametrize(
    "formula,expected",
    [("sum(a)", 48), ("count(a)", 48), ("mean(a)", 1), ("sum(a, where=a > 0)", 48)],
)
def test_values_keep_native_totals_on_a_different_resolution(
    tmp_path: Path, formula: str, expected: float
) -> None:
    """Finer value cells contribute once each without changing population totals.

    Args:
        tmp_path: Isolated native model sources.
        formula: Existing scalar grammar expression to evaluate.
        expected: Independent reference result across 48 native cells.
    """
    pytest.importorskip("ecoshard.geoprocessing.routing")
    sources, request, limits = downstream_fixture(tmp_path / "sources", formula=formula)
    with rasterio.open(
        sources.rasters["values"],
        "w",
        driver="GTiff",
        width=12,
        height=4,
        count=1,
        dtype="int16",
        nodata=-9999,
        crs="EPSG:4326",
        transform=from_origin(0, 4, 0.5, 1),
    ) as target:
        target.write(np.ones((4, 12), dtype="int16"), 1)
    spec = plan_downstream(sources, request, limits)
    directory = tmp_path / "run"
    directory.mkdir()
    artifact = calculate_downstream(sources, spec, directory, limits)
    assert float(artifact.rows[0]["value"]) == expected


def test_cutoff_is_measured_from_original_seeds(tmp_path: Path) -> None:
    """A small straight-line cutoff retains seed cells and excludes downstream cells.

    Args:
        tmp_path: Native reference sources and results.
    """
    pytest.importorskip("ecoshard.geoprocessing.routing")
    sources, request, limits = downstream_fixture(tmp_path / "sources")
    request = request.model_copy(update={"cutoff_m": 1000})
    spec = plan_downstream(sources, request, limits)
    directory = tmp_path / "run"
    directory.mkdir()
    artifact = calculate_downstream(sources, spec, directory, limits)
    assert float(artifact.rows[0]["value"]) == 4


def test_filtered_vectors_form_one_mask_without_expanded_seeds(tmp_path: Path) -> None:
    """A filter selecting the first watershed seeds only it while flow reaches all three.

    Args:
        tmp_path: Native vector, terrain and result fixtures.
    """
    from eolab_app.vector.filters import VectorFilter
    from eolab_app.catalog_selection import ResolvedCatalogSelection

    pytest.importorskip("ecoshard.geoprocessing.routing")
    sources, request, limits = downstream_fixture(tmp_path / "sources")
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
    selected = replace(sources.network, selection=selection, where='"id" = 1')
    sources = DownstreamSources(sources.rasters, sources.network, selected)
    request = DownstreamRequest.model_validate(
        {
            **request.model_dump(mode="json", by_alias=True),
            "starting_mask": {"kind": "catalogSelection", "selection": selection},
        }
    )
    spec = plan_downstream(sources, request, limits)
    directory = tmp_path / "run"
    directory.mkdir()
    artifact = calculate_downstream(sources, spec, directory, limits)
    assert float(artifact.rows[0]["value"]) == 24
    with rasterio.open(directory / "starting_mask.tif") as mask:
        assert np.count_nonzero(mask.read(1) == 1) == 8


def test_model_worker_publishes_downstream_outputs_and_run_yaml(tmp_path: Path) -> None:
    """Registered dispatch uses the real supervised worker and ordinary artifact inventory.

    Args:
        tmp_path: Isolated catalog and owned artifact fixtures.
    """
    from eolab_app.processing.artifacts import LocalJobArtifacts
    from eolab_app.processing.worker import ProcessingWorker
    from eolab_app.processing.native_processes import create_native_process
    from eolab_app.processing.model_definitions import ModelRegistry
    from eolab_app.processing.model_operations import get_model_operation
    from eolab_app.processing.model_run_contracts import (
        ModelRunRequest,
        ModelJobResponse,
        RunDocument,
    )
    from eolab_app.processing.model_runs import (
        build_model_calculation_request,
        build_model_job_submission,
        export_model_job_yaml,
    )
    from eolab_app.processing.model_yaml import parse_yaml
    from eolab_app.processing.service import public_job
    from test_processing_worker_results import configure_prepared_job_store

    pytest.importorskip("ecoshard.geoprocessing.routing")
    sources, request, limits = downstream_fixture(tmp_path / "sources")
    registry = ModelRegistry.load_installed()
    definition = registry.get("downstream-beneficiaries", "1.0.0")
    submitted = ModelRunRequest(
        requestId=request.requestId,
        label=request.label,
        model={
            "id": definition.id,
            "version": definition.version,
            "definitionSha256": definition.digest,
        },
        inputs={
            "starting_mask": request.starting_mask.model_dump(
                mode="json", by_alias=True
            ),
            "hydrology": request.hydrology.reference.model_dump(),
            "values": request.values.model_dump(by_alias=True),
        },
        parameters={"buffer_m": 0, "cutoff_m": None, "summary": "sum(a)"},
    )
    calculation, invocation = build_model_calculation_request(
        submitted, registry, hydrology={"hydrology": request.hydrology}
    )
    operation = get_model_operation(definition.steps[0].operation)
    identities = {
        name: tuple(RasterSourceIdentity.read(path).to_catalog())
        for name, path in sources.rasters.items()
    }
    prepared = build_model_job_submission(
        operation.queue(calculation, None),
        invocation,
        identities["values"],
        {name: identities[name] for name in ("dem", "starting_mask")},
    )
    references = {
        request.values.item_id: sources.rasters["values"],
        request.hydrology.definition.dem.item_id: sources.rasters["dem"],
        request.starting_mask.source.item_id: sources.rasters["starting_mask"],
    }

    async def authorize(reference: Any) -> AuthorizedRaster:
        """Resolve a fixture catalog reference to its current native source identity.

        Args:
            reference: Path-free raster source requested by the worker.

        Returns:
            Native path and current stat identity.
        """
        path = references[reference.item_id]
        return AuthorizedRaster(path, RasterSourceIdentity.read(path))

    now = datetime.now(timezone.utc)
    row = {
        "id": "a" * 32,
        "attempt_id": "b" * 32,
        "operation": "model.run.v1",
        "spec": prepared.specification,
        "summary": prepared.summary,
        "retained_metadata": prepared.retained_metadata,
        "reserved_bytes": 0,
        "created_at": now,
        "updated_at": now,
        "expires_at": now + timedelta(hours=1),
        "status": "running",
        "progress": {},
        "error": None,
    }
    store = Mock()
    configure_prepared_job_store(store, row)
    store.claim_next_job.return_value = row
    store.heartbeat.return_value = True
    store.finish.return_value = True
    artifacts = LocalJobArtifacts(tmp_path / "artifacts")
    artifacts.initialize()
    native = create_native_process(limits)
    worker = ProcessingWorker(
        SimpleNamespace(authorize=authorize),
        store,
        artifacts,
        limits,
        native=native,
        areas=SimpleNamespace(
            resolve_for_sampling=AsyncMock(return_value=sources.network)
        ),
    )

    async def execute() -> bool:
        """Run one production-composed worker attempt and close its process lane.

        Returns:
            Whether the existing worker handled the queued attempt.
        """
        try:
            return await worker.run_once()
        finally:
            await native.close()

    assert asyncio.run(execute())
    artifact = store.finish.call_args.args[2]
    assert artifact is not None, store.finish.call_args
    ready = {
        **row,
        "status": "ready",
        "artifact": asdict(artifact),
        "retained_outcome": {"status": "ready", "artifact": asdict(artifact)},
    }
    response = ModelJobResponse.model_validate(public_job(ready))
    assert float(response.result.rows[0].value) == 24
    assert {file.name for file in response.artifacts.files} == {
        "statistics",
        "coverage",
        "starting_mask",
        "provenance",
    }
    document = RunDocument.model_validate(
        parse_yaml(export_model_job_yaml(ready, run=True), run=True)
    )
    assert set(document.execution.additionalSources) == {"dem", "starting_mask"}
    assert str(tmp_path) not in export_model_job_yaml(ready, run=True).decode()


def test_cancel_reaps_real_downstream_native_work_before_cleanup(
    tmp_path: Path,
) -> None:
    """Cancel a real routing calculation and verify no child or published files remain.

    Args:
        tmp_path: Original sources and Processing-owned attempt storage.
    """
    from multiprocessing import active_children
    from eolab_app.processing.artifacts import LocalJobArtifacts
    from eolab_app.processing.native_processes import create_native_process
    from eolab_app.processing.downstream_calculation import downstream_process_target

    pytest.importorskip("ecoshard.geoprocessing.routing")
    sources, request, limits = scaled_downstream_fixture(
        tmp_path / "sources", 1500, 1000
    )
    spec = plan_downstream(sources, request, limits)
    artifacts = LocalJobArtifacts(tmp_path / "artifacts")
    artifacts.initialize()
    attempt = "d" * 32
    directory = artifacts.prepare(attempt, spec.reservedBytes, limits)

    async def cancel_during_routing() -> None:
        """Wait for actual routing, then use the same cancellation boundary as the worker."""
        native = create_native_process(limits)
        task = asyncio.create_task(
            native.run(
                downstream_process_target,
                ("calculate", (sources, spec, directory, limits)),
                60,
            )
        )
        try:
            async with asyncio.timeout(45):
                while artifacts.progress(attempt).get("phase") != "routing_downstream":
                    assert not task.done(), task.result() if task.done() else None
                    await asyncio.sleep(0.01)
            pids = {child.pid for child in active_children()}
            assert pids
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert not pids.intersection(child.pid for child in active_children())
            assert not (directory / "result.csv").exists()
            artifacts.remove(attempt)
            assert not directory.exists()
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await native.close()

    asyncio.run(cancel_during_routing())


def test_routing_stops_at_real_sink_with_virtual_downstream_connection(
    tmp_path: Path,
) -> None:
    """NEXT_SINK-style termination excludes a virtual connection to another drainage.

    Args:
        tmp_path: Isolated prepared basin network and model outputs.
    """
    from shapely.geometry import box, mapping

    pytest.importorskip("ecoshard.geoprocessing.routing")
    sources, request, limits = downstream_fixture(tmp_path / "sources")
    topology = request.hydrology.definition.topology.model_dump(
        by_alias=True, exclude_none=True
    )
    topology["terminal"] = {"field": "sink", "equalsField": "id"}
    records = [
        {
            "id": i,
            "next": i + 1 if i < 3 else 0,
            "sink": 2 if i < 3 else 3,
            "geometry": mapping(box((i - 1) * 2, 0, i * 2, 4)),
        }
        for i in range(1, 4)
    ]
    definition, dem, network, _ = prepare_sources(
        tmp_path / "terminal",
        records=records,
        definition_changes={"topology": topology},
    )
    report = validate_hydrology_sources(
        definition, dem, network, HydrologyValidationLimits()
    )
    sources = replace(
        sources, rasters={**sources.rasters, "dem": dem.source_path}, network=network
    )
    request = request.model_copy(update={"hydrology": report})
    spec = plan_downstream(sources, request, limits)
    assert spec.watersheds == (1, 2)
    directory = tmp_path / "run"
    directory.mkdir()
    artifact = calculate_downstream(sources, spec, directory, limits)
    assert float(artifact.rows[0]["value"]) == 16


def test_overlapping_starting_features_count_each_value_once(tmp_path: Path) -> None:
    """Combined overlapping vector features create one seed mask and one native total.

    Args:
        tmp_path: Original starting features, prepared terrain and run directory.
    """
    from catalog_selection_support import write_selection
    from shapely.geometry import box, mapping

    pytest.importorskip("ecoshard.geoprocessing.routing")
    sources, request, limits = downstream_fixture(tmp_path / "sources")
    starting = write_selection(
        tmp_path / "starts.gpkg", [mapping(box(0, 0, 2, 4)), mapping(box(1, 0, 3, 4))]
    )
    sources = replace(sources, starting=starting)
    request = DownstreamRequest.model_validate(
        {
            **request.model_dump(mode="json", by_alias=True),
            "starting_mask": {
                "kind": "catalogSelection",
                "selection": starting.selection,
            },
        }
    )
    spec = plan_downstream(sources, request, limits)
    directory = tmp_path / "run"
    directory.mkdir()
    artifact = calculate_downstream(sources, spec, directory, limits)
    assert float(artifact.rows[0]["value"]) == 24
    with rasterio.open(directory / "starting_mask.tif") as dataset:
        assert np.count_nonzero(dataset.read(1) == 1) == 12


def test_buffer_boundary_is_inclusive_in_metres() -> None:
    """A center exactly at the WGS84 distance threshold is included, one beyond is not."""
    from pyproj import Geod

    pytest.importorskip("scipy")
    lon = np.array([[0.0, 0.01, 0.010001]])
    lat = np.full_like(lon, 60)
    distance = Geod(ellps="WGS84").inv(0, 60, 0.01, 60)[2]
    assert within_geodesic_distance(
        lon, lat, np.array([[True, False, False]]), distance
    ).tolist() == [[True, True, False]]


def test_native_seed_mask_excludes_zero_negative_and_nodata(tmp_path: Path) -> None:
    """Only valid positive cells seed routing even when nearby mask values exist.

    Args:
        tmp_path: Native mask values and run outputs.
    """
    pytest.importorskip("ecoshard.geoprocessing.routing")
    sources, request, limits = downstream_fixture(tmp_path / "sources")
    with rasterio.open(sources.rasters["starting_mask"], "r+") as dataset:
        dataset.write(np.tile([1, 0, -1, -9999, 0, 0], (4, 1)).astype("int16"), 1)
    spec = plan_downstream(sources, request, limits)
    directory = tmp_path / "run"
    directory.mkdir()
    calculate_downstream(sources, spec, directory, limits)
    with rasterio.open(directory / "starting_mask.tif") as dataset:
        assert np.count_nonzero(dataset.read(1) == 1) == 4
