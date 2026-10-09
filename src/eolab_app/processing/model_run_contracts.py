"""Path-free model submissions and model-specific Processing job projections."""

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
    Contract,
    Label,
    ModelDefinition,
    Name,
    SummaryParameter,
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
from eolab_app.processing.model_yaml import canonical_json

MODEL_OPERATION = "model.run.v1"
Digest = Annotated[str, Field(strict=True, pattern=r"^[a-f0-9]{64}$")]


class ModelReference(Contract):
    """Exact installed recipe identity supplied by discovery or an export."""

    id: Name
    version: Version
    definitionSha256: Digest


class ModelRunRequest(Contract):
    """Bounded submission envelope; the installed definition validates each value."""

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
        """Reject nonfinite values before request hashing or model resolution.

        Returns:
            This finite JSON submission.

        Raises:
            ValueError: If any supplied number is nonfinite.
        """
        canonical_json(self.model_dump(mode="json"))
        return self


class BoundsArea(Contract):
    """Explicit WGS84 area for a model summary."""

    kind: Literal["selectedArea"]
    selectedBounds: Wgs84Bounds


class SelectionArea(Contract):
    """Immutable original catalog source and typed filter, not copied geometry."""

    kind: Literal["catalogSelection"]
    selection: CatalogSelection


class PolygonArea(Contract):
    """Owner-authorized temporary polygon capability."""

    kind: Literal["polygonArea"]
    reference: PolygonAreaReference


class WholeRasterArea(Contract):
    """Explicit whole-source summary request."""

    kind: Literal["wholeRaster"]


SummaryArea = Annotated[
    BoundsArea | SelectionArea | PolygonArea | WholeRasterArea,
    Field(discriminator="kind"),
]


class CapturedModel(ModelReference):
    """Full accepted definition, independent of later library availability."""

    definition: ModelDefinition

    @model_validator(mode="after")
    def check_identity(self) -> "CapturedModel":
        """Verify stored definition identity at the persisted-data boundary.

        Returns:
            Validated capture.

        Raises:
            ValueError: If the definition does not match its recorded identity.
        """
        if (self.id, self.version, self.definitionSha256) != (
            self.definition.id,
            self.definition.version,
            self.definition.digest,
        ):
            raise ValueError("Captured definition identity does not match")
        return self


class ModelInvocation(Contract):
    """Immutable submitted intent with explicit effective parameter defaults."""

    model: CapturedModel
    inputs: dict[Name, JsonValue]
    parameters: dict[Name, JsonValue]
    label: Label

    @model_validator(mode="after")
    def check_bindings(self) -> "ModelInvocation":
        """Validate captured role values again when reading persisted run records.

        Returns:
            Invocation whose values satisfy its captured definition.

        Raises:
            ValueError: If a capture has missing, unknown or invalid role values.
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
            SummaryParameter.model_validate(
                {**parameter.model_dump(), "default": self.parameters[name]}
            )
        return self


class ModelRunSpec(Contract):
    """Private persisted execution wrapper; numerical work retains its own contract."""

    operation: Literal["model.run.v1"] = MODEL_OPERATION
    calculation: UnpreparedCalculation | AggregateSpec
    sourceSignature: tuple[int, int, int, int]
    implementationRevision: Digest
    applicationBuild: Annotated[str, Field(min_length=1, max_length=160)]


class ModelIdentity(ModelReference):
    """Small model identity retained in lifecycle summaries."""

    title: Label


class ModelProgress(JobProgressResponse):
    """Measured work counters for one named phase; absent totals are unknown."""

    completed: Annotated[int, Field(ge=0)] | None = None
    total: Annotated[int, Field(ge=0)] | None = None
    unit: str | None = None

    @model_validator(mode="after")
    def check_counts(self) -> "ModelProgress":
        """Require measured completed work not to exceed a supplied total.

        Returns:
            Validated phase counters.

        Raises:
            ValueError: If the counters are inconsistent.
        """
        if (
            self.total is not None
            and self.completed is not None
            and self.completed > self.total
        ):
            raise ValueError("Completed work exceeds its total")
        return self


class ModelJobResponse(JobResponse):
    """Existing owned lifecycle extended with model identity and typed scalar rows."""

    operation: Literal["model.run.v1"]
    model: ModelIdentity
    label: Label
    metadataExpiresAt: datetime | None
    progress: ModelProgress
    result: AggregateResultResponse | None


class ModelRunList(Contract):
    """Bounded owner-only model page with an opaque continuation token."""

    jobs: list[ModelJobResponse]
    nextCursor: str | None


class AvailableModel(ModelDefinition):
    """Installed typed setup metadata with a server-computed definition digest."""

    definitionSha256: Digest


class ModelLibrary(Contract):
    """Complete installed definition discovery response, with no model count limit."""

    models: list[AvailableModel]


class RunDocument(Contract):
    """Authorized YAML export; execution records contain no native capabilities."""

    schema_version: Literal["eolab.run/v1"] = Field(alias="schema")
    jobId: OpaqueId
    capturedAt: AwareDatetime
    invocation: ModelInvocation
    execution: "ModelExecution"

    @model_validator(mode="after")
    def check_execution_bindings(self) -> "RunDocument":
        """Keep execution identities attached to this invocation's declared roles.

        Returns:
            Validated run export.

        Raises:
            ValueError: If recorded operations or sources do not match the recipe.
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


