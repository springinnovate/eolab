"""Request, status and YAML-export schemas for model runs."""

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import AwareDatetime, Field, JsonValue, TypeAdapter, model_validator

from eolab_app.catalog_selection import CatalogSelection
from eolab_app.processing.aggregate_models import (
    AggregateResultResponse,
    AggregateGrid,
    AggregateValue,
    GroundAreaPlan,
    AggregateSpec,
    UnpreparedCalculation,
)
from eolab_app.processing.model_definitions import (
    ModelSchema,
    Label,
    ModelDefinition,
    Name,
    SummaryExpressionParameter,
    Version,
)
from eolab_app.processing.models import (
    JobFailureResponse,
    JobProgressResponse,
    JobResponse,
    OpaqueId,
)
from eolab_app.processing.polygon_areas import PolygonAreaReference
from eolab_app.raster.models import CatalogRasterRequest, Wgs84Bounds
from eolab_app.processing.model_yaml import encode_canonical_json

MODEL_OPERATION = "model.run.v1"
Digest = Annotated[str, Field(strict=True, pattern=r"^[a-f0-9]{64}$")]


class ModelReference(ModelSchema):
    """A model's ID, version and definition checksum.

    The checksum lets submission detect a recipe that changed after the user
    opened model setup, even if its ID and version stayed the same.
    """

    id: Name
    version: Version
    definitionSha256: Digest


class ModelRunRequest(ModelSchema):
    """A user's request to run a model with selected inputs and parameter values.

    ``requestId`` identifies retries of the same submission. ``model`` selects
    the recipe version; ``inputs`` supplies datasets and an area. Omitted
    parameters use the recipe's defaults, and ``label`` names the run for the user.
    """

    requestId: Annotated[
        str,
        Field(strict=True, min_length=16, max_length=80, pattern=r"^[A-Za-z0-9_-]+$"),
    ]
    model: ModelReference
    inputs: dict[Name, JsonValue] = Field(min_length=1, max_length=16)
    parameters: dict[Name, JsonValue] = Field(default_factory=dict, max_length=32)
    label: Label

    @model_validator(mode="after")
    def check_json_values(self) -> "ModelRunRequest":
        """Reject NaN and infinity in submitted inputs or parameters.

        Returns:
            This request after checking that its numbers can be represented in JSON.

        Raises:
            ValueError: If a supplied number is NaN or infinite.
        """
        encode_canonical_json(self.model_dump(mode="json"))
        return self


class BoundsArea(ModelSchema):
    """A rectangular analysis area specified by longitude and latitude bounds."""

    kind: Literal["selectedArea"]
    selectedBounds: Wgs84Bounds


class SelectionArea(ModelSchema):
    """An analysis area selected from a catalog vector layer using its filter.

    The stored selection identifies the original dataset and filter rules.
    Processing reads the matching features when preparing the run.
    """

    kind: Literal["catalogSelection"]
    selection: CatalogSelection


class PolygonArea(ModelSchema):
    """An analysis area referencing polygons uploaded by the same browser session."""

    kind: Literal["polygonArea"]
    reference: PolygonAreaReference


class WholeRasterArea(ModelSchema):
    """An analysis area covering the entire selected raster."""

    kind: Literal["wholeRaster"]


SummaryArea = Annotated[
    BoundsArea | SelectionArea | PolygonArea | WholeRasterArea,
    Field(discriminator="kind"),
]


class CapturedModel(ModelReference):
    """A copy of the exact model definition accepted for a run.

    Keeping the definition with the run allows later inspection even if the
    installed recipe changes or is removed.
    """

    definition: ModelDefinition

    @model_validator(mode="after")
    def check_identity(self) -> "CapturedModel":
        """Check that the stored recipe matches its recorded ID, version and checksum.

        Returns:
            This saved model after checking its identity.

        Raises:
            ValueError: If the definition differs from its recorded identity.
        """
        if (self.id, self.version, self.definitionSha256) != (
            self.definition.id,
            self.definition.version,
            self.definition.digest,
        ):
            raise ValueError("Captured definition identity does not match")
        return self


