"""Evaluate view-owned arithmetic fields from immutable original attributes."""

from collections.abc import Mapping
from dataclasses import dataclass
import math
import re
from typing import Any, Literal, cast

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator

_NUMBER = re.compile(r"(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
_NUMERIC_TEXT = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
_NUMERIC_TYPES = {
    "int",
    "int16",
    "int32",
    "int64",
    "integer",
    "integer64",
    "float",
    "float32",
    "float64",
    "real",
}
_TEXT_TYPES = {"str", "string"}
_PRECEDENCE = {"+": 1, "-": 1, "*": 2, "/": 2, "negate": 3, "positive": 3}
ArithmeticOperator = Literal[
    "literal", "field", "+", "-", "*", "/", "negate", "positive"
]


class CalculatedFieldError(ValueError):
    """A field definition cannot be applied to its original source schema."""


class CalculatedField(BaseModel):
    """Save one named numeric expression with its owning vector view.

    Attributes:
        version: Arithmetic semantics version, currently the literal number 1.
        name: New attribute name, distinct from source and earlier calculated fields.
        expression: Arithmetic with single-quoted field names; double an apostrophe
            inside a name. Earlier calculated fields may be referenced.
        numericText: Accept complete trimmed decimal/scientific strings as numbers.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    version: Literal[1] = 1
    name: str = Field(strict=True, min_length=1, max_length=256)
    expression: str = Field(strict=True, min_length=1, max_length=4096)
    numericText: StrictBool = False

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        """Reject blank, reserved or control-containing output names.

        Args:
            value: User-supplied output name, preserved exactly when valid.

        Returns:
            The accepted name, including meaningful spaces.

        Raises:
            ValueError: If the name cannot identify a new ordinary attribute.
        """
        if not value.strip() or any(ord(character) < 32 for character in value):
            raise ValueError("Enter a field name without control characters.")
        if value.casefold() in {"fid", "ogc_fid", "geom", "geometry"}:
            raise ValueError(
                "Choose a field name other than a reserved geometry or feature ID name."
            )
        return value


@dataclass(frozen=True)
class ArithmeticInstruction:
    """One operation in an expression's stack program.

    Attributes:
        operator: Push a literal/field or apply an arithmetic operator to the stack.
        value: Float for a literal, exact string for a field, otherwise None.
            The parser establishes this relationship before evaluation.
    """

    operator: ArithmeticOperator
    value: float | str | None = None


@dataclass(frozen=True)
class CompiledCalculatedField:
    """A definition bound to its original source schema.

    Attributes:
        definition: Immutable user definition with numeric-text policy.
        instructions: Postfix program accepted by the arithmetic parser.
        source_fields: Original columns needed, including earlier fields' inputs.
    """

    definition: CalculatedField
    instructions: tuple[ArithmeticInstruction, ...]
    source_fields: tuple[str, ...]


def compile_field_expression(expression: str) -> tuple[ArithmeticInstruction, ...]:
    """Parse arithmetic into an immutable program without executing user code.

    Args:
        expression: Expression bounded to 4,096 characters by CalculatedField.

    Returns:
        Postfix instructions for constants, fields, arithmetic and unary signs.

    Raises:
        CalculatedFieldError: If syntax is incomplete or contains unsupported tokens.
    """
    instructions: list[ArithmeticInstruction] = []
    operators: list[str] = []
    position = 0
    needs_operand = True
    while position < len(expression):
        character = expression[position]
        if character.isspace():
            position += 1
            continue
        column = position + 1
        if needs_operand:
            if character in "+-":
                operators.append("positive" if character == "+" else "negate")
                position += 1
                continue
            if character == "(":
                operators.append(character)
                position += 1
                continue
            if character == "'":
                name: list[str] = []
                position += 1
                while position < len(expression):
                    character = expression[position]
                    position += 1
                    if character != "'":
                        name.append(character)
                    elif position < len(expression) and expression[position] == "'":
                        name.append("'")
                        position += 1
                    else:
                        break
                else:
                    raise CalculatedFieldError(
                        f"Close the field name starting at column {column} with a quote."
                    )
                if not name:
                    raise CalculatedFieldError(
                        f"Enter a field name at column {column}."
                    )
                instructions.append(ArithmeticInstruction("field", "".join(name)))
            else:
                match = _NUMBER.match(expression, position)
                if match is None:
                    raise CalculatedFieldError(
                        f"Enter a number, quoted field name or '(' at column {column}."
                    )
                value = float(match[0])
                if not math.isfinite(value):
                    raise CalculatedFieldError(
                        f"The number at column {column} is outside the supported range."
                    )
                instructions.append(ArithmeticInstruction("literal", value))
                position = match.end()
            needs_operand = False
            continue
        if character == ")":
            while operators and operators[-1] != "(":
                instructions.append(
                    ArithmeticInstruction(cast(ArithmeticOperator, operators.pop()))
                )
            if not operators:
                raise CalculatedFieldError(
                    f"The ')' at column {column} has no matching '('."
                )
            operators.pop()
            position += 1
        elif character in "+-*/":
            while (
                operators
                and operators[-1] != "("
                and _PRECEDENCE[operators[-1]] >= _PRECEDENCE[character]
            ):
                instructions.append(
                    ArithmeticInstruction(cast(ArithmeticOperator, operators.pop()))
                )
            operators.append(character)
            needs_operand = True
            position += 1
        else:
            raise CalculatedFieldError(f"Enter +, -, *, / or ')' at column {column}.")
    if needs_operand:
        raise CalculatedFieldError(
            "Finish the expression with a number, quoted field name or ')'."
        )
    while operators:
        operator = operators.pop()
        if operator == "(":
            raise CalculatedFieldError("Close each '(' with a matching ')'.")
        instructions.append(ArithmeticInstruction(cast(ArithmeticOperator, operator)))
    return tuple(instructions)


def validate_calculated_fields(
    definitions: tuple[CalculatedField, ...], source_fields: Mapping[str, str]
) -> tuple[CompiledCalculatedField, ...]:
    """Bind ordered definitions to a source schema and earlier calculated fields.

    Args:
        definitions: View-owned definitions received at a public or storage boundary.
        source_fields: Authoritative native names and declared Fiona/OGR types.

    Returns:
        Programs whose references and numeric input types are established.

    Raises:
        CalculatedFieldError: If a name collides, syntax fails, a reference is absent,
            or a text/non-numeric input is not permitted by the definition.
    """
    fields = dict(source_fields)
    occupied = {name.casefold() for name in fields}
    compiled: dict[str, CompiledCalculatedField] = {}
    for definition in definitions:
        if definition.name.casefold() in occupied:
            raise CalculatedFieldError(
                f"Field {definition.name!r} already exists. Choose another name."
            )
        instructions = compile_field_expression(definition.expression)
        inputs: dict[str, None] = {}
        for instruction in instructions:
            if instruction.operator != "field":
                continue
            name = cast(str, instruction.value)
            if name not in fields:
                raise CalculatedFieldError(
                    f"Field {name!r} is unavailable. Choose an existing field."
                )
            field_type = fields[name].split(":", 1)[0].lower()
            if field_type not in _NUMERIC_TYPES:
                if field_type in _TEXT_TYPES and not definition.numericText:
                    raise CalculatedFieldError(
                        f"Field {name!r} contains text. Select Treat numeric text as numbers to use it."
                    )
                if field_type not in _TEXT_TYPES:
                    raise CalculatedFieldError(
                        f"Field {name!r} is not a numeric or text field."
                    )
            inputs.update(
                dict.fromkeys(
                    compiled[name].source_fields if name in compiled else (name,)
                )
            )
        compiled[definition.name] = CompiledCalculatedField(
            definition, instructions, tuple(inputs)
        )
        fields[definition.name] = "float"
        occupied.add(definition.name.casefold())
    return tuple(compiled.values())


def required_source_fields(
    compiled: tuple[CompiledCalculatedField, ...], requested_fields: tuple[str, ...]
) -> tuple[str, ...]:
    """Find original columns needed to return ordinary or calculated fields.

    Args:
        compiled: Definitions already bound to the original source schema.
        requested_fields: Accepted output or original field names.

    Returns:
        Unique original column names in first-use order.
    """
    calculated = {field.definition.name: field.source_fields for field in compiled}
    return tuple(
        dict.fromkeys(
            name
            for field in requested_fields
            for name in calculated.get(field, (field,))
        )
    )


def _number(value: Any, numeric_text: bool) -> float | None:
    """Convert one native scalar to a finite double under the selected text policy.

    Args:
        value: Native attribute value or earlier calculated result.
        numeric_text: Whether complete decimal/scientific strings are permitted.

    Returns:
        Finite double, or None for missing, invalid or nonfinite values.
    """
    if type(value) not in {int, float}:
        if (
            not numeric_text
            or not isinstance(value, str)
            or not _NUMERIC_TEXT.fullmatch(value.strip())
        ):
            return None
    try:
        number = float(value)
    except (ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def evaluate_calculated_fields(
    compiled: tuple[CompiledCalculatedField, ...], properties: Mapping[str, Any]
) -> dict[str, float | None]:
    """Calculate one feature's fields with identical missing-value rules per operator.

    Args:
        compiled: Validated ordered programs; later fields can use earlier results.
        properties: Original scalar attributes for this feature.

    Returns:
        Calculated names mapped to finite doubles or None. Missing inputs,
        invalid numeric text, division by zero and nonfinite intermediate results
        propagate as missing values. Original properties are never modified.
    """
    values: dict[str, float | None] = {}
    for field in compiled:
        stack: list[float | None] = []
        for instruction in field.instructions:
            operator = instruction.operator
            if operator == "literal":
                stack.append(cast(float, instruction.value))
            elif operator == "field":
                name = cast(str, instruction.value)
                stack.append(
                    _number(
                        values[name] if name in values else properties.get(name),
                        field.definition.numericText,
                    )
                )
            elif operator in {"negate", "positive"}:
                value = stack.pop()
                stack.append(
                    -value if operator == "negate" and value is not None else value
                )
            else:
                right, left = stack.pop(), stack.pop()
                value = None
                if left is not None and right is not None:
                    if operator == "+":
                        value = left + right
                    elif operator == "-":
                        value = left - right
                    elif operator == "*":
                        value = left * right
                    elif right != 0:
                        value = left / right
                stack.append(
                    value if value is not None and math.isfinite(value) else None
                )
        values[field.definition.name] = stack.pop()
    return values
