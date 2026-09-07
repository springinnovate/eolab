"""Bounded vector predicates shared by counting, WMS, and composite styles."""

from collections.abc import Mapping
from copy import deepcopy
from datetime import date
from math import isfinite
from typing import Any, Literal
from xml.etree import ElementTree as ET

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictFloat, StrictInt, StrictStr, field_validator

from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.models import CatalogVectorRequest


OGC = "http://www.opengis.net/ogc"
SLD = "http://www.opengis.net/sld"
MAX_FILTER_RULES = 12
_COMPARISONS = {
    "eq": "PropertyIsEqualTo", "ne": "PropertyIsNotEqualTo",
    "gt": "PropertyIsGreaterThan", "ge": "PropertyIsGreaterThanOrEqualTo",
    "lt": "PropertyIsLessThan", "le": "PropertyIsLessThanOrEqualTo",
}


class VectorFilterRule(BaseModel):
    """One bounded, typed attribute comparison; never executable source text."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    field: StrictStr = Field(min_length=1, max_length=256)
    operator: Literal["eq", "ne", "gt", "ge", "lt", "le", "contains", "missing", "present"]
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
        if isinstance(value, str) and (len(value) > 256 or any(ord(c) < 32 for c in value)):
            raise ValueError("Text must be at most 256 characters without control characters")
        if type(value) in {int, float} and (not isfinite(value) or abs(value) > 2**53 - 1):
            raise ValueError("Numbers must be finite and within the browser's safe numeric range")
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


class CatalogVectorFilterRequest(CatalogVectorRequest):
    """Catalog identity and bounded rule builder state."""

    filter: VectorFilter


class AppliedVectorFilter(BaseModel):
    """Browser-safe applied predicate and authorized rendering identity."""

    layerName: str
    filter: VectorFilter


class VectorFilterCount(BaseModel):
    """Exact whole-layer count or an explicit incomplete result."""

    matched: int | None = None
    total: int | None = None
    complete: bool = False


def filter_field_kind(field_type: str) -> str | None:
    """Classify a Catalog attribute for rule validation.

    Args:
        field_type: Authoritative Fiona/Table type.

    Returns:
        Supported scalar kind, or None for missing-value rules only.
    """
    base = field_type.split(":", 1)[0].lower()
    if base in {"int", "int16", "int32", "int64", "float", "float32", "float64", "real"}:
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
        VectorConflictError: If a field, operator, or literal is incompatible.
    """
    for rule in candidate.rules:
        if rule.field not in fields:
            raise VectorConflictError(f"Filter field {rule.field!r} is not in this layer")
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
                {"eq", "ne", "contains"} if kind == "string" else
                {"eq", "ne"} if kind == "boolean" else set(_COMPARISONS)
            )
            if valid and kind == "date":
                try:
                    valid = date.fromisoformat(rule.value).isoformat() == rule.value
                except ValueError:
                    valid = False
        if not valid:
            raise VectorConflictError(f"Choose a valid operator and {kind or 'missing'} value for {rule.field!r}")
    return candidate


def matches_filter(candidate: VectorFilter, properties: Mapping[str, Any]) -> bool:
    """Evaluate the same null-explicit predicate used for rendering.

    Args:
        candidate: Catalog-validated filter.
        properties: Geometry-free properties from the exact source.

    Returns:
        Whether this feature belongs to the applied view.
    """
    if not candidate.active:
        return True
    matches = [_matches_rule(rule, properties.get(rule.field)) for rule in candidate.rules]
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


def filter_ecql(candidate: VectorFilter) -> str:
    """Compile validated literal rules into server-owned ECQL.

    Args:
        candidate: Active, Catalog-validated filter.

    Returns:
        A bounded ECQL expression; user text is always a quoted literal.
    """
    expressions = []
    for rule in candidate.rules:
        field = '"' + rule.field.replace('"', '""') + '"'
        if rule.operator in {"missing", "present"}:
            expression = f"{field} IS {'NOT ' if rule.operator == 'present' else ''}NULL"
        else:
            literal = _ecql_literal(rule.value)
            if rule.operator == "contains":
                comparison = f"strIndexOf({field}, {literal}) >= 0"
            else:
                symbol = {"eq": "=", "ne": "<>", "gt": ">", "ge": ">=", "lt": "<", "le": "<="}[rule.operator]
                comparison = f"{field} {symbol} {literal}"
            expression = f"({field} IS NOT NULL AND {comparison})"
        expressions.append(f"({expression})")
    return (" AND " if candidate.match == "all" else " OR ").join(expressions) or "INCLUDE"