class ModelInvocation(ModelSchema):
    """The model recipe, inputs and effective parameter values saved for a run.

    Unlike a submission request, this includes the complete recipe and the
    default values filled in when the run was accepted.
    """

    model: CapturedModel
    inputs: dict[Name, JsonValue]
    parameters: dict[Name, JsonValue]
    label: Label

    @model_validator(mode="after")
    def check_bindings(self) -> "ModelInvocation":
        """Check the saved inputs and parameters against the saved model definition.

        Returns:
            This invocation after validating its dataset, area and formula values.

        Raises:
            ValueError: If a saved input or parameter is missing, unknown or invalid.
        """
        definition = self.model.definition
        if set(self.inputs) != set(definition.inputs) or set(self.parameters) != set(
            definition.parameters
        ):
            raise ValueError("Captured bindings do not match the definition")
        for name, role in definition.inputs.items():
            if role.type == "catalog_raster":
                CatalogRasterRequest.model_validate(self.inputs[name])
            elif role.type == "summary_area":
                TypeAdapter(SummaryArea).validate_python(self.inputs[name])
            else:
                raise ValueError("Unsupported captured input type")
        for name, parameter in definition.parameters.items():
            SummaryExpressionParameter.model_validate(
                {**parameter.model_dump(), "default": self.parameters[name]}
            )
        return self


class ModelRunSpec(ModelSchema):
    """The saved calculation instructions used by the model worker.

    The calculation starts as submitted inputs and becomes a prepared raster
    aggregation plan. Source and implementation checksums let the worker reject
    changes between submission and execution.
    """

    operation: Literal["model.run.v1"] = MODEL_OPERATION
    calculation: UnpreparedCalculation | AggregateSpec
    sourceSignature: tuple[int, int, int, int]
    implementationRevision: Digest
    applicationBuild: Annotated[str, Field(min_length=1, max_length=160)]


class ModelIdentity(ModelReference):
    """The model's ID, version, checksum and title shown in run status responses."""

    title: Label


class ModelProgress(JobProgressResponse):
    """Completed and total work for the current stage of a model run.

    For example, a raster summary reports processed raster blocks. A missing
    total means that the amount of work is not yet known.
    """

    completed: Annotated[int, Field(ge=0)] | None = None
    total: Annotated[int, Field(ge=0)] | None = None
    unit: str | None = None

    @model_validator(mode="after")
    def check_counts(self) -> "ModelProgress":
        """Check that completed work does not exceed the reported total.

        Returns:
            This progress report after checking its counts.

        Raises:
            ValueError: If completed work exceeds the total.
        """
        if (
            self.total is not None
            and self.completed is not None
            and self.completed > self.total
        ):
            raise ValueError("Completed work exceeds its total")
        return self


class ModelJobResponse(JobResponse):
    """A model run's status, progress, errors and available summary downloads.

    ``metadataExpiresAt`` is the deadline for reading the saved Model/Run YAML.
    Result files have their own expiry in the inherited ``expiresAt`` field.
    """

    operation: Literal["model.run.v1"]
    model: ModelIdentity
    label: Label
    metadataExpiresAt: datetime | None
    progress: ModelProgress
    result: AggregateResultResponse | None


class ModelRunList(ModelSchema):
    """One page of the current browser session's model runs.

    Pass ``nextCursor`` with the next list request to retrieve older runs.
    A null cursor means there are no more matching runs.
    """

    jobs: list[ModelJobResponse]
    nextCursor: str | None


class AvailableModel(ModelDefinition):
    """An installed recipe returned by discovery, including its definition checksum."""

    definitionSha256: Digest


class ModelLibrary(ModelSchema):
    """All model recipes available for setup on this EOlab deployment."""

    models: list[AvailableModel]


