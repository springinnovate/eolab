"""Verify extended vector category appearance at validated render boundaries."""

from copy import deepcopy
import json
from pathlib import Path
from xml.etree import ElementTree

import pytest
from pydantic import ValidationError

from eolab_app.saved_maps.models import CreateSavedMap
from eolab_app.vector.models import VectorCategoryRule, VectorStyle
from eolab_app.vector.styles import (
    SLD_NAMESPACE,
    OGC_NAMESPACE,
    build_vector_sld,
    default_vector_style,
    vector_style_name,
)


@pytest.mark.parametrize("geometry_kind", ["point", "line", "polygon"])
def test_category_opacity_multiplies_symbol_and_whole_layer(geometry_kind: str) -> None:
    """Keep typed matching while applying opacity to every geometry component.

    Args:
        geometry_kind: Supported symbol geometry under test.
    """
    document = default_vector_style(geometry_kind).model_dump(by_alias=True)
    document["strokeOpacity"] = 0.8
    if geometry_kind != "line":
        document["fillOpacity"] = 0.4
    document["categorical"] = {
        "field": "class",
        "limit": 2,
        "rules": [
            {
                "value": {"kind": "string", "value": "Z & 01"},
                "label": "<b>Wetland</b>",
                "color": "#0000ff",
                "opacity": 0.25,
            },
            {
                "value": {"kind": "string", "value": "A"},
                "label": "Hidden",
                "color": "#00ff00",
                "opacity": 0,
            },
        ],
        "otherColor": "#abcdef",
        "missingColor": "#112233",
    }
    style = VectorStyle.model_validate(document)
    restored = VectorStyle.model_validate_json(style.model_dump_json(by_alias=True))
    assert restored == style
    root = ElementTree.fromstring(
        build_vector_sld("categories", style, opacity_multiplier=0.5)
    )
    namespaces = {"sld": SLD_NAMESPACE, "ogc": OGC_NAMESPACE}
    rules = root.findall(".//sld:FeatureTypeStyle/sld:Rule", namespaces)
    assert len(rules) == 4
    assert [
        literal.text
        for rule in rules[:2]
        for literal in rule.findall(".//ogc:Literal", namespaces)
    ] == [
        "Z & 01",
        "A",
    ]
    for rule, multiplier in zip(rules, [0.25, 0, 1, 1], strict=True):
        stroke = rule.find(".//sld:CssParameter[@name='stroke-opacity']", namespaces)
        assert float(stroke.text) == pytest.approx(0.8 * 0.5 * multiplier)
        if geometry_kind != "line":
            fill = rule.find(".//sld:CssParameter[@name='fill-opacity']", namespaces)
            assert float(fill.text) == pytest.approx(0.4 * 0.5 * multiplier)
    assert b"Wetland" not in ElementTree.tostring(root)
    changed = deepcopy(document)
    changed["categorical"]["rules"][0]["opacity"] = 0.5
    assert vector_style_name("source", style) != vector_style_name(
        "source", VectorStyle.model_validate(changed)
    )


def test_category_appearance_defaults_and_input_validation() -> None:
    """Keep old rules readable and reject invalid external presentation data."""
    rule = {"value": {"kind": "integer", "value": 1}, "color": "#ABCDEF"}
    parsed = VectorCategoryRule.model_validate(rule)
    assert parsed.label is None and parsed.opacity == 1
    assert parsed.color == "#abcdef"
    for label in ["", " ", "x" * 257, "bad\x00label", 3]:
        with pytest.raises(ValidationError):
            VectorCategoryRule.model_validate({**rule, "label": label})
    for opacity in [-0.1, 1.1, float("nan"), float("inf"), "0.5", None, True]:
        with pytest.raises(ValidationError):
            VectorCategoryRule.model_validate({**rule, "opacity": opacity})
    assert (
        VectorCategoryRule.model_validate({**rule, "label": "Line one\nline two"}).label
        == "Line one\nline two"
    )


def test_saved_map_preserves_the_owner_validated_vector_category_table() -> None:
    """Round-trip an opaque vector definition through the existing map contract."""
    view = json.loads(
        (Path(__file__).parent / "fixtures" / "saved-map-v1.json").read_text()
    )
    style = default_vector_style("polygon").model_dump(by_alias=True)
    style["categorical"] = {
        "field": "class",
        "limit": 1,
        "otherColor": "#abcdef",
        "missingColor": "#112233",
        "rules": [
            {
                "value": {"kind": "string", "value": "01"},
                "label": "Wetland",
                "color": "#0000ff",
                "opacity": 0.25,
            }
        ],
    }
    definition = VectorStyle.model_validate(style).model_dump(
        by_alias=True, mode="json"
    )
    view["layers"][0]["style"] = {"kind": "vector", "definition": definition}
    request = {"slug": "vector-csv", "title": "CSV categories", "view": view}
    restored = CreateSavedMap.model_validate_json(json.dumps(request))
    assert (
        restored.model_dump(mode="json", exclude_unset=True)["view"]["layers"][0][
            "style"
        ]["definition"]
        == definition
    )
