"""Run Habitat condition through existing Processing source and worker contracts."""

from typing import Any, Callable

from eolab_app.bounded_vector import summary_process
from eolab_app.catalog_selection import VectorSelection
from eolab_app.processing.aggregate_models import AggregateArea, RasterAggregateLimits
from eolab_app.processing.habitat_calculation import (
    HabitatSources,
    habitat_process_target,
)
from eolab_app.processing.habitat_models import (
    HabitatPlan,
    HabitatRequest,
    HabitatSettings,
    QueuedHabitat,
    VectorReferenceSites,
)
from eolab_app.processing.models import PreparedJobPlan, ProcessingError
from eolab_app.processing.operation_context import OperationContext
from eolab_app.processing.polygon_areas import PolygonAreaReference
from eolab_app.processing.raster_operations import bind_area_arguments
from eolab_app.raster.models import AuthorizedRaster
from eolab_app.raster.source_models import RasterSourceReference


def bind_habitat(
    inputs: dict[str, Any], parameters: dict[str, Any], request_id: str, label: str
) -> HabitatRequest:
    """Bind the recipe's explicit layer choices and settings to a Habitat request.

    Args:
        inputs: Validated layers, area, preparation choices and fixed settings.
        parameters: Empty mapping; scientific settings come from the recipe.
        request_id: Submission identifier retained by the model-run service.
        label: Run name retained by the model-run service.

    Returns:
        Path-free operation inputs using the existing assessment-area fields.

    Raises:
        ValidationError: If the selected layers or settings are invalid.
    """
    return HabitatRequest(
        stack=inputs["stack"],
        references=inputs["references"],
        habitat_mask=inputs["habitat_mask"],
        preparation=inputs["preparation"],
        settings=inputs["settings"],
        **bind_area_arguments(inputs["area"]),
    )


def get_habitat_request(
    value: HabitatRequest | QueuedHabitat | HabitatPlan,
) -> HabitatRequest:
    """Return the captured inputs from a request, queued job or prepared plan.

    Args:
        value: Validated Habitat inputs at any stage of the job.

    Returns:
        The request containing the selected layer identities and fixed settings.
    """
    if isinstance(value, QueuedHabitat):
        return value.request
    return value.inputs if isinstance(value, HabitatPlan) else value


def get_habitat_source(
    value: HabitatRequest | QueuedHabitat | HabitatPlan,
) -> RasterSourceReference:
    """Return the first predictor for admission and the whole-raster area choice.

    Args:
        value: Validated request or saved specification.

    Returns:
        The predictor's Catalog or owned result-file reference.
    """
    return get_habitat_request(value).stack.predictors[0].source


def get_additional_habitat_sources(
    value: HabitatRequest | QueuedHabitat | HabitatPlan,
) -> dict[str, RasterSourceReference]:
    """Declare the remaining rasters for ordinary authorization and retention.

    Keys identify captured stack positions, with predictor_0 reserved for the
    primary source. Variable names are retained separately for scientific outputs.

    Args:
        value: Validated request or saved specification.

    Returns:
        Additional predictors, responses, raster references and optional habitat mask.
    """
    sources = get_habitat_request(value).get_raster_sources()
    sources.pop("predictor_0")
    return sources


def get_habitat_vector_selections(
    request: HabitatRequest,
) -> dict[str, VectorSelection]:
    """Return independently selected AOI and reference vectors for upload retention.

    Args:
        request: Validated Habitat inputs.

    Returns:
        Vector descriptors keyed by area or reference_sites, when selected.
    """
    selections = {}
    if request.catalogSelection is not None:
        selections["area"] = request.catalogSelection
    if isinstance(request.references, VectorReferenceSites):
        selections["reference_sites"] = request.references.selection
    return selections


def get_habitat_polygon(request: HabitatRequest) -> PolygonAreaReference | None:
    """Return an owned polygon-area input that admission must retain for this run.

    Args:
        request: Validated Habitat inputs.

    Returns:
        The polygon input reference, or None for other assessment-area choices.
    """
    return request.polygonArea


def build_habitat_submission(
    request: HabitatRequest, polygons: AggregateArea | None
) -> PreparedJobPlan:
    """Queue selected Habitat inputs without opening raster or vector data.

    Args:
        request: Validated layer selections and scientific settings.
        polygons: Owned polygon input copied by ordinary Processing admission.

    Returns:
        A durable, path-free request for an independent model run.
    """
    queued = QueuedHabitat(request=request, polygonArea=polygons)
    return PreparedJobPlan(
        operation=queued.operation,
        specification=queued.model_dump(mode="json", by_alias=True),
        summary={},
        reserved_bytes=0,
    )


