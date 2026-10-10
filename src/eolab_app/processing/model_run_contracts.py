"""Request, status and YAML-export schemas for model runs."""

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import (
    AwareDatetime,
    BaseModel,
    Field,
    JsonValue,
    SerializeAsAny,
    TypeAdapter,
    field_validator,
    model_validator,
)

from eolab_app.catalog_selection import CatalogSelection
from eolab_app.processing.aggregate_models import (
    AggregateGrid,
    AggregateValue,
)
from eolab_app.processing.clip_models import (
    ClipGrid,
)
from eolab_app.processing.model_definitions import (
    ModelSchema,
    Label,
    ModelDefinition,
    Name,
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
from eolab_app.raster.source_models import RasterSourceReference, RunArtifactReference
from eolab_app.processing.model_yaml import encode_canonical_json
from eolab_app.processing.model_operations import get_model_operation
from eolab_app.processing.downstream_models import StartingMask
from eolab_app.processing.prepared_hydrology import (
    HydrologyReference,
    PreparedHydrologySnapshot,
)
from eolab_app.processing.model_result_contracts import ModelResult
from eolab_app.processing.artifact_manifest import (
    FileId,
    OutputName,
    FileRole,
    FileName,
    MediaType,
    MAX_ARTIFACT_FILES,
)

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


# Raster clips require an explicit box or catalog vector predicate.
ClipModelArea = Annotated[BoundsArea | SelectionArea, Field(discriminator="kind")]


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
    default values filled in when the run was accepted. Hydrology inputs also
    retain the validated configuration and exact catalog source identities.
    """

    model: CapturedModel
    inputs: dict[Name, JsonValue]
    parameters: dict[Name, JsonValue]
    label: Label
    hydrology: dict[Name, PreparedHydrologySnapshot] = Field(
        default_factory=dict, max_length=16, exclude_if=lambda value: not value
    )

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
        input_types = {
            "raster": RasterSourceReference,
            "catalog_raster": CatalogRasterRequest,
            "clip_area": ClipModelArea,
            "summary_area": SummaryArea,
            "prepared_hydrology": HydrologyReference,
            "mask_source": StartingMask,
        }
        hydrology_roles = {
            name
            for name, role in definition.inputs.items()
            if role.type == "prepared_hydrology"
        }
        if set(self.hydrology) != hydrology_roles:
            raise ValueError(
                "Capture every selected hydrology configuration with its source identities"
            )
        for name, role in definition.inputs.items():
            if role.type not in input_types:
                raise ValueError("Unsupported captured input type")
            selected_input = TypeAdapter(input_types[role.type]).validate_python(
                self.inputs[name]
            )
            if (
                name in hydrology_roles
                and self.hydrology[name].reference != selected_input
            ):
                raise ValueError(
                    "Captured hydrology does not match the selected configuration"
                )
        for name, parameter in definition.parameters.items():
            type(parameter).model_validate(
                {**parameter.model_dump(), "default": self.parameters[name]}
            )
        return self


class ModelRunSpec(ModelSchema):
    """The saved calculation instructions used by the model worker.

    The calculation starts as submitted inputs and becomes the registered
    operation's prepared plan. Primary and additional raster signatures let the
    worker reject source changes between submission and execution; the
    implementation checksum detects changes to the numerical code and packages.
    """

    operation: Literal["model.run.v1"] = MODEL_OPERATION
    calculation: SerializeAsAny[BaseModel]
    sourceSignature: tuple[int, int, int, int] | None
    additionalSourceSignatures: dict[Name, tuple[int, int, int, int]] = Field(
        default_factory=dict, max_length=16, exclude_if=lambda value: not value
    )
    implementationRevision: Digest
    applicationBuild: Annotated[str, Field(min_length=1, max_length=160)]

    @field_validator("calculation", mode="before")
    @classmethod
    def parse_calculation(cls, value: BaseModel | dict[str, Any]) -> BaseModel:
        """Validate a stored calculation with its registered operation schema.

        Args:
            value: Queued or prepared operation data from storage.

        Returns:
            The operation's validated queued or prepared model.

        Raises:
            ValueError: If the operation data is malformed.
            ProcessingError: If its implementation is not installed.
        """
        if not isinstance(value, (BaseModel, dict)):
            raise ValueError("Stored calculation must be an operation object")
        identifier = (
            getattr(value, "operation", None)
            if isinstance(value, BaseModel)
            else value.get("operation")
        )
        if not isinstance(identifier, str):
            raise ValueError("Stored calculation requires an operation ID")
        return get_model_operation(identifier).parse_specification(value)

    @model_validator(mode="after")
    def check_source_identity(self) -> "ModelRunSpec":
        """Require catalog signatures while private inputs use accepted file grants.

        Returns:
            The stored run with the identity contract appropriate to its source.

        Raises:
            ValueError: If the signature is absent for catalog data or supplied for a run file.
        """
        source = get_model_operation(self.calculation.operation).source(
            self.calculation
        )
        if isinstance(source, RunArtifactReference) != (self.sourceSignature is None):
            raise ValueError("Source identity does not match the raster reference")
        operation = get_model_operation(self.calculation.operation)
        additional = (
            operation.extra_sources(self.calculation) if operation.extra_sources else {}
        )
        if set(additional) != set(self.additionalSourceSignatures):
            raise ValueError("Capture every additional raster source identity")
        return self


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


class ModelArtifactRecord(ModelSchema):
    """A retained file's identity and checksum, without private storage information.

    This record can remain in Run YAML after the file expires. It does not grant
    access: downloads additionally require the owning session and an available run.
    """

    artifactId: FileId
    name: OutputName
    label: str
    role: FileRole
    filename: FileName
    mediaType: MediaType
    bytes: Annotated[int, Field(ge=0)]
    sha256: Digest


class ModelArtifactDownload(ModelArtifactRecord):
    """One complete file currently downloadable by the run's owner."""

    url: str


class ModelArtifactManifest(ModelSchema):
    """Files available from one run, their shared expiry and total retained bytes.

    Pending and unavailable runs contain no file links. totalBytes includes the
    private inventory file in addition to every result and retained intermediate.
    """

    jobId: OpaqueId
    availability: Literal["pending", "available", "unavailable"]
    expiresAt: datetime
    files: list[ModelArtifactDownload] = Field(max_length=MAX_ARTIFACT_FILES)
    totalBytes: Annotated[int, Field(ge=0)]


class ModelJobResponse(JobResponse):
    """A model run's status, progress, errors and available table or raster downloads.

    ``metadataExpiresAt`` is the deadline for reading the saved Model/Run YAML.
    Result files have their own expiry in the inherited ``expiresAt`` field.
    """

    operation: Literal["model.run.v1"]
    model: ModelIdentity
    label: Label
    metadataExpiresAt: datetime | None
    progress: ModelProgress
    result: ModelResult | None
    artifacts: ModelArtifactManifest | None = None


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
            if role.type in {"raster", "catalog_raster"}
        }
        if set(self.execution.sources) != raster_roles:
            raise ValueError("Execution sources do not match the captured recipe")
        for name in raster_roles:
            private = self.invocation.inputs[name].get("kind") == "runArtifact"
            recorded = self.execution.sources[name]
            if private != (recorded.sha256 is not None and recorded.bytes is not None):
                raise ValueError(
                    "Private raster provenance requires its published checksum and size"
                )
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
    sha256: Digest | None = None
    bytes: Annotated[int, Field(gt=0)] | None = None
    band: Literal[1]
    grid: AggregateGrid | ClipGrid | None = None


