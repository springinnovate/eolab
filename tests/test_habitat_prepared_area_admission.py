"""Check prepared-area policy where model requests become durable Processing jobs."""

import asyncio
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eolab_app.catalog_selection import (
    CatalogSelection,
    CatalogSelectionReader,
    SelectionUnavailableError,
)
from eolab_app.polygon_areas import PolygonAreaReference, PolygonSummaryInput
from eolab_app.processing import habitat_cache
from eolab_app.processing.aggregate_models import AggregateArea
from eolab_app.processing.habitat_earth_engine import HabitatCacheCoverage
from eolab_app.processing.habitat_models import HabitatEarthEngineStack, QueuedHabitat
from eolab_app.processing.habitat_prepared_areas import (
    HabitatPreparedArea,
    HabitatPreparedAreaStore,
    get_habitat_prepared_area_id,
)
from eolab_app.processing.model_definitions import ModelRegistry
from eolab_app.processing.model_operations import get_model_operation
from eolab_app.processing.model_run_contracts import ModelRunRequest, ModelRunSpec
from eolab_app.processing.model_runs import (
    build_model_calculation_request,
    build_model_job_submission,
    read_model_invocation,
)
from eolab_app.processing.models import PreparedJobPlan, ProcessingError
from eolab_app.processing.ports import JobStore
from eolab_app.processing.service import ProcessingService
from eolab_app.raster.models import AuthorizedRaster
from eolab_app.raster.source_identity import RasterSourceIdentity
from eolab_app.routes.processing import create_processing_router
from raster_source_support import SOURCE

OWNER = "prepared-area-browser"
BOUNDS_AREA: dict[str, Any] = {
    "kind": "selectedArea",
    "selectedBounds": {"west": 0, "south": 0, "east": 2, "north": 2},
}
POLYGON_REFERENCE = {"id": "a" * 32, "sha256": "b" * 64}


def _selection(item_id: str = "prepared-aoi") -> CatalogSelection:
    """Return an exact filtered Catalog descriptor for an assessment or reference area.

    Args:
        item_id: Catalog identity, allowing references to use an independent source.

    Returns:
        Original source, asset, layer and predicate without geometry or paths.
    """
    return CatalogSelection.model_validate(
        {
            "collectionId": "eolab-mounted-vectors",
            "itemId": item_id,
            "assetKey": "data",
            "layerName": "regions",
            "filter": {
                "enabled": True,
                "match": "all",
                "rules": [{"field": "ZONE", "operator": "eq", "value": "North"}],
            },
        }
    )


def _request(registry: ModelRegistry, **input_changes: Any) -> ModelRunRequest:
    """Build an ordinary public request using the installed Habitat recipe.

    Args:
        registry: Installed recipes used by the real model-binding boundary.
        **input_changes: Explicit alternate input choices for one scenario.

    Returns:
        Validated public request with a fresh retry identity.
    """
    definition = registry.get("habitat-condition", "1.0.0")
    inputs = {
        "stack": HabitatEarthEngineStack(kind="earthEngine", year=2018).model_dump(
            mode="json"
        ),
        "area": {
            "kind": "catalogSelection",
            "selection": _selection().model_dump(mode="json", by_alias=True),
        },
        "references": {
            "kind": "vector",
            "selection": _selection("reference-sites").model_dump(
                mode="json", by_alias=True
            ),
        },
        "habitat_mask": None,
        "preparation": {
            "crs": "EPSG:6933",
            "pixelSize": [500, 500],
            "origin": [0, 0],
            "resampling": {},
        },
        **input_changes,
    }
    return ModelRunRequest.model_validate(
        {
            "requestId": uuid4().hex,
            "model": {
                "id": definition.id,
                "version": definition.version,
                "definitionSha256": definition.digest,
            },
            "label": "Prepared-area run",
            "utcOffsetMinutes": 0,
            "inputs": inputs,
            "parameters": {},
        }
    )


