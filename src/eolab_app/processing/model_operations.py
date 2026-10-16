"""Register trusted operations available to YAML models and the Processing worker.

Adding a recipe reuses this registry. Adding an algorithm requires an operation
adapter with its own contracts; YAML never imports or executes arbitrary Python.
"""

from pathlib import Path
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Awaitable, Callable, Generic, Literal, TypeVar
from pydantic import BaseModel, JsonValue, TypeAdapter

from eolab_app.processing.models import Artifact, PreparedJobPlan, ProcessingError
from eolab_app.processing.polygon_areas import PolygonAreaReference
from eolab_app.processing.aggregate_models import (
    AggregateJobRequest,
    AggregateSpec,
    UnpreparedCalculation,
    AggregateArea,
)
from eolab_app.processing.clip_models import ClipJobRequest, ClipSpec, UnpreparedClip
from eolab_app.raster.models import AuthorizedRaster
from eolab_app.raster.source_models import RasterSourceReference
from eolab_app.processing import raster_operations as raster
from eolab_app.processing.operation_context import OperationContext
from eolab_app.processing import downstream_operation as downstream
from eolab_app.processing.downstream_models import (
    DownstreamRequest,
    QueuedDownstream,
    DownstreamPlan,
    DownstreamPolicy,
    StartingMask,
)
from eolab_app.processing.prepared_hydrology import HydrologyReference, HydrologySources

Request = TypeVar("Request", bound=BaseModel)
Queued = TypeVar("Queued", bound=BaseModel)
Prepared = TypeVar("Prepared", bound=BaseModel)


@dataclass(frozen=True)
class OperationOutput:
    """The result type a registered operation produces, independent of recipe naming.

    Attributes:
        name: Operation output referenced by a recipe's step.output binding.
        kind: Shared scientific result contract.
        presentation: Supported display mode for that type.
        media_type: Format written by the operation.
        label: Default display label, overridable by the recipe.
        role: Whether this is a final result or a retained scientific intermediate.
        multiple_files: Whether the output contains individually named files.
            Each member keeps its operation-supplied name and appends its member
            label to the recipe's display label.
    """

    name: str
    kind: Literal["statistics", "raster", "vector"]
    presentation: Literal["table", "map"]
    media_type: str
    label: str
    role: Literal["result", "intermediate"] = "result"
    multiple_files: bool = False