async def resolve_habitat_sources(
    context: OperationContext, request: HabitatRequest, primary: AuthorizedRaster
) -> HabitatSources:
    """Resolve the selected vectors and collect authorized raster paths for native work.

    Args:
        context: Existing worker capabilities and authorized additional rasters.
        request: Captured layer and area selections.
        primary: First predictor already authorized by the worker.

    Returns:
        Ephemeral native sources; no paths or resolved vectors enter stored inputs.

    Raises:
        ProcessingError: If vector reading is unavailable.
        SelectionUnavailableError: If a selected vector cannot be read.
    """
    selections = get_habitat_vector_selections(request)
    if selections and context.areas is None:
        raise ProcessingError(
            "selection_unavailable", "Vector selection reader is unavailable.", 409
        )
    vectors = {
        name: await context.areas.resolve_for_sampling(selection)
        for name, selection in selections.items()
    }
    return HabitatSources(
        rasters={
            "predictor_0": primary.source_path,
            **{name: source.source_path for name, source in context.rasters.items()},
        },
        vectors=vectors,
    )


async def prepare_habitat(
    context: OperationContext, queued: QueuedHabitat, primary: AuthorizedRaster
) -> PreparedJobPlan:
    """Prepare the selected area and requested grid in the supervised worker process.

    Args:
        context: Existing source, lifecycle and native-execution capabilities.
        queued: Accepted inputs and any retained polygon-area geometry.
        primary: Authorized first predictor.

    Returns:
        A saved Habitat plan with its area descriptor and aligned output grid.

    Raises:
        ProcessingError: If selected features or native planning cannot be read.
        SelectionUnavailableError: If a selected vector is unavailable.
    """
    request = queued.request
    sources = await resolve_habitat_sources(context, request, primary)
    if queued.polygonArea is not None:
        area = queued.polygonArea
    elif request.wholeRaster:
        area = AggregateArea(kind="wholeRaster")
    elif request.selectedBounds is not None:
        area = AggregateArea(
            kind="bounds", bounds=request.selectedBounds.canonical_tuple()
        )
    else:
        resolved = sources.vectors["area"]
        success, summary = await context.run_native(
            summary_process, (resolved, None), None, context.native
        )
        if not success:
            raise ProcessingError("selection_unavailable", summary, 409)
        area = AggregateArea(
            kind="catalogSelection",
            bounds=summary["bbox"],
            catalogSelection=request.catalogSelection,
        )
    status, plan = await context.run_native(
        habitat_process_target,
        ("plan", (sources, request, area)),
        None,
        context.native,
    )
    if status != "ok":
        raise ProcessingError(*plan)
    return PreparedJobPlan(
        operation=plan.operation,
        specification=plan.model_dump(mode="json", by_alias=True),
        summary={},
        reserved_bytes=0,
    )


async def prepare_habitat_execution(
    context: OperationContext, spec: HabitatPlan, primary: AuthorizedRaster
) -> tuple[HabitatSources, HabitatPlan]:
    """Resolve original sources for an accepted plan without changing its settings.

    Args:
        context: Worker capabilities and authorized additional rasters.
        spec: Saved area, grid and scientific settings.
        primary: Authorized first predictor.

    Returns:
        Ephemeral native inputs and the unchanged execution plan.

    Raises:
        ProcessingError: If vector reading is unavailable.
        SelectionUnavailableError: If a selected vector cannot be read.
    """
    return await resolve_habitat_sources(context, spec.inputs, primary), spec


def select_habitat_execution(
    spec: HabitatPlan, context: OperationContext
) -> tuple[Callable[..., None], str, RasterAggregateLimits]:
    """Select the Habitat native target and existing Processing lifecycle settings.

    Args:
        spec: Prepared Habitat plan.
        context: Worker execution capabilities.

    Returns:
        Native calculation target, action and shared lifecycle settings.
    """
    return habitat_process_target, "calculate", context.aggregate_limits


def describe_habitat_policy(spec: HabitatPlan) -> HabitatSettings:
    """Return the scientific settings captured for Run YAML provenance.

    Args:
        spec: Prepared Habitat plan.

    Returns:
        The fixed settings used for sampling, fitting and prediction.
    """
    return spec.inputs.settings