def _queued_row(plan: PreparedJobPlan, request_hash: str) -> dict[str, Any]:
    """Represent storage's queued result while preserving the real admitted plan.

    Args:
        plan: Plan produced by real recipe binding and model job serialization.
        request_hash: Service-owned identity used to recover accepted retries.

    Returns:
        Row accepted by the ordinary model response and saved-invocation readers.
    """
    now = datetime.now(timezone.utc)
    return {
        "id": uuid4().hex,
        "operation": plan.operation,
        "request_hash": request_hash,
        "status": "queued",
        "specification": plan.specification,
        "summary": plan.summary,
        "presentation": plan.presentation or {"utcOffsetMinutes": 0},
        "retained_metadata": plan.retained_metadata,
        "created_at": now,
        "updated_at": now,
        "expires_at": now + timedelta(days=7),
        "metadata_expires_at": now + timedelta(days=7),
        "progress": {},
        "artifact": None,
        "error": None,
    }


def _manual_request(registry: ModelRegistry) -> ModelRunRequest:
    """Choose custom rasters and ordinary bounds independently of preparation areas.

    Args:
        registry: Installed recipe used by actual model binding.

    Returns:
        Custom raster request retaining separate predictor and response roles.
    """
    return _request(
        registry,
        stack={
            "predictors": [{"name": "land_class", "source": SOURCE}],
            "responses": [{"name": "productivity", "source": SOURCE}],
            "categoricalPredictor": "land_class",
        },
        area=BOUNDS_AREA,
        preparation={
            "crs": "EPSG:6933",
            "pixelSize": [500, 500],
            "origin": [0, 0],
            "resampling": {"predictor_0": "nearest", "response_0": "nearest"},
        },
    )


@dataclass
class AdmissionBoundary:
    """Keep the real service and recording doubles for its external dependencies.

    Attributes:
        service: Actual model admission, retry and serialization implementation.
        jobs: Recording storage adapter returning complete queued job rows.
        prepared_areas: Durable registry containing only the assessment selection.
        coverage: Current cache inspection replaced at its I/O boundary.
        selections: Original vector reader passed through to cache inspection.
        cache_directory: Server-controlled cache root supplied by composition.
        raster_authorizer: Original-source authorization for independent raster roles.
    """

    service: ProcessingService
    jobs: Mock
    prepared_areas: Mock
    coverage: AsyncMock
    selections: Mock
    cache_directory: Path
    raster_authorizer: Mock