@dataclass(frozen=True)
class ModelOperation(Generic[Request, Queued, Prepared]):
    """One installed calculation's contracts and application-level adapters.

    Attributes:
        id: Versioned operation identity selected by YAML.
        inputs: Operation argument names and supported model input types.
        parameters: Parameter names and supported setting types.
        output: Primary result contract, required by every recipe using this operation.
        additional_outputs: Other complete files recipes may explicitly retain.
        execution_profile: Server resource policy required by compatible recipes.
        reuse_prepared_source: Whether immediate execution reuses preparation authorization.
        queued_type: Persisted input schema before preparation.
        prepared_type: Persisted execution schema after preparation.
        policy_type: Schema validating recorded numerical implementation facts.
        bind: Translate recipe-bound arguments into the existing request contract.
        source: Extract the operation's catalog or owned run-file reference.
        polygon: Identify an owned polygon upload that admission must copy.
        queue: Capture inputs and ordinary sharing identity; model admission removes it.
        prepare: Resolve captured inputs into a native calculation plan.
        execution: Select the native target, action and execution settings.
        policy: Report effective numerical settings from a prepared plan.
        result: Describe completed result values and grid metadata.
        outcome: Describe retained scientific metadata in Run YAML.
        cached: Optional cache reader; None means the operation always computes results.
        reusable: Optional cache-value extractor; None disables result-cache writes.
        primary_input: Argument bound to the main raster source and its grid metadata.
        extra_sources: Additional catalog rasters to capture and check with the run.
        execution_inputs: Resolve ephemeral native arguments from the stored plan.
        check_execution: Recheck vector access and identity before result publication.
        fixed_input_models: Argument names and schemas for values fixed in Model YAML.
        input_adapters: Additional operation-owned types accepted by selected inputs.
        validate_invocation: Validate captured operation metadata using input role
            types, selected values and extra fields; return canonical JSON fields.
            Operations without this callback accept no extra invocation fields.
        progress_descriptions: Native phase names and their plain user-facing
            descriptions, each containing non-whitespace text up to 200 characters.
            Missing phases use the client's generic running-state description.
            Native progress writers supply the measured work units separately.
    """

    id: str
    inputs: tuple[tuple[str, str], ...]
    parameters: tuple[tuple[str, str], ...]
    output: OperationOutput
    execution_profile: str
    reuse_prepared_source: bool
    queued_type: type[Queued]
    prepared_type: type[Prepared]
    policy_type: type[BaseModel]
    bind: Callable[[dict[str, Any], dict[str, Any], str, str], Request]
    source: Callable[[Request | Queued | Prepared], RasterSourceReference]
    polygon: Callable[[Request], PolygonAreaReference | None]
    queue: Callable[[Request, AggregateArea | None], PreparedJobPlan]
    prepare: Callable[
        [OperationContext, Queued, AuthorizedRaster],
        Awaitable[PreparedJobPlan],
    ]
    execution: Callable[
        [Prepared, OperationContext],
        tuple[Callable[..., None], str, Any],
    ]
    policy: Callable[[Prepared], BaseModel]
    result: Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]
    outcome: Callable[[dict[str, Any]], dict[str, Any]]
    cached: (
        Callable[[OperationContext, Prepared, Path], Awaitable[Artifact | None]] | None
    ) = None
    reusable: (
        Callable[[Prepared, Artifact], dict[str, dict[str, object]] | None] | None
    ) = None
    additional_outputs: tuple[OperationOutput, ...] = ()
    primary_input: str = "raster"
    extra_sources: (
        Callable[[Request | Queued | Prepared], dict[str, RasterSourceReference]] | None
    ) = None
    execution_inputs: Callable[
        [OperationContext, Prepared, AuthorizedRaster], Awaitable[tuple[Any, Prepared]]
    ] = raster.prepare_raster_execution
    check_execution: Callable[[OperationContext, Prepared], Awaitable[None]] = (
        raster.check_raster_execution
    )
    fixed_input_models: tuple[tuple[str, type[BaseModel]], ...] = ()
    input_adapters: tuple[tuple[str, TypeAdapter[Any]], ...] = ()
    validate_invocation: (
        Callable[
            [dict[str, str], dict[str, JsonValue], dict[str, JsonValue]],
            dict[str, JsonValue],
        ]
        | None
    ) = None

    progress_descriptions: tuple[tuple[str, str], ...] = ()

    def parse_specification(
        self, value: BaseModel | dict[str, Any]
    ) -> Queued | Prepared:
        """Validate queued or prepared data against this operation's stored contract.

        Args:
            value: Persisted operation specification or its validated model instance.

        Returns:
            Validated queued inputs or prepared execution plan.

        Raises:
            ValueError: If persisted fields or operation identity are invalid.
        """
        data = (
            value.model_dump(mode="json", by_alias=True)
            if isinstance(value, BaseModel)
            else value
        )
        return (
            self.queued_type if "request" in data else self.prepared_type
        ).model_validate(data)