class ModelExecutionLimits(ModelSchema):
    """The server's time, memory, disk and result-retention limits for this run.

    These values record the settings used by the worker; a submitted recipe
    cannot override them.
    """

    runtimeSeconds: Annotated[float, Field(gt=0, allow_inf_nan=False)]
    processMemoryBytes: Annotated[int, Field(gt=0)]
    reservedBytes: Annotated[int, Field(ge=0)]
    resultTtlSeconds: Annotated[int, Field(gt=0)]


class ModelRasterOutcome(ModelSchema):
    """Raster file metadata retained in Run YAML after the download expires."""

    filename: Annotated[str, Field(min_length=1, max_length=1024)]
    bytes: Annotated[int, Field(ge=0)]
    sha256: Digest
    validPixels: Annotated[int, Field(ge=0)]


class ModelOutcome(ModelSchema):
    """A finished run's final status, error, summary values or raster file metadata.

    This record remains available after result files expire, until the run's
    metadata expires or the user deletes the run.
    """

    status: Literal["ready", "failed", "cancelled", "interrupted"]
    error: JobFailureResponse | None
    statistics: list[AggregateValue] | None
    raster: ModelRasterOutcome | None = None
    artifacts: list[ModelArtifactRecord] | None = Field(
        default=None, max_length=MAX_ARTIFACT_FILES
    )


class ModelExecution(ModelSchema):
    """Software, source data, calculation settings and results recorded for a run.

    Before preparation, it records the software and source checksums. Preparation
    adds grid details and calculation limits; completion adds the outcome.
    """

    state: Literal["pending", "prepared"]
    applicationBuild: Annotated[str, Field(min_length=1, max_length=160)]
    operations: dict[Name, OperationImplementation] = Field(min_length=1, max_length=1)
    sources: dict[Name, ResolvedModelSource] = Field(min_length=1, max_length=1)
    additionalSources: dict[Name, Digest] = Field(
        default_factory=dict, max_length=16, exclude_if=lambda value: not value
    )
    limits: ModelExecutionLimits | None = None
    numericalPolicy: SerializeAsAny[BaseModel] | None = None
    outcome: ModelOutcome | None = None

    @model_validator(mode="before")
    @classmethod
    def parse_numerical_policy(cls, value: dict[str, Any]) -> dict[str, Any]:
        """Validate numerical facts using the recorded operation's policy contract.

        Args:
            value: Execution details loaded from retained run metadata or YAML.

        Returns:
            Execution details with a typed, operation-validated policy.

        Raises:
            ValueError: If the policy does not match the recorded operation.
            ProcessingError: If the recorded operation is not installed.
        """
        if not isinstance(value, dict):
            raise ValueError("Execution details must be an object")
        if value.get("numericalPolicy") is None:
            return value
        records = value.get("operations", {})
        if len(records) != 1:
            raise ValueError("Numerical policy requires one recorded operation")
        record = next(iter(records.values()))
        identifier = (
            record.id
            if isinstance(record, OperationImplementation)
            else record.get("id")
        )
        operation = get_model_operation(identifier)
        return {
            **value,
            "numericalPolicy": operation.policy_type.model_validate(
                value["numericalPolicy"]
            ),
        }

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