class RunDocument(ModelSchema):
    """The downloadable Run YAML describing what was submitted and executed.

    It includes the saved recipe, selected inputs, effective parameters, software
    versions, calculation settings and any completed result or failure.
    """

    schema_version: Literal["eolab.run/v1"] = Field(alias="schema")
    jobId: OpaqueId
    capturedAt: AwareDatetime
    invocation: ModelInvocation
    execution: "ModelExecution"

    @model_validator(mode="after")
    def check_execution_bindings(self) -> "RunDocument":
        """Check that execution details describe the recipe and inputs saved for this run.

        Returns:
            This run document after matching its operation and raster input names.

        Raises:
            ValueError: If the recorded operation or sources do not match the saved recipe.
        """
        definition = self.invocation.model.definition
        step = definition.steps[0]
        if (
            set(self.execution.operations) != {step.id}
            or self.execution.operations[step.id].id != step.operation
        ):
            raise ValueError("Execution operation does not match the captured recipe")
        raster_roles = {
            name
            for name, role in definition.inputs.items()
            if role.type == "catalog_raster"
        }
        if set(self.execution.sources) != raster_roles:
            raise ValueError("Execution sources do not match the captured recipe")
        return self


class OperationImplementation(ModelSchema):
    """The operation ID and software checksum used to execute a model step."""

    id: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_.-]{0,127}$")]
    implementationRevision: Digest


class ResolvedModelSource(ModelSchema):
    """A raster input's checksum, band and grid information recorded for a run.

    The source checksum is recorded at submission; grid details are filled in
    after the worker reads and prepares the raster.
    """

    sourceSignature: Digest
    band: Literal[1]
    grid: AggregateGrid | None = None


class ModelExecutionLimits(ModelSchema):
    """The server's time, memory, disk and result-retention limits for this run.

    These values record the settings used by the worker; a submitted recipe
    cannot override them.
    """

    runtimeSeconds: Annotated[float, Field(gt=0, allow_inf_nan=False)]
    processMemoryBytes: Annotated[int, Field(gt=0)]
    reservedBytes: Annotated[int, Field(ge=0)]
    resultTtlSeconds: Annotated[int, Field(gt=0)]


class SummaryNumericalPolicy(ModelSchema):
    """Rules used to select and measure raster cells in a summary.

    Records the grid, resampling, NoData handling, value interpretation and any
    ground-area calculation settings so exported results can be interpreted.
    """

    version: Literal["raster.aggregate.v1"]
    grid: Literal["native"]
    resampling: Literal["none"]
    numericInclusion: Literal["cell_center"]
    nodata: Literal["exclude_source_nodata_and_nonfinite"]
    valueDomain: Literal["stored_native_values"]
    groundArea: GroundAreaPlan | None = None


class ModelOutcome(ModelSchema):
    """A finished run's final status, error or calculated summary values.

    This record remains available after result files expire, until the run's
    metadata expires or the user deletes the run.
    """

    status: Literal["ready", "failed", "cancelled", "interrupted"]
    error: JobFailureResponse | None
    statistics: list[AggregateValue] | None


class ModelExecution(ModelSchema):
    """Software, source data, calculation settings and results recorded for a run.

    Before preparation, it records the software and source checksums. Preparation
    adds grid details and calculation limits; completion adds the outcome.
    """

    state: Literal["pending", "prepared"]
    applicationBuild: Annotated[str, Field(min_length=1, max_length=160)]
    operations: dict[Name, OperationImplementation] = Field(min_length=1, max_length=1)
    sources: dict[Name, ResolvedModelSource] = Field(min_length=1, max_length=1)
    limits: ModelExecutionLimits | None = None
    numericalPolicy: SummaryNumericalPolicy | None = None
    outcome: ModelOutcome | None = None

    @model_validator(mode="after")
    def check_preparation(self) -> "ModelExecution":
        """Check that a prepared run includes its grid and calculation settings.

        Returns:
            This execution record after checking its preparation details.

        Raises:
            ValueError: If a prepared record lacks limits, numerical settings or a grid.
        """
        if self.state == "prepared" and (
            self.limits is None
            or self.numericalPolicy is None
            or any(source.grid is None for source in self.sources.values())
        ):
            raise ValueError("Prepared execution must include its grid and policy")
        return self


RunDocument.model_rebuild()
