"""Immutable installed model recipes and trusted operation contracts."""

from dataclasses import dataclass
from importlib.resources import files
from types import MappingProxyType
from typing import Annotated, Any, Literal, Mapping, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_serializer,
    field_validator,
    model_validator,
)

from eolab_app.processing.model_yaml import definition_digest, export_yaml, parse_yaml
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.raster_expression import compile_expression, walk

Name = Annotated[str, Field(strict=True, pattern=r"^[a-z][a-z0-9_-]{0,63}$")]
Version = Annotated[
    str,
    Field(strict=True, pattern=r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$"),
]
Label = Annotated[str, Field(strict=True, min_length=1, max_length=80)]
Number = Annotated[float, Field(strict=True, allow_inf_nan=False)]


class Contract(BaseModel):
    """Reject unknown fields and assignment at every model contract boundary."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class InputRole(Contract):
    """Required catalog/selection role exposed as an editable form input."""

    type: Literal["catalog_raster", "summary_area", "mask_source", "prepared_hydrology"]
    label: Label


class NumericParameter(Contract):
    """Finite numeric parameter whose definition owns its unit and lower bound."""

    type: Literal["number", "optional_number"]
    label: Label
    unit: Annotated[str, Field(strict=True, min_length=1, max_length=32)]
    minimum: Number | None = None
    exclusiveMinimum: Number | None = None
    default: Number | None

    @model_validator(mode="after")
    def check_default(self) -> Self:
        """Require one lower bound and a default satisfying its declared type.

        Returns:
            This validated declaration.

        Raises:
            ValueError: If bounds or default violate the parameter contract.
        """
        if (self.minimum is None) == (self.exclusiveMinimum is None):
            raise ValueError("Declare exactly one lower bound")
        self.validate_value(self.default)
        return self

    def validate_value(self, value: float | None) -> None:
        """Check a typed value against this declaration.

        Args:
            value: Finite numeric value or explicit null.

        Raises:
            ValueError: If a required value is null or outside its bounds.
        """
        if value is None:
            if self.type != "optional_number":
                raise ValueError("A number is required")
        elif (self.minimum is not None and value < self.minimum) or (
            self.exclusiveMinimum is not None and value <= self.exclusiveMinimum
        ):
            raise ValueError("Value is below the declared bound")


class SummaryParameter(Contract):
    """Single-source scalar expression using the existing bounded grammar."""

    type: Literal["summary_expression"]
    label: Label
    alias: Literal["a"]
    grammar: Literal["eolab.scalar/v1"]
    default: Annotated[str, Field(strict=True, min_length=1, max_length=4096)]

    @model_validator(mode="after")
    def check_default(self) -> Self:
        """Validate the default against the point-free scalar expression contract.

        Returns:
            Validated parameter declaration.

        Raises:
            ValueError: If the expression is invalid or needs a clicked point.
        """
        try:
            tree = compile_expression(self.default, self.alias)
        except ProcessingError as error:
            raise ValueError(error.detail) from error
        if any(node.op == "pixelValue" for node in walk(tree)):
            raise ValueError("This model has no point binding for pixelValue")
        return self


Parameter = Annotated[NumericParameter | SummaryParameter, Field(discriminator="type")]


class InputBinding(Contract):
    """Reference to a named input, never a path or interpolation expression."""

    input: Name


class ParameterBinding(Contract):
    """Reference to a declared parameter whose default is resolved at admission."""

    parameter: Name


class ModelStep(Contract):
    """One trusted operation invocation with explicit typed bindings."""

    id: Name
    operation: Annotated[str, Field(strict=True, pattern=r"^[a-z][a-z0-9_.-]{0,127}$")]
    inputs: Mapping[Name, InputBinding] = Field(max_length=16)
    parameters: Mapping[Name, ParameterBinding] = Field(max_length=32)

    @field_validator("inputs", "parameters", mode="after")
    @classmethod
    def freeze_bindings(cls, value: Mapping[str, Any]) -> Mapping[str, Any]:
        """Freeze validated binding maps.

        Args:
            value: Validated named bindings.

        Returns:
            Read-only mapping containing immutable bindings.
        """
        return MappingProxyType(dict(value))

    @field_serializer("inputs", "parameters")
    def serialize_bindings(self, value: Mapping[str, Any]) -> dict[str, Any]:
        """Export frozen bindings using their ordinary JSON contract.

        Args:
            value: Frozen named bindings.

        Returns:
            JSON-compatible binding map.
        """
        return {key: item.model_dump(mode="json") for key, item in value.items()}


class ModelOutput(Contract):
    """Named declared output; storage alone mints its eventual artifact identity."""

    source: Annotated[
        str,
        Field(strict=True, pattern=r"^[a-z][a-z0-9_-]{0,63}\.[a-z][a-z0-9_-]{0,63}$"),
    ]
    role: Literal["result", "intermediate"]
    presentation: Literal["map", "table"]
    saveEligible: bool = Field(strict=True)


class ModelDefinition(Contract):
    """Version-one reusable recipe, independent of installed runtime availability."""

    schema_version: Literal["eolab.model/v1"] = Field(alias="schema")
    id: Name
    version: Version
    title: Label
    description: Annotated[str, Field(strict=True, min_length=1, max_length=2048)]
    inputs: Mapping[Name, InputRole] = Field(min_length=1, max_length=16)
    parameters: Mapping[Name, Parameter] = Field(max_length=32)
    steps: tuple[ModelStep, ...] = Field(min_length=1, max_length=1)
    outputs: Mapping[Name, ModelOutput] = Field(min_length=1, max_length=32)
    executionProfile: Name

    @field_validator("inputs", "parameters", "outputs", mode="after")
    @classmethod
    def freeze_declarations(cls, value: Mapping[str, Any]) -> Mapping[str, Any]:
        """Freeze named input, parameter and output declarations.

        Args:
            value: Typed declarations.

        Returns:
            Read-only map of immutable contract objects.
        """
        return MappingProxyType(dict(value))

    @field_serializer("inputs", "parameters", "outputs")
    def serialize_declarations(self, value: Mapping[str, Any]) -> dict[str, Any]:
        """Preserve explicit null defaults while omitting absent optional bounds.

        Args:
            value: Frozen declarations.

        Returns:
            JSON-compatible declared fields.
        """
        return {
            key: item.model_dump(mode="json", exclude_unset=True)
            for key, item in value.items()
        }

    @model_validator(mode="after")
    def check_references(self) -> Self:
        """Require every reference to resolve within this single-operation recipe.

        Returns:
            Validated definition.

        Raises:
            ValueError: If a binding names an undeclared value or output step.
        """
        step = self.steps[0]
        if any(item.input not in self.inputs for item in step.inputs.values()):
            raise ValueError("Unknown input reference")
        if any(
            item.parameter not in self.parameters for item in step.parameters.values()
        ):
            raise ValueError("Unknown parameter reference")
        if any(item.source.split(".")[0] != step.id for item in self.outputs.values()):
            raise ValueError("Unknown output step")
        return self

    def document(self) -> dict[str, Any]:
        """Return the normalized public definition used for export and digest.

        Returns:
            Independent JSON-compatible recipe value.
        """
        return self.model_dump(
            mode="json", by_alias=True, include=set(ModelDefinition.model_fields)
        )

    @property
    def digest(self) -> str:
        """Return the canonical SHA-256 definition identity."""
        return definition_digest(self.document())


@dataclass(frozen=True)
class OperationContract:
    """Installed operation's accepted argument and output types, with no code paths."""

    inputs: tuple[tuple[str, str], ...]
    parameters: tuple[tuple[str, str], ...]
    outputs: tuple[tuple[str, str], ...]
    execution_profile: str


OPERATIONS = MappingProxyType(
    {
        "raster.aggregate.v1": OperationContract(
            (("raster", "catalog_raster"), ("area", "summary_area")),
            (("expression", "summary_expression"),),
            (("statistics", "table"),),
            "raster-summary",
        ),
    }
)


def validate_operation(definition: ModelDefinition) -> None:
    """Check a definition against reviewed operation contracts installed in this build.

    Args:
        definition: Structurally validated recipe.

    Raises:
        ProcessingError: For unavailable operations, incompatible roles or outputs.
    """
    step = definition.steps[0]
    contract = OPERATIONS.get(step.operation)
    valid = contract is not None
    if contract is not None:
        valid = (
            {
                name: definition.inputs[item.input].type
                for name, item in step.inputs.items()
            }
            == dict(contract.inputs)
            and {
                name: definition.parameters[item.parameter].type
                for name, item in step.parameters.items()
            }
            == dict(contract.parameters)
            and {
                output.source.split(".")[1]: output.presentation
                for output in definition.outputs.values()
            }
            == dict(contract.outputs)
            and len(definition.outputs) == len(contract.outputs)
            and definition.executionProfile == contract.execution_profile
            and {item.input for item in step.inputs.values()} == set(definition.inputs)
            and {item.parameter for item in step.parameters.values()}
            == set(definition.parameters)
            and all(output.role == "result" for output in definition.outputs.values())
        )
    if not valid:
        raise ProcessingError(
            "unsupported_model_operation",
            "The definition does not match an installed operation contract.",
        )


class ModelRegistry:
    """Read-only installed library, validated eagerly before API/worker readiness."""

    def __init__(self, definitions: tuple[ModelDefinition, ...]) -> None:
        """Validate installed definitions, rejecting duplicate identities.

        Args:
            definitions: Application-installed recipes, with no count limit.

        Raises:
            ProcessingError: If definitions conflict or an operation is unsupported.
        """
        entries = {}
        for definition in definitions:
            validate_operation(definition)
            key = (definition.id, definition.version)
            if key in entries:
                raise ProcessingError(
                    "invalid_model_library", "Duplicate model identity."
                )
            export_yaml(definition.document())
            entries[key] = definition
        self._entries = MappingProxyType(entries)

    @classmethod
    def installed(cls) -> "ModelRegistry":
        """Load packaged YAML resources from a source checkout or installed wheel.

        Returns:
            Validated registry, never a silently truncated library.

        Raises:
            ProcessingError: For missing, malformed or unsupported bundled models.
        """
        try:
            paths = sorted(
                files("eolab_app.processing").joinpath("recipes").iterdir(),
                key=lambda item: item.name,
            )
            definitions = tuple(
                ModelDefinition.model_validate(parse_yaml(path.read_bytes()))
                for path in paths
                if path.name.endswith(".yaml")
            )
            if not definitions:
                raise ValueError("No installed models")
            return cls(definitions)
        except (OSError, ValidationError, ValueError) as error:
            raise ProcessingError(
                "invalid_model_library",
                "Installed model definitions are missing or invalid.",
                503,
            ) from error

    def get(self, identifier: str, version: str) -> ModelDefinition:
        """Resolve one exact installed version.

        Args:
            identifier: Public model ID.
            version: Explicit semantic version.

        Returns:
            Immutable definition.

        Raises:
            ProcessingError: If this version is not installed.
        """
        try:
            return self._entries[(identifier, version)]
        except KeyError as error:
            raise ProcessingError(
                "model_unavailable", "This model version is not installed.", 404
            ) from error

    def list_models(self) -> list[dict[str, Any]]:
        """Expose typed form metadata and exact identities for every installed model.

        Returns:
            All installed definitions with their canonical digests.
        """
        return [
            {**item.document(), "definitionSha256": item.digest}
            for _, item in sorted(self._entries.items())
        ]