@pytest.fixture
def admission_boundary(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> AdmissionBoundary:
    """Compose admission with recording persistence and no native cache reads.

    Args:
        monkeypatch: Replace external cache inspection for each isolated scenario.
        tmp_path: Server-controlled source and cache locations, never public inputs.

    Returns:
        Service boundary using actual installed model and persisted-request contracts.
    """
    rows: dict[tuple[str, str], dict[str, Any]] = {}
    jobs = Mock(spec=JobStore)
    jobs.find_request.side_effect = lambda owner, request_id: rows.get(
        (owner, request_id)
    )

    def submit(
        owner: str, request_id: str, plan: PreparedJobPlan, request_hash: str
    ) -> dict[str, Any]:
        """Record an accepted plan and make its retry available to the service.

        Args:
            owner: Session owning this request.
            request_id: Retry identity supplied by that session.
            plan: Real serialized plan accepted by Processing.
            request_hash: Hash of the submitted public request.

        Returns:
            Complete queued row retaining the exact accepted plan.
        """
        row = _queued_row(plan, request_hash)
        rows[owner, request_id] = row
        return row

    jobs.submit.side_effect = submit
    selection = _selection()
    area = HabitatPreparedArea(
        id=get_habitat_prepared_area_id(selection),
        name="Northern area",
        selection=selection,
    )
    prepared_areas = Mock(spec=HabitatPreparedAreaStore)
    prepared_areas.find.side_effect = lambda requested: (
        area if requested == selection else None
    )
    coverage = AsyncMock(return_value=HabitatCacheCoverage("a" * 64, 2018, 4, 2, 2))
    monkeypatch.setattr(habitat_cache, "get_habitat_cache_coverage", coverage)
    selections = Mock(spec=CatalogSelectionReader)
    cache_directory = tmp_path / "habitat-cache"
    raster_authorizer = Mock()
    raster_authorizer.authorize = AsyncMock(
        return_value=AuthorizedRaster(
            tmp_path / "authorized.tif", RasterSourceIdentity(1, 20, 30, 40)
        )
    )
    service = ProcessingService(
        jobs,
        Mock(),
        model_registry=ModelRegistry.load_installed(),
        model_authorizer=raster_authorizer,
        areas=selections,
        habitat_prepared_areas=prepared_areas,
        habitat_cache_directory=cache_directory,
    )
    return AdmissionBoundary(
        service,
        jobs,
        prepared_areas,
        coverage,
        selections,
        cache_directory,
        raster_authorizer,
    )


@pytest.mark.parametrize("cached_tiles", [0, 2, 4])
def test_current_coverage_controls_admission_without_changing_captured_inputs(
    admission_boundary: AdmissionBoundary, cached_tiles: int
) -> None:
    """Block zero coverage, accept partial/full coverage and retain independent references.

    Args:
        admission_boundary: Actual service with one registered assessment selection.
        cached_tiles: Current availability for the requested area and year.
    """
    boundary = admission_boundary
    boundary.coverage.return_value = HabitatCacheCoverage(
        "a" * 64, 2018, 4, cached_tiles, 4 - cached_tiles
    )
    request = _request(boundary.service.model_registry)
    if cached_tiles == 0:
        with pytest.raises(ProcessingError) as error:
            asyncio.run(boundary.service.submit_model_run(OWNER, request))
        assert error.value.code == "habitat_inputs_not_prepared"
        assert error.value.status == 409
        boundary.jobs.submit.assert_not_called()
    else:
        response = asyncio.run(boundary.service.submit_model_run(OWNER, request))
        assert response["status"] == "queued"
        plan = boundary.jobs.submit.call_args.args[2]
        queued = ModelRunSpec.model_validate(plan.specification).calculation
        assert isinstance(queued, QueuedHabitat)
        assert queued.request.catalogSelection == _selection()
        assert queued.request.references.selection == _selection("reference-sites")
        assert plan.retained_metadata["invocation"]["inputs"] == request.inputs
        assert queued.request.stack == HabitatEarthEngineStack(
            kind="earthEngine", year=2018
        )
    boundary.prepared_areas.find.assert_called_once_with(_selection())
    boundary.coverage.assert_awaited_once_with(
        _selection(), 2018, boundary.selections, boundary.cache_directory
    )


@pytest.mark.parametrize(
    "area",
    [
        BOUNDS_AREA,
        {"kind": "polygonArea", "reference": POLYGON_REFERENCE},
        {
            "kind": "catalogSelection",
            "selection": {
                "uploadId": "01234567-89ab-4cde-8f01-23456789abcd",
                "layerName": "regions",
                "filter": {"enabled": True, "match": "all", "rules": []},
            },
        },
    ],
    ids=["bounds", "drawing", "upload"],
)
def test_arbitrary_earth_engine_areas_are_rejected_before_private_input_reads(
    admission_boundary: AdmissionBoundary, area: dict[str, Any]
) -> None:
    """Reject valid but unprepared area choices before geometry retention or queueing.

    Args:
        admission_boundary: Real service with no need to read private polygons.
        area: Public area choice that used to be accepted for Earth Engine inputs.
    """
    boundary = admission_boundary
    request = _request(boundary.service.model_registry, area=area)
    with pytest.raises(ProcessingError) as error:
        asyncio.run(boundary.service.submit_model_run(OWNER, request))
    assert error.value.code == "habitat_prepared_area_required"
    assert error.value.status == 422
    boundary.prepared_areas.find.assert_not_called()
    boundary.coverage.assert_not_awaited()
    boundary.jobs.get_input.assert_not_called()
    boundary.jobs.submit.assert_not_called()


@pytest.mark.parametrize(
    "changes",
    [
        {"itemId": "different-item"},
        {"assetKey": "different-asset"},
        {"layerName": "different-layer"},
        {"filter": {"enabled": False, "match": "all", "rules": []}},
        {
            "filter": {
                "enabled": True,
                "match": "all",
                "rules": [{"field": "ZONE", "operator": "eq", "value": "South"}],
            }
        },
    ],
    ids=["item", "asset", "layer", "disabled-filter", "different-features"],
)
def test_forged_selection_is_not_admitted_by_another_areas_cached_tiles(
    admission_boundary: AdmissionBoundary, changes: dict[str, Any]
) -> None:
    """Require the registered exact descriptor before asking about cached coverage.

    Args:
        admission_boundary: Registry containing only the original selection.
        changes: One valid alteration to its source or feature predicate.
    """
    boundary = admission_boundary
    selection = {**_selection().model_dump(mode="json", by_alias=True), **changes}
    request = _request(
        boundary.service.model_registry,
        area={"kind": "catalogSelection", "selection": selection},
    )
    with pytest.raises(ProcessingError) as error:
        asyncio.run(boundary.service.submit_model_run(OWNER, request))
    assert error.value.code == "habitat_prepared_area_unavailable"
    assert error.value.status == 409
    boundary.coverage.assert_not_awaited()
    boundary.jobs.submit.assert_not_called()


def test_accepted_retry_recovers_before_registry_coverage_or_model_revalidation(
    admission_boundary: AdmissionBoundary,
) -> None:
    """Recover accepted work during dependency outages without admitting a new run.

    Args:
        admission_boundary: Recording jobs whose accepted retry remains available.
    """
    boundary = admission_boundary
    request = _request(boundary.service.model_registry)
    accepted = asyncio.run(boundary.service.submit_model_run(OWNER, request))
    boundary.prepared_areas.find.side_effect = AssertionError("registry unavailable")
    boundary.coverage.side_effect = AssertionError("cache unavailable")
    boundary.service.model_registry = Mock()
    boundary.service.model_registry.get.side_effect = AssertionError("recipe removed")
    recovered = asyncio.run(boundary.service.submit_model_run(OWNER, request))
    assert recovered == accepted
    boundary.jobs.submit.assert_called_once()
    assert boundary.coverage.await_count == 1
    assert boundary.prepared_areas.find.call_count == 1
    changed = request.model_dump(mode="json")
    changed["label"] = "Conflicting request"
    with pytest.raises(ProcessingError) as error:
        asyncio.run(
            boundary.service.submit_model_run(
                OWNER, ModelRunRequest.model_validate(changed)
            )
        )
    assert error.value.code == "request_conflict"
    boundary.jobs.submit.assert_called_once()


def test_source_authorization_failure_blocks_admission_before_persistence(
    admission_boundary: AdmissionBoundary,
) -> None:
    """Keep the original-source authorization boundary even for a registered area.

    Args:
        admission_boundary: Real service with a source-reader failure from coverage.
    """
    boundary = admission_boundary
    failure = SelectionUnavailableError("The selected Catalog layer is unavailable.")
    boundary.coverage.side_effect = failure
    request = _request(boundary.service.model_registry)
    with pytest.raises(ProcessingError) as error:
        asyncio.run(boundary.service.submit_model_run(OWNER, request))
    assert error.value.code == "selection_unavailable"
    assert error.value.detail == failure.detail
    assert error.value.status == 409
    assert error.value.__cause__ is failure
    boundary.jobs.submit.assert_not_called()


def test_model_http_reports_unavailable_prepared_source_without_queueing(
    admission_boundary: AdmissionBoundary,
) -> None:
    """Translate original-source denial to the model API's actionable conflict response.

    Args:
        admission_boundary: Actual admission service whose registered source is gone.
    """
    boundary = admission_boundary
    boundary.coverage.side_effect = SelectionUnavailableError(
        "The selected Catalog layer is unavailable."
    )
    request = _request(boundary.service.model_registry)
    application = FastAPI()
    application.include_router(create_processing_router(boundary.service))
    with TestClient(application, base_url="https://testserver") as client:
        response = client.post(
            "/api/processing/model-runs",
            json=request.model_dump(mode="json"),
            headers={"X-EOLab-Processing": "1"},
        )
    assert response.status_code == 409
    assert response.json() == {
        "detail": {
            "code": "selection_unavailable",
            "message": "The selected Catalog layer is unavailable.",
        }
    }
    boundary.jobs.submit.assert_not_called()


def test_manual_rasters_keep_arbitrary_areas_without_preparation_dependencies(
    admission_boundary: AdmissionBoundary,
) -> None:
    """Keep custom raster admission and authorization independent of prepared areas.

    Args:
        admission_boundary: Service whose prepared-area dependencies are unavailable.
    """
    boundary = admission_boundary
    boundary.service.habitat_prepared_areas = None
    boundary.service.habitat_cache_directory = None
    boundary.service.areas = None
    boundary.coverage.side_effect = AssertionError("manual mode must not inspect cache")
    request = _manual_request(boundary.service.model_registry)
    response = asyncio.run(boundary.service.submit_model_run(OWNER, request))
    assert response["status"] == "queued"
    boundary.coverage.assert_not_awaited()
    boundary.prepared_areas.find.assert_not_called()
    assert boundary.raster_authorizer.authorize.await_count == 2
    plan = boundary.jobs.submit.call_args.args[2]
    assert plan.retained_metadata["invocation"]["inputs"] == request.inputs


def test_concurrent_admission_waits_for_native_cleanup_without_blocking_manual_runs(
    admission_boundary: AdmissionBoundary,
) -> None:
    """Retain inspection capacity through cancellation and admit custom rasters independently.

    Args:
        admission_boundary: Real service with a controlled native inspection lifecycle.
    """
    boundary = admission_boundary
    first_request = _request(boundary.service.model_registry)
    waiting_request = _request(boundary.service.model_registry)
    manual_request = _manual_request(boundary.service.model_registry)
    next_request = _request(boundary.service.model_registry)

    async def exercise_concurrent_submissions() -> None:
        """Observe two competing requests and cancellation before allowing child cleanup."""
        loop = asyncio.get_running_loop()
        inspection_started = asyncio.Event()
        second_registration_read = asyncio.Event()
        cleanup_started = asyncio.Event()
        cleanup_finished = asyncio.Event()
        registered_area = boundary.prepared_areas.find(_selection())
        boundary.prepared_areas.find.reset_mock()
        registrations = 0
        inspections = 0

        def find(selection: CatalogSelection) -> HabitatPreparedArea | None:
            """Signal that the competing request has reached exact registry lookup.

            Args:
                selection: The request's Catalog descriptor.

            Returns:
                The one registered assessment area, or None for another selection.
            """
            nonlocal registrations
            registrations += 1
            if registrations == 2:
                loop.call_soon_threadsafe(second_registration_read.set)
            return registered_area if selection == registered_area.selection else None

        async def inspect(
            selection: CatalogSelection,
            year: int,
            reader: CatalogSelectionReader,
            cache_directory: Path,
        ) -> HabitatCacheCoverage:
            """Keep the first native read alive until cancellation cleanup completes.

            Args:
                selection: Authorized descriptor passed by real admission.
                year: Requested assessment year.
                reader: Original-source reader supplied by composition.
                cache_directory: Configured cache location.

            Returns:
                Partial coverage for a later request after the first child exits.

            Raises:
                asyncio.CancelledError: After the first inspection's cleanup completes.
            """
            nonlocal inspections
            inspections += 1
            if inspections == 1:
                inspection_started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cleanup_started.set()
                    await cleanup_finished.wait()
            return HabitatCacheCoverage("a" * 64, year, 4, 2, 2)

        boundary.prepared_areas.find.side_effect = find
        boundary.coverage.side_effect = inspect
        first = asyncio.create_task(
            boundary.service.submit_model_run(OWNER, first_request)
        )
        waiting: asyncio.Task[dict[str, Any]] | None = None
        try:
            await asyncio.wait_for(inspection_started.wait(), timeout=10)
            waiting = asyncio.create_task(
                boundary.service.submit_model_run(OWNER, waiting_request)
            )
            await asyncio.wait_for(second_registration_read.wait(), timeout=10)
            first.cancel()
            await asyncio.wait_for(cleanup_started.wait(), timeout=10)
            manual = await asyncio.wait_for(
                boundary.service.submit_model_run(OWNER, manual_request), timeout=10
            )
            assert manual["status"] == "queued"
            assert not waiting.done()
            assert boundary.coverage.await_count == 1
            waiting.cancel()
            with pytest.raises(asyncio.CancelledError):
                await waiting
            assert boundary.jobs.submit.call_count == 1
            cleanup_finished.set()
            with pytest.raises(asyncio.CancelledError):
                await first
            accepted = await asyncio.wait_for(
                boundary.service.submit_model_run(OWNER, next_request), timeout=10
            )
            assert accepted["status"] == "queued"
            assert boundary.coverage.await_count == 2
            assert boundary.jobs.submit.call_count == 2
        finally:
            cleanup_finished.set()
            for task in (first, waiting):
                if task is not None and not task.done():
                    task.cancel()
            await asyncio.gather(
                *(task for task in (first, waiting) if task is not None),
                return_exceptions=True,
            )

    asyncio.run(exercise_concurrent_submissions())


def test_drawn_references_and_raster_mask_remain_independent_inputs(
    admission_boundary: AdmissionBoundary, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Copy owned reference polygons and authorize the mask separately from AOI policy.

    Args:
        admission_boundary: Real service with a registered assessment area.
        monkeypatch: Supply the geometry already authorized by polygon-input storage.
    """
    boundary = admission_boundary
    polygons = PolygonSummaryInput(
        polygons=(
            {
                "type": "Polygon",
                "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
            },
        ),
    )
    reference = PolygonAreaReference(id="a" * 32, sha256=polygons.geometry_hash())
    reference_geometry = AggregateArea(
        kind="polygons",
        bounds=polygons.bounds(),
        geometryHash=reference.sha256,
        geometries=tuple(
            polygon.model_dump(mode="json") for polygon in polygons.polygons
        ),
    )
    read_polygon = AsyncMock(return_value=reference_geometry)
    monkeypatch.setattr(boundary.service, "read_polygon_area", read_polygon)
    request = _request(
        boundary.service.model_registry,
        references={
            "kind": "polygonArea",
            "reference": reference.model_dump(mode="json"),
        },
        habitat_mask=SOURCE,
        preparation={
            "crs": "EPSG:6933",
            "pixelSize": [500, 500],
            "origin": [0, 0],
            "resampling": {"habitat_mask": "nearest"},
        },
    )
    response = asyncio.run(boundary.service.submit_model_run(OWNER, request))
    assert response["status"] == "queued"
    plan = boundary.jobs.submit.call_args.args[2]
    queued = ModelRunSpec.model_validate(plan.specification).calculation
    assert isinstance(queued, QueuedHabitat)
    assert queued.referencePolygons == reference_geometry
    assert queued.polygonArea is None
    assert queued.request.references.reference == reference
    read_polygon.assert_awaited_once_with(OWNER, reference)
    boundary.raster_authorizer.authorize.assert_awaited_once_with(
        queued.request.habitat_mask
    )
    boundary.prepared_areas.find.assert_called_once_with(_selection())


def test_old_arbitrary_area_run_remains_readable_but_new_duplicate_is_rejected(
    admission_boundary: AdmissionBoundary,
) -> None:
    """Preserve saved invocation inspection without grandfathering new arbitrary AOIs.

    Args:
        admission_boundary: Current service enforcing prepared-area admission.
    """
    boundary = admission_boundary
    request = _request(boundary.service.model_registry, area=BOUNDS_AREA)
    calculation, invocation = build_model_calculation_request(
        request, boundary.service.model_registry
    )
    operation = get_model_operation(invocation.model.definition.steps[0].operation)
    historical_plan = build_model_job_submission(
        operation.queue(calculation, {}), invocation, None
    )
    historical_row = _queued_row(historical_plan, "historical-request")
    saved = read_model_invocation(historical_row)
    assert saved.inputs["area"] == BOUNDS_AREA
    duplicate = deepcopy(request.model_dump(mode="json"))
    duplicate["requestId"] = uuid4().hex
    duplicate["inputs"] = saved.inputs
    with pytest.raises(ProcessingError) as error:
        asyncio.run(
            boundary.service.submit_model_run(
                OWNER, ModelRunRequest.model_validate(duplicate)
            )
        )
    assert error.value.code == "habitat_prepared_area_required"
    boundary.jobs.submit.assert_not_called()