OPERATIONS = MappingProxyType(
    {
        operation.id: operation
        for operation in (
            ModelOperation[DownstreamRequest, QueuedDownstream, DownstreamPlan](
                id="hydrology.downstream_beneficiaries.v1",
                inputs=(
                    ("starting_mask", "mask_source"),
                    ("hydrology", "prepared_hydrology"),
                    ("values", "raster"),
                ),
                parameters=(
                    ("buffer_m", "number"),
                    ("cutoff_m", "optional_number"),
                    ("summary", "summary_expression"),
                    ("wgs84_pixel_size", "number"),
                    ("travel_time_pixel_size_m", "number"),
                ),
                output=OperationOutput(
                    "statistics",
                    "statistics",
                    "table",
                    "text/csv",
                    "Downstream statistics",
                ),
                additional_outputs=(
                    OperationOutput(
                        "masked_values",
                        "raster",
                        "map",
                        "image/tiff",
                        "Values within downstream coverage",
                    ),
                    OperationOutput(
                        "coverage", "raster", "map", "image/tiff", "Downstream coverage"
                    ),
                    OperationOutput(
                        "starting_mask",
                        "raster",
                        "map",
                        "image/tiff",
                        "Starting mask",
                        "intermediate",
                    ),
                    OperationOutput(
                        "routing_dem",
                        "raster",
                        "map",
                        "image/tiff",
                        "Routing DEM (pit-filled)",
                        "intermediate",
                        multiple_files=True,
                    ),
                ),
                execution_profile="downstream-small-region",
                reuse_prepared_source=False,
                queued_type=QueuedDownstream,
                prepared_type=DownstreamPlan,
                policy_type=DownstreamPolicy,
                bind=downstream.bind_downstream,
                source=downstream.get_values_source,
                polygon=downstream.get_uploaded_polygon,
                queue=downstream.build_downstream_submission,
                prepare=downstream.prepare_downstream,
                execution=downstream.select_downstream_execution,
                policy=downstream.describe_downstream_policy,
                result=downstream.describe_downstream_result,
                outcome=downstream.describe_downstream_outcome,
                primary_input="values",
                extra_sources=downstream.get_additional_sources,
                execution_inputs=downstream.resolve_downstream_execution_inputs,
                check_execution=downstream.check_downstream_execution,
                fixed_input_models=(("hydrology", HydrologySources),),
                input_adapters=(
                    ("mask_source", TypeAdapter(StartingMask)),
                    ("prepared_hydrology", TypeAdapter(HydrologyReference)),
                ),
                validate_invocation=downstream.validate_downstream_invocation,
                progress_descriptions=downstream.DOWNSTREAM_PROGRESS_DESCRIPTIONS,
            ),
            ModelOperation[AggregateJobRequest, UnpreparedCalculation, AggregateSpec](
                id="raster.aggregate.v1",
                inputs=(("raster", "raster"), ("area", "summary_area")),
                parameters=(("expression", "summary_expression"),),
                output=OperationOutput(
                    "statistics", "statistics", "table", "text/csv", "Statistics"
                ),
                execution_profile="raster-summary",
                reuse_prepared_source=True,
                queued_type=UnpreparedCalculation,
                prepared_type=AggregateSpec,
                policy_type=raster.SummaryNumericalPolicy,
                bind=raster.bind_summary,
                source=raster.get_summary_source,
                polygon=raster.get_summary_polygon,
                queue=raster.build_summary_submission,
                prepare=raster.prepare_summary,
                execution=raster.select_summary_execution,
                policy=raster.describe_summary_policy,
                result=raster.describe_summary_result,
                outcome=raster.describe_summary_outcome,
                cached=raster.restore_summary_result,
                reusable=raster.collect_summary_cache_values,
                progress_descriptions=raster.SUMMARY_PROGRESS_DESCRIPTIONS,
            ),
            ModelOperation[ClipJobRequest, UnpreparedClip, ClipSpec](
                id="raster.clip.v1",
                inputs=(("raster", "raster"), ("area", "clip_area")),
                parameters=(),
                output=OperationOutput(
                    "raster", "raster", "map", "image/tiff", "Raster"
                ),
                execution_profile="raster-clip",
                reuse_prepared_source=False,
                queued_type=UnpreparedClip,
                prepared_type=ClipSpec,
                policy_type=raster.ClipNumericalPolicy,
                bind=raster.bind_clip,
                source=raster.get_clip_source,
                polygon=raster.get_clip_polygon,
                queue=raster.build_clip_submission,
                prepare=raster.prepare_clip,
                execution=raster.select_clip_execution,
                policy=raster.describe_clip_policy,
                result=raster.describe_clip_result,
                outcome=raster.describe_clip_outcome,
                progress_descriptions=raster.CLIP_PROGRESS_DESCRIPTIONS,
            ),
        )
    }
)


def get_model_operation(identifier: str) -> ModelOperation[Any, Any, Any]:
    """Look up the trusted adapter for a versioned operation.

    Args:
        identifier: Operation ID supplied by a validated recipe or stored job.

    Returns:
        Registered contracts and application adapters.

    Raises:
        ProcessingError: If no installed implementation supports this operation.
    """
    try:
        return OPERATIONS[identifier]
    except KeyError as error:
        raise ProcessingError(
            "unsupported_model_operation", "This operation is not installed.", 422
        ) from error