def _ecql_literal(value: Any) -> str:
    """Encode one safe ECQL scalar.

    Args:
        value: Validated scalar literal.

    Returns:
        Escaped ECQL literal text.
    """
    if isinstance(value, str):
        return "'" + value.replace("'", "''") + "'"
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _node(name: str, *children: ET.Element, text: str | None = None) -> ET.Element:
    """Build a namespace-qualified OGC predicate node.

    Args:
        name: Fixed OGC element name.
        children: Child expression nodes.
        text: Optional scalar text, escaped by ElementTree.

    Returns:
        New detached OGC element.
    """
    node = ET.Element(f"{{{OGC}}}{name}")
    node.extend(children)
    node.text = text
    return node


def filter_ogc(candidate: VectorFilter) -> ET.Element:
    """Compile the same validated rules into an OGC predicate tree.

    Args:
        candidate: Active, Catalog-validated filter.

    Returns:
        Detached predicate root for an SLD Filter element.
    """
    expressions = []
    for rule in candidate.rules:
        field = _node("PropertyName", text=rule.field)
        missing = _node("PropertyIsNull", deepcopy(field))
        present = _node("Not", missing)
        if rule.operator == "missing":
            expressions.append(missing)
        elif rule.operator == "present":
            expressions.append(present)
        else:
            literal = _node("Literal", text=(str(rule.value).lower() if isinstance(rule.value, bool) else str(rule.value)))
            if rule.operator == "contains":
                function = _node("Function", field, literal)
                function.set("name", "strIndexOf")
                comparison = _node("PropertyIsGreaterThanOrEqualTo", function, _node("Literal", text="0"))
            else:
                comparison = _node(_COMPARISONS[rule.operator], field, literal)
                comparison.set("matchCase", "true")
            expressions.append(_node("And", present, comparison))
    return expressions[0] if len(expressions) == 1 else _node("And" if candidate.match == "all" else "Or", *expressions)


def filter_vector_sld(document: bytes, candidate: VectorFilter) -> bytes:
    """Restrict every geometry and label rule without changing class ranges.

    Args:
        document: Authorized single-layer vector SLD.
        candidate: Active Catalog-validated filter.

    Returns:
        SLD with selection intersected with each original rule. Else rules
        retain the complement of their sibling class predicates.
    """
    root = ET.fromstring(document)
    selection = filter_ogc(candidate)
    for feature_style in root.iter(f"{{{SLD}}}FeatureTypeStyle"):
        rules = feature_style.findall(f"{{{SLD}}}Rule")
        alternatives = []
        unconditional = False
        for rule in rules:
            existing = rule.find(f"{{{OGC}}}Filter")
            if existing is not None:
                alternatives.append(deepcopy(existing[0]))
            elif rule.find(f"{{{SLD}}}ElseFilter") is None:
                unconditional = True
        for rule in rules:
            existing = rule.find(f"{{{OGC}}}Filter")
            otherwise = rule.find(f"{{{SLD}}}ElseFilter")
            predicate = deepcopy(selection)
            position = 0
            if existing is not None:
                position = list(rule).index(existing)
                predicate = _node("And", predicate, deepcopy(existing[0]))
                rule.remove(existing)
            elif otherwise is not None:
                position = list(rule).index(otherwise)
                rule.remove(otherwise)
                if unconditional:
                    # An unconditional sibling consumes every feature.
                    predicate = _node("And", predicate, _node("Not", deepcopy(selection)))
                elif alternatives:
                    union = deepcopy(alternatives[0]) if len(alternatives) == 1 else _node("Or", *deepcopy(alternatives))
                    predicate = _node("And", predicate, _node("Not", union))
            else:
                # SLD filter follows Name/Title/Description, before scale/symbols.
                while position < len(rule) and rule[position].tag in {f"{{{SLD}}}{name}" for name in ("Name", "Title", "Abstract") }:
                    position += 1
            rule.insert(position, _node("Filter", predicate))
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)