class OperationImplementation(Contract):
    """Installed operation contract and exact implementation identity."""

    id: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_.-]{0,127}$")]
    implementationRevision: Digest


class ResolvedModelSource(Contract):
    """Public source identity and prepared native grid, without a native path."""

    sourceSignature: Digest
    band: Literal[1]
    grid: AggregateGrid | None = None


class ModelExecutionLimits(Contract):
    """Server-resolved policy recorded for reproducibility, not client overrides."""

    runtimeSeconds: Annotated[float, Field(gt=0, allow_inf_nan=False)]
    processMemoryBytes: Annotated[int, Field(gt=0)]
    reservedBytes: Annotated[int, Field(ge=0)]
    resultTtlSeconds: Annotated[int, Field(gt=0)]


class SummaryNumericalPolicy(Contract):
    """Existing aggregate grid, NoData and optional ground-area measurement policy."""

    version: Literal["raster.aggregate.v1"]
    grid: Literal["native"]
    resampling: Literal["none"]
    numericInclusion: Literal["cell_center"]
    nodata: Literal["exclude_source_nodata_and_nonfinite"]
    valueDomain: Literal["stored_native_values"]
    groundArea: GroundAreaPlan | None = None


class ModelOutcome(Contract):
    """Sanitized terminal outcome independent of later output/scratch expiry."""

    status: Literal["ready", "failed", "cancelled", "interrupted"]
    error: JobFailureResponse | None
    statistics: list[AggregateValue] | None


class ModelExecution(Contract):
    """Bounded public execution record; preparation appends authoritative grid policy."""

    state: Literal["pending", "prepared"]
    applicationBuild: Annotated[str, Field(min_length=1, max_length=160)]
    operations: dict[Name, OperationImplementation] = Field(min_length=1, max_length=1)
    sources: dict[Name, ResolvedModelSource] = Field(min_length=1, max_length=1)
    limits: ModelExecutionLimits | None = None
    numericalPolicy: SummaryNumericalPolicy | None = None
    outcome: ModelOutcome | None = None

    @model_validator(mode="after")
    def check_preparation(self) -> "ModelExecution":
        """Require prepared records to contain their resolved policy and grids.

        Returns:
            Consistent pending or prepared execution record.

        Raises:
            ValueError: If a prepared record omits authoritative execution details.
        """
        if self.state == "prepared" and (
            self.limits is None
            or self.numericalPolicy is None
            or any(source.grid is None for source in self.sources.values())
        ):
            raise ValueError("Prepared execution must include its grid and policy")
        return self


RunDocument.model_rebuild()
