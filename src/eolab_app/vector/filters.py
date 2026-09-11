"""Bounded vector predicates shared by counting, WMS, and composite styles."""

from collections.abc import Mapping
from copy import deepcopy
from typing import Any
from xml.etree import ElementTree as ET

from pydantic import BaseModel

from eolab_app.attribute_filter import (
    AttributeFilterError,
    MAX_FILTER_RULES as MAX_FILTER_RULES,
    VectorFilter as VectorFilter,
    VectorFilterRule as VectorFilterRule,
    filter_field_kind as filter_field_kind,
    matches_filter as matches_filter,
    validate_filter as validate_attribute_filter,
)
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.models import CatalogVectorRequest


OGC = "http://www.opengis.net/ogc"
SLD = "http://www.opengis.net/sld"
_COMPARISONS = {
    "eq": "PropertyIsEqualTo", "ne": "PropertyIsNotEqualTo",
    "gt": "PropertyIsGreaterThan", "ge": "PropertyIsGreaterThanOrEqualTo",
    "lt": "PropertyIsLessThan", "le": "PropertyIsLessThanOrEqualTo",
}


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


def validate_filter(candidate: VectorFilter, fields: Mapping[str, str]) -> VectorFilter:
    """Translate neutral schema validation into the vector HTTP error contract.

    Args:
        candidate: Structurally validated typed rules.
        fields: Authoritative scalar field names and types.

    Returns:
        The unchanged schema-validated predicate.

    Raises:
        VectorConflictError: If a rule cannot apply to this native layer.
    """
    try:
        return validate_attribute_filter(candidate, fields)
    except AttributeFilterError as error:
        raise VectorConflictError(str(error)) from error


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
