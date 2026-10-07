"""Keep categorical fallback membership independent of feature label rules."""

from pathlib import Path
from xml.etree import ElementTree as ET

import pytest

from eolab_app.vector.filters import VectorFilter, filter_vector_sld
from eolab_app.vector.models import VectorStyle
from eolab_app.vector.sources import (
    MountedVectorResolver,
    PublishedVectorRegistry,
    vector_source_signature,
)
from eolab_app.vector.styles import (
    OGC_NAMESPACE,
    SLD_NAMESPACE,
    build_vector_sld,
    default_vector_style,
    vector_style_name,
)
from tests.test_vector_categories import assessed_category_item

NS = {"sld": SLD_NAMESPACE, "ogc": OGC_NAMESPACE}
NATIVE_FIXTURES = (
    Path(__file__).parents[1] / "geoserver/reader-assessment/src/test/resources"
)


def fallback_style(missing_color: str | None = "#0000ff") -> VectorStyle:
    """Build the labelled numeric style used by native rendering regressions.

    Args:
        missing_color: Separate missing color, or None to use Other for nulls.

    Returns:
        Complete validated style with visible, hidden, and fallback categories.
    """
    return VectorStyle.model_validate(
        {
            **default_vector_style("polygon").model_dump(by_alias=True),
            "fillOpacity": 1,
            "categorical": {
                "field": "G200_BIOME",
                "limit": 2,
                "rules": [
                    {"value": {"kind": "number", "value": 1.0}, "color": "#ff0000"},
                    {
                        "value": {"kind": "number", "value": 13.0},
                        "color": "#00ff00",
                        "opacity": 0,
                    },
                ],
                "otherColor": "#9ca3af",
                "missingColor": missing_color,
            },
            "label": {
                "field": "BIOME_1",
                "fontFamily": "SansSerif",
                "fontSize": 12,
                "fontWeight": "normal",
                "fontColor": "#111827",
                "haloColor": "#ffffff",
                "haloWidth": 1.5,
                "placement": "center",
                "minimumZoom": 0,
            },
        }
    )


@pytest.mark.parametrize("missing_color", ["#0000ff", None])
def test_native_fixture_matches_owner_output(missing_color: str | None) -> None:
    """Keep native GeoTools tests bound to the actual Python-generated SLD.

    Args:
        missing_color: Missing-value policy for the corresponding fixture.
    """
    filename = "vector-category-fallback"
    if missing_color is None:
        filename += "-null"
    generated = build_vector_sld(
        "categories", fallback_style(missing_color), geometry_name="shape"
    )
    assert (NATIVE_FIXTURES / f"{filename}.sld").read_bytes() == generated


@pytest.mark.parametrize(
    ("kind", "value", "literal"),
    [
        ("string", " <& 01 ", " <& 01 "),
        ("integer", -1, "-1"),
        ("number", 0.5, "0.5"),
        ("boolean", False, "false"),
    ],
)
def test_single_category_fallback_retains_typed_predicate(
    kind: str, value: str | int | float | bool, literal: str
) -> None:
    """Exclude a typed category even when it is hidden, without a label filter.

    Args:
        kind: Validated scalar kind.
        value: Exact category value.
        literal: Expected escaped XML literal after parsing.
    """
    document = fallback_style(None).model_dump(by_alias=True)
    document["categorical"]["rules"] = [
        {"value": {"kind": kind, "value": value}, "color": "#ff0000", "opacity": 0}
    ]
    root = ET.fromstring(
        build_vector_sld(
            "categories", VectorStyle.model_validate(document), geometry_name="shape"
        )
    )
    feature_styles = root.findall(".//sld:FeatureTypeStyle", NS)
    rules = feature_styles[0].findall("sld:Rule", NS)
    fallback = rules[-1].find("ogc:Filter/ogc:Or", NS)
    assert (
        fallback.findtext("ogc:PropertyIsNull/ogc:PropertyName", namespaces=NS)
        == "G200_BIOME"
    )
    exclusion = fallback.find("ogc:Not/ogc:PropertyIsEqualTo", NS)
    assert exclusion.findtext("ogc:Literal", namespaces=NS) == literal
    assert exclusion.findtext("ogc:PropertyName", namespaces=NS) == "G200_BIOME"
    assert root.find(".//sld:ElseFilter", NS) is None
    assert feature_styles[1].find(".//ogc:Filter", NS) is None


def test_filtered_composite_retains_fallback_and_label_selection(
    tmp_path: Path,
) -> None:
    """Use the same fallback through real authorized composite/filter boundaries.

    Args:
        tmp_path: Isolated assessed mounted source root.
    """
    item, _ = assessed_category_item(tmp_path)
    source = MountedVectorResolver(tmp_path).resolve(item)
    registry = PublishedVectorRegistry()
    document = fallback_style().model_dump(by_alias=True)
    document["categorical"]["field"] = "score"
    document["label"]["field"] = "category"
    style = VectorStyle.model_validate(document)
    style_name = vector_style_name(item["id"], style, geometry_name="shape")
    layer_name = f"eolab:{item['id']}"
    registry.authorize(
        layer_name, source, vector_source_signature(source), style_name, "shape"
    )
    selection = VectorFilter(
        enabled=True,
        match="all",
        rules=[{"field": "score", "operator": "gt", "value": 1.0}],
    )
    filtered_layer = registry.authorize_filter(layer_name, selection)
    authorization = registry.require_current(filtered_layer)
    result = authorization.build_composite_sld(
        filtered_layer, style_name, None, style.model_dump(by_alias=True), 0.5
    )
    expected = filter_vector_sld(
        build_vector_sld(
            style_name,
            style,
            layer_name=layer_name,
            opacity_multiplier=0.5,
            geometry_name="shape",
        ),
        selection,
    )
    assert result == expected
    root = ET.fromstring(result)
    rules = root.findall(".//sld:FeatureTypeStyle/sld:Rule", NS)
    assert len(rules) == 5
    assert rules[3].find("ogc:Filter/ogc:And/ogc:Not/ogc:Or", NS) is not None
    assert all(
        rule.find(".//ogc:PropertyIsGreaterThan", NS) is not None for rule in rules
    )
    assert root.find(".//sld:ElseFilter", NS) is None
    assert (
        rules[3].findtext(".//sld:CssParameter[@name='fill-opacity']", namespaces=NS)
        == "0.5"
    )
