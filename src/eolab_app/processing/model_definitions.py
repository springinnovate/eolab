"""Define model recipes and check that their calculation steps can run in EOlab."""

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

from eolab_app.processing.model_yaml import (
    compute_document_checksum,
    export_yaml,
    parse_yaml,
)
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.raster_expression import compile_expression, walk

Name = Annotated[str, Field(strict=True, pattern=r"^[a-z][a-z0-9_-]{0,63}$")]
Version = Annotated[
    str,
    Field(strict=True, pattern=r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$"),
]
Label = Annotated[str, Field(strict=True, min_length=1, max_length=80)]
Number = Annotated[float, Field(strict=True, allow_inf_nan=False)]


class ModelSchema(BaseModel):
    """Base schema for model recipes and run data.

    Unknown fields are rejected so misspelled settings cannot be silently ignored.
    Fields cannot be reassigned after validation; recipes also make their nested
    input, parameter and output mappings read-only.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)


class ModelInput(ModelSchema):
    """A dataset or analysis area that the user must choose before running a model.

    The type determines which inputs the model accepts, and the label names the
    input in model setup. A recipe describes the input here; each run supplies
    the actual catalog dataset or area.
    """

    type: Literal["catalog_raster", "summary_area", "mask_source", "prepared_hydrology"]
    label: Label


class NumericParameter(ModelSchema):
    """A numeric model setting with a label, unit, minimum and default value.

    An ``optional_number`` may default to None. Every non-null value must meet
    either the inclusive minimum or the exclusive minimum declared by the recipe.
    """

    type: Literal["number", "optional_number"]
    label: Label
    unit: Annotated[str, Field(strict=True, min_length=1, max_length=32)]
    minimum: Number | None = None
    exclusiveMinimum: Number | None = None
    default: Number | None

    @model_validator(mode="after")
    def check_default(self) -> Self:
        """Check that the parameter has one minimum and a valid default.

        Returns:
            This parameter after checking its minimum and default.

        Raises:
            ValueError: If both or neither minimum is supplied, or the default is invalid.
        """
        if (self.minimum is None) == (self.exclusiveMinimum is None):
            raise ValueError("Declare exactly one lower bound")
        self.validate_value(self.default)
        return self

    def validate_value(self, value: float | None) -> None:
        """Check whether a number is allowed for this parameter.

        Args:
            value: A finite number, or None for an optional parameter.

        Raises:
            ValueError: If a required value is missing or a number is below the minimum.
        """
        if value is None:
            if self.type != "optional_number":
                raise ValueError("A number is required")
        elif (self.minimum is not None and value < self.minimum) or (
            self.exclusiveMinimum is not None and value <= self.exclusiveMinimum
        ):
            raise ValueError("Value is below the declared bound")


class SummaryExpressionParameter(ModelSchema):
    """A raster-summary formula setting, such as ``sum(a)`` or ``mean(a)``.

    The letter ``a`` refers to the run's raster. Formulas must produce a summary
    for an area; ``pixelValue`` is excluded because these models have no point input.
    """

    type: Literal["summary_expression"]
    label: Label
    alias: Literal["a"]
    grammar: Literal["eolab.scalar/v1"]
    default: Annotated[str, Field(strict=True, min_length=1, max_length=4096)]

    @model_validator(mode="after")
    def check_default(self) -> Self:
        """Check that the default formula is a supported area summary.

        Returns:
            This parameter after validating its default formula.

        Raises:
            ValueError: If the formula is invalid or requires a clicked point.
        """
        try:
            tree = compile_expression(self.default, self.alias)
        except ProcessingError as error:
            raise ValueError(error.detail) from error
        if any(node.op == "pixelValue" for node in walk(tree)):
            raise ValueError("This model has no point binding for pixelValue")
        return self


Parameter = Annotated[
    NumericParameter | SummaryExpressionParameter, Field(discriminator="type")
]


class InputBinding(ModelSchema):
    """Choose which model input supplies an argument to a calculation step.

    For example, ``input: population`` passes the dataset selected for the model's
    ``population`` input to the operation argument containing this binding.
    """

    input: Name


class ParameterBinding(ModelSchema):
    """Choose which model parameter supplies an argument to a calculation step.

    The run uses the user's value, or the recipe's default when it is omitted.
    """

    parameter: Name


class ModelStep(ModelSchema):
    """A calculation in a model, naming the operation and its arguments.

    For example, a summary step runs ``raster.aggregate.v1`` with the model's
    raster and area inputs and its summary-formula parameter. The bindings map
    those model inputs and parameters to the operation's argument names.
    """

    id: Name
    operation: Annotated[str, Field(strict=True, pattern=r"^[a-z][a-z0-9_.-]{0,127}$")]
    inputs: Mapping[Name, InputBinding] = Field(max_length=16)
    parameters: Mapping[Name, ParameterBinding] = Field(max_length=32)

    @field_validator("inputs", "parameters", mode="after")
    @classmethod
    def freeze_bindings(cls, value: Mapping[str, Any]) -> Mapping[str, Any]:
        """Prevent changes to a step's input and parameter assignments.

        Args:
            value: Validated mapping from operation arguments to model inputs or parameters.

        Returns:
            A read-only copy of the mapping.
        """
        return MappingProxyType(dict(value))

    @field_serializer("inputs", "parameters")
    def serialize_bindings(self, value: Mapping[str, Any]) -> dict[str, Any]:
        """Convert a step's argument assignments to dictionaries for JSON or YAML.

        Args:
            value: The step's input or parameter assignments.

        Returns:
            A dictionary preserving the argument names and their references.
        """
        return {key: item.model_dump(mode="json") for key, item in value.items()}


class ModelOutput(ModelSchema):
    """Describe a result or intermediate output produced by a model step.

    ``source`` names the step and output, such as ``calculate.statistics``.
    ``presentation`` says whether it is a map layer or table; ``role`` distinguishes
    final results from intermediate outputs. This describes an output, while a
    particular run creates its files and download links.
    """

    source: Annotated[
        str,
        Field(strict=True, pattern=r"^[a-z][a-z0-9_-]{0,63}\.[a-z][a-z0-9_-]{0,63}$"),
    ]
    role: Literal["result", "intermediate"]
    presentation: Literal["map", "table"]
    saveEligible: bool = Field(strict=True)


class ModelDefinition(ModelSchema):
    """A reusable analysis recipe with inputs, parameters, a step and outputs.

    The ID and version identify the recipe. Dataset selections and user-supplied
    parameter values belong to individual runs. EOlab currently executes one
    calculation step per recipe.
    """

    schema_version: Literal["eolab.model/v1"] = Field(alias="schema")
    id: Name
    version: Version
    title: Label
    description: Annotated[str, Field(strict=True, min_length=1, max_length=2048)]
    inputs: Mapping[Name, ModelInput] = Field(min_length=1, max_length=16)
    parameters: Mapping[Name, Parameter] = Field(max_length=32)
    steps: tuple[ModelStep, ...] = Field(min_length=1, max_length=1)
    outputs: Mapping[Name, ModelOutput] = Field(min_length=1, max_length=32)
    executionProfile: Name

    @field_validator("inputs", "parameters", "outputs", mode="after")
    @classmethod
    def freeze_declarations(cls, value: Mapping[str, Any]) -> Mapping[str, Any]:
        """Prevent changes to the recipe's inputs, parameters and output descriptions.

        Args:
            value: Validated named inputs, parameters or outputs.

        Returns:
            A read-only copy of those descriptions.
        """
        return MappingProxyType(dict(value))

    @field_serializer("inputs", "parameters", "outputs")
    def serialize_declarations(self, value: Mapping[str, Any]) -> dict[str, Any]:
        """Convert named inputs, parameters or outputs to their JSON and YAML form.

        Args:
            value: The recipe's read-only input, parameter or output mapping.

        Returns:
            Dictionaries preserving explicit null defaults and omitting unset fields.
        """
        return {
            key: item.model_dump(mode="json", exclude_unset=True)
            for key, item in value.items()
        }

    @model_validator(mode="after")
    def check_references(self) -> Self:
        """Check that step arguments and outputs refer to names in this recipe.

        Returns:
            This recipe after checking its input, parameter and step references.

        Raises:
            ValueError: If an argument references an unknown input or parameter, or an
                output references an unknown step.
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

    def to_document(self) -> dict[str, Any]:
        """Return the recipe as a dictionary for YAML export and checksum calculation.

        Returns:
            A new JSON-compatible dictionary using the published recipe field names.
        """
        return self.model_dump(
            mode="json", by_alias=True, include=set(ModelDefinition.model_fields)
        )

    @property
    def digest(self) -> str:
        """Return the recipe's SHA-256 checksum, independent of YAML formatting."""
        return compute_document_checksum(self.to_document())


@dataclass(frozen=True)
class OperationDefinition:
    """The input, parameter and output types accepted by a backend calculation.

    Each tuple pairs an argument or output name with its type. The execution
    profile identifies the server resource policy for this calculation. Recipes
    must match this description before EOlab offers them to users.
    """

    inputs: tuple[tuple[str, str], ...]
    parameters: tuple[tuple[str, str], ...]
    outputs: tuple[tuple[str, str], ...]
    execution_profile: str


OPERATIONS = MappingProxyType(
    {
        "raster.aggregate.v1": OperationDefinition(
            (("raster", "catalog_raster"), ("area", "summary_area")),
            (("expression", "summary_expression"),),
            (("statistics", "table"),),
            "raster-summary",
        ),
    }
)


def validate_operation(definition: ModelDefinition) -> None:
    """Check that EOlab can execute the operation described by a model recipe.

    Args:
        definition: A recipe whose internal references have already been validated.

    Raises:
        ProcessingError: If the operation is unavailable or its arguments, outputs
            or execution profile do not match the installed implementation.
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
    """Installed model definitions indexed by model ID and version."""

    def __init__(self, definitions: tuple[ModelDefinition, ...]) -> None:
        """Build a read-only library of valid, executable model recipes.

        Args:
            definitions: Installed recipes, with no count limit.

        Raises:
            ProcessingError: If recipes repeat an ID/version, require an unsupported
                operation, or cannot be exported as valid Model YAML.
        """
        entries = {}
        for definition in definitions:
            validate_operation(definition)
            key = (definition.id, definition.version)
            if key in entries:
                raise ProcessingError(
                    "invalid_model_library", "Duplicate model identity."
                )
            export_yaml(definition.to_document())
            entries[key] = definition
        self._entries = MappingProxyType(entries)

    @classmethod
    def load_installed(cls) -> "ModelRegistry":
        """Load all Model YAML files packaged in EOlab's recipes directory.

        Returns:
            A registry containing every installed recipe, checked before use.

        Raises:
            ProcessingError: If recipes are missing, invalid, duplicated or unsupported.
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
        """Look up an installed model by its ID and version.

        Args:
            identifier: Model ID returned by discovery.
            version: The requested model version, such as ``1.0.0``.

        Returns:
            The matching model definition.

        Raises:
            ProcessingError: If that model version is not installed.
        """
        try:
            return self._entries[(identifier, version)]
        except KeyError as error:
            raise ProcessingError(
                "model_unavailable", "This model version is not installed.", 404
            ) from error

    def list_models(self) -> list[dict[str, Any]]:
        """Return all installed recipes with the information needed for model setup.

        Returns:
            Definitions and their checksums, sorted by model ID and version.
        """
        return [
            {**item.to_document(), "definitionSha256": item.digest}
            for _, item in sorted(self._entries.items())
        ]
