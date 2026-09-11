"""Neutral typed attribute predicates shared by exact readers and rendering."""

from collections.abc import Mapping
from datetime import date
from math import isfinite
from typing import Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    StrictStr,
    field_validator,
)

MAX_FILTER_RULES = 12
_COMPARISONS = {"eq", "ne", "gt", "ge", "lt", "le"}


class AttributeFilterError(ValueError):
    """A typed predicate is incompatible with authoritative source fields."""


class VectorFilterRule(BaseModel):
    """One bounded, typed attribute comparison; never executable source text."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    field: StrictStr = Field(min_length=1, max_length=256)
    operator: Literal[
        "eq", "ne", "gt", "ge", "lt", "le", "contains", "missing", "present"
    ]
    value: StrictBool | StrictInt | StrictFloat | StrictStr | None = None

    @field_validator("field", "value")
    @classmethod
    def bounded_literal(cls, value: Any) -> Any:
        """Reject unbounded or nonportable scalar input.

        Args:
            value: Submitted property name or literal.

        Returns:
            Unchanged safe scalar.

        Raises:
            ValueError: If the value exceeds the portable literal contract.
        """
        if isinstance(value, str) and (
            len(value) > 256 or any(ord(c) < 32 for c in value)
        ):
            raise ValueError(
                "Text must be at most 256 characters without control characters"
            )
        if type(value) in {int, float} and (
            not isfinite(value) or abs(value) > 2**53 - 1
        ):
            raise ValueError(
                "Numbers must be finite and within the browser's safe numeric range"
            )
        return value


class VectorFilter(BaseModel):
    """Portable rule builder state, independent of visual appearance."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    enabled: StrictBool = True
    match: Literal["all", "any"] = "all"
    rules: tuple[VectorFilterRule, ...] = Field(default=(), max_length=MAX_FILTER_RULES)

    @property
    def active(self) -> bool:
        """Return whether this state restricts the layer."""
        return self.enabled and bool(self.rules)


def filter_field_kind(field_type: str) -> str | None:
    """Classify a Catalog attribute for rule validation.

    Args:
        field_type: Authoritative Fiona/Table type.

    Returns:
        Supported scalar kind, or None for missing-value rules only.
    """
    base = field_type.split(":", 1)[0].lower()
    if base in {
        "int",
        "int16",
        "int32",
        "int64",
        "float",
        "float32",
        "float64",
        "real",
    }:
        return "number"
    if base in {"str", "string"}:
        return "string"
    if base in {"bool", "boolean"}:
        return "boolean"
    return "date" if base == "date" else None


def validate_filter(candidate: VectorFilter, fields: Mapping[str, str]) -> VectorFilter:
    """Validate every rule against authoritative Catalog fields, even disabled.

    Args:
        candidate: Structurally bounded submitted state.
        fields: Current non-geometry field identities and types.

    Returns:
        Validated immutable state.

    Raises:
        AttributeFilterError: If a field, operator, or literal is incompatible.
    """
    for rule in candidate.rules:
        if rule.field not in fields:
            raise AttributeFilterError(
                f"Filter field {rule.field!r} is not in this layer"
            )
        kind = filter_field_kind(fields[rule.field])
        if rule.operator in {"missing", "present"}:
            valid = rule.value is None
        else:
            valid = (
                (kind == "number" and type(rule.value) in {int, float})
                or (kind in {"string", "date"} and type(rule.value) is str)
                or (kind == "boolean" and type(rule.value) is bool)
            )
            valid = valid and rule.operator in (
                {"eq", "ne", "contains"}
                if kind == "string"
                else {"eq", "ne"} if kind == "boolean" else set(_COMPARISONS)
            )
            if valid and kind == "date":
                try:
                    valid = date.fromisoformat(rule.value).isoformat() == rule.value
                except ValueError:
                    valid = False
        if not valid:
            raise AttributeFilterError(
                f"Choose a valid operator and {kind or 'missing'} value for {rule.field!r}"
            )
    return candidate


def matches_filter(candidate: VectorFilter, properties: Mapping[str, Any]) -> bool:
    """Evaluate the same null-explicit predicate used by catalog consumers.

    Args:
        candidate: Catalog-validated filter.
        properties: Geometry-free properties from the exact source.

    Returns:
        Whether this feature belongs to the selection.
    """
    if not candidate.active:
        return True
    matches = [
        _matches_rule(rule, properties.get(rule.field)) for rule in candidate.rules
    ]
    return all(matches) if candidate.match == "all" else any(matches)


def _matches_rule(rule: VectorFilterRule, value: Any) -> bool:
    """Evaluate a single null-explicit comparison.

    Args:
        rule: Validated rule.
        value: Source scalar, or None.

    Returns:
        Comparison result; incompatible source scalars do not match.
    """
    if rule.operator == "missing":
        return value is None
    if rule.operator == "present":
        return value is not None
    if value is None:
        return False
    if isinstance(value, date):
        value = value.isoformat()
    target = rule.value
    try:
        if rule.operator == "contains":
            return isinstance(value, str) and target in value
        if rule.operator == "eq":
            return value == target
        if rule.operator == "ne":
            return value != target
        if rule.operator == "gt":
            return value > target
        if rule.operator == "ge":
            return value >= target
        if rule.operator == "lt":
            return value < target
        return value <= target
    except TypeError:
        return False
