"""Pure vector defaults, content identity, and SLD generation."""

import json
import math
from hashlib import sha256
from xml.etree import ElementTree

from eolab_app.vector.models import (
    VectorGeometryKind,
    VectorLabelStyle,
    VectorStyle,
)


SLD_NAMESPACE = "http://www.opengis.net/sld"
OGC_NAMESPACE = "http://www.opengis.net/ogc"
WEB_MERCATOR_ZOOM_ZERO_SCALE = 559082264.0287178
ElementTree.register_namespace("sld", SLD_NAMESPACE)
ElementTree.register_namespace("ogc", OGC_NAMESPACE)


def default_vector_style(
    geometry_kind: VectorGeometryKind,
) -> VectorStyle:
    """Return the initializer-equivalent style for one geometry class.

    Args:
        geometry_kind: Point, line, or polygon geometry class.

    Returns:
        Complete validated single-color state.
    """
    if geometry_kind == "point":
        return VectorStyle(
            geometryKind="point",
            fillColor="#2b83ba",
            fillOpacity=0.7,
            strokeColor="#000000",
            strokeOpacity=1,
            strokeWidth=0.75,
            pointSize=9,
        )
    if geometry_kind == "line":
        return VectorStyle(
            geometryKind="line",
            strokeColor="#2b83ba",
            strokeOpacity=1,
            strokeWidth=2,
        )
    return VectorStyle(
        geometryKind="polygon",
        fillColor="#2b83ba",
        fillOpacity=0.7,
        strokeColor="#000000",
        strokeOpacity=1,
        strokeWidth=0.75,
    )


def vector_style_name(
    resource_name: str,
    style: VectorStyle,
) -> str:
    """Address one layer's validated settings and generated rendering content.

    Args:
        resource_name: Authoritative server-side vector resource identity.
        style: Complete validated vector style state.

    Returns:
        Safe unqualified style name whose identity changes with rendering.
    """
    resource_digest = sha256(resource_name.encode("utf-8")).hexdigest()[:24]
    style_document = json.dumps(
        style.model_dump(by_alias=True),
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    # Include generated policy so a deployment cannot reuse tiles rendered with
    # older label-placement rules even when the saved settings are unchanged.
    rendered_style = build_vector_sld("vector-style", style)
    style_digest = sha256(style_document + b"\0" + rendered_style).hexdigest()[:12]
    return f"vector-style-{resource_digest}-{style_digest}"


def vector_label_rendering_buffer(style: VectorStyle) -> int:
    """Bound the vector layer query margin for labels crossing tile edges.

    Args:
        style: Validated vector appearance with an optional bounded label font.

    Returns:
        Zero without labels; otherwise a 256–884 pixel margin covering the
        wrapped label width and halo without increasing the output tile size.
    """
    if style.label is None:
        return 0
    return math.ceil(max(256, style.label.font_size * 12 + style.label.halo_width * 2))


def build_vector_sld(
    style_name: str,
    style: VectorStyle,
    *,
    layer_name: str | None = None,
    opacity_multiplier: float = 1,
) -> bytes:
    """Serialize one validated vector style as an SLD 1.0 document.

    Args:
        style_name: Safe deterministic GeoServer style name.
        style: Complete geometry-specific style state.
        layer_name: Optional published layer identity for an external SLD.
        opacity_multiplier: Neutral whole-layer opacity from zero through one.

    Returns:
        UTF-8 XML accepted by the GeoServer style REST boundary.
    """
    root = ElementTree.Element(
        f"{{{SLD_NAMESPACE}}}StyledLayerDescriptor",
        {"version": "1.0.0"},
    )
    named_layer = ElementTree.SubElement(
        root,
        f"{{{SLD_NAMESPACE}}}NamedLayer",
    )
    ElementTree.SubElement(named_layer, f"{{{SLD_NAMESPACE}}}Name").text = (
        layer_name or style_name
    )
    user_style = ElementTree.SubElement(
        named_layer,
        f"{{{SLD_NAMESPACE}}}UserStyle",
    )
    ElementTree.SubElement(user_style, f"{{{SLD_NAMESPACE}}}Name").text = (
        style_name
    )
    feature_type_style = ElementTree.SubElement(
        user_style,
        f"{{{SLD_NAMESPACE}}}FeatureTypeStyle",
    )
    if style.categorical is not None:
        categorical = style.categorical
        for category_rule in categorical.rules:
            rule = ElementTree.SubElement(
                feature_type_style,
                f"{{{SLD_NAMESPACE}}}Rule",
            )
            _append_category_filter(
                rule,
                categorical.field,
                category_rule.value.kind,
                category_rule.value.value,
            )
            _append_symbolizer(
                rule,
                style,
                category_rule.color,
                opacity_multiplier,
            )
        if categorical.missing_color is not None:
            rule = ElementTree.SubElement(
                feature_type_style,
                f"{{{SLD_NAMESPACE}}}Rule",
            )
            _append_null_filter(rule, categorical.field)
            _append_symbolizer(
                rule,
                style,
                categorical.missing_color,
                opacity_multiplier,
            )
        if categorical.other_color is not None:
            rule = ElementTree.SubElement(
                feature_type_style,
                f"{{{SLD_NAMESPACE}}}Rule",
            )
            ElementTree.SubElement(
                rule,
                f"{{{SLD_NAMESPACE}}}ElseFilter",
            )
            _append_symbolizer(
                rule,
                style,
                categorical.other_color,
                opacity_multiplier,
            )
    elif style.graduated is not None:
        graduated = style.graduated
        for graduated_rule in graduated.rules:
            rule = ElementTree.SubElement(
                feature_type_style,
                f"{{{SLD_NAMESPACE}}}Rule",
            )
            _append_numeric_range_filter(
                rule,
                graduated.field,
                graduated_rule.minimum,
                graduated_rule.maximum,
            )
            _append_symbolizer(
                rule,
                style,
                graduated_rule.color,
                opacity_multiplier,
            )
        if graduated.missing_color is not None:
            rule = ElementTree.SubElement(
                feature_type_style,
                f"{{{SLD_NAMESPACE}}}Rule",
            )
            _append_null_filter(rule, graduated.field)
            _append_symbolizer(
                rule,
                style,
                graduated.missing_color,
                opacity_multiplier,
            )
    else:
        _append_symbol_rule(feature_type_style, style, opacity_multiplier)
    if style.label is not None:
        label_feature_type_style = feature_type_style
        if style.categorical is not None or style.graduated is not None:
            label_feature_type_style = ElementTree.SubElement(
                user_style,
                f"{{{SLD_NAMESPACE}}}FeatureTypeStyle",
            )
        _append_label_rule(
            label_feature_type_style,
            style.geometry_kind,
            style.label,
            opacity_multiplier,
        )
    return ElementTree.tostring(
        root,
        encoding="utf-8",
        xml_declaration=True,
    )


def _append_symbol_rule(
    feature_type_style: ElementTree.Element,
    style: VectorStyle,
    opacity_multiplier: float,
) -> None:
    """Append one unfiltered geometry rule for a single-color style.

    Args:
        feature_type_style: SLD feature-type style receiving the rule.
        style: Complete validated vector style.
        opacity_multiplier: Neutral whole-layer opacity from zero through one.
    """
    rule = ElementTree.SubElement(
        feature_type_style,
        f"{{{SLD_NAMESPACE}}}Rule",
    )
    _append_symbolizer(rule, style, opacity_multiplier=opacity_multiplier)


def _append_symbolizer(
    rule: ElementTree.Element,
    style: VectorStyle,
    classification_color: str | None = None,
    opacity_multiplier: float = 1,
) -> None:
    """Append a geometry symbolizer with an optional classification color.

    Args:
        rule: SLD rule receiving the geometry symbolizer.
        style: Complete validated vector style.
        classification_color: Optional validated categorical or graduated color
            replacing point/polygon fill or line stroke while retaining all
            other symbol controls.
        opacity_multiplier: Neutral whole-layer opacity from zero through one.
    """
    symbolizer = ElementTree.SubElement(
        rule,
        f"{{{SLD_NAMESPACE}}}{style.geometry_kind.title()}Symbolizer",
    )
    if style.geometry_kind == "point":
        graphic = ElementTree.SubElement(
            symbolizer,
            f"{{{SLD_NAMESPACE}}}Graphic",
        )
        mark = ElementTree.SubElement(graphic, f"{{{SLD_NAMESPACE}}}Mark")
        ElementTree.SubElement(
            mark,
            f"{{{SLD_NAMESPACE}}}WellKnownName",
        ).text = "circle"
        _append_fill(mark, style, classification_color, opacity_multiplier)
        _append_stroke(mark, style, opacity_multiplier=opacity_multiplier)
        ElementTree.SubElement(
            graphic,
            f"{{{SLD_NAMESPACE}}}Size",
        ).text = _number(style.point_size)
    elif style.geometry_kind == "line":
        _append_stroke(
            symbolizer,
            style,
            line_cap=True,
            color=classification_color,
            opacity_multiplier=opacity_multiplier,
        )
    else:
        _append_fill(
            symbolizer,
            style,
            classification_color,
            opacity_multiplier,
        )
        _append_stroke(
            symbolizer,
            style,
            opacity_multiplier=opacity_multiplier,
        )


def _append_category_filter(
    rule: ElementTree.Element,
    field: str,
    value_kind: str,
    value: object,
) -> None:
    """Append one typed property-equality filter to an SLD rule.

    Args:
        rule: SLD rule receiving the filter.
        field: Validated authoritative property name.
        value_kind: Explicit scalar kind validated with the category value.
        value: Strict bool, int, float, or string category value.
    """
    filter_element = ElementTree.SubElement(
        rule,
        f"{{{OGC_NAMESPACE}}}Filter",
    )
    comparison = ElementTree.SubElement(
        filter_element,
        f"{{{OGC_NAMESPACE}}}PropertyIsEqualTo",
    )
    ElementTree.SubElement(
        comparison,
        f"{{{OGC_NAMESPACE}}}PropertyName",
    ).text = field
    ElementTree.SubElement(
        comparison,
        f"{{{OGC_NAMESPACE}}}Literal",
    ).text = _category_literal(value_kind, value)


def _append_numeric_range_filter(
    rule: ElementTree.Element,
    field: str,
    minimum: float | None,
    maximum: float | None,
) -> None:
    """Append one complete open-ended numeric range filter.

    Lower bounds are exclusive and upper bounds are inclusive, matching the
    server classification contract without overlapping adjacent rules.

    Args:
        rule: SLD rule receiving the filter.
        field: Validated authoritative numeric property name.
        minimum: Optional exclusive lower boundary.
        maximum: Optional inclusive upper boundary.
    """
    filter_element = ElementTree.SubElement(
        rule,
        f"{{{OGC_NAMESPACE}}}Filter",
    )
    if minimum is None and maximum is None:
        negation = ElementTree.SubElement(
            filter_element,
            f"{{{OGC_NAMESPACE}}}Not",
        )
        _append_property_is_null(negation, field)
        return
    comparisons: list[tuple[str, float]] = []
    if minimum is not None:
        comparisons.append(("PropertyIsGreaterThan", minimum))
    if maximum is not None:
        comparisons.append(("PropertyIsLessThanOrEqualTo", maximum))
    parent = filter_element
    if len(comparisons) == 2:
        parent = ElementTree.SubElement(
            filter_element,
            f"{{{OGC_NAMESPACE}}}And",
        )
    for operator, boundary in comparisons:
        comparison = ElementTree.SubElement(
            parent,
            f"{{{OGC_NAMESPACE}}}{operator}",
        )
        ElementTree.SubElement(
            comparison,
            f"{{{OGC_NAMESPACE}}}PropertyName",
        ).text = field
        ElementTree.SubElement(
            comparison,
            f"{{{OGC_NAMESPACE}}}Literal",
        ).text = _number(boundary)


def _append_null_filter(rule: ElementTree.Element, field: str) -> None:
    """Append one property-is-null filter to an SLD rule.

    Args:
        rule: SLD rule receiving the filter.
        field: Validated authoritative property name.
    """
    filter_element = ElementTree.SubElement(
        rule,
        f"{{{OGC_NAMESPACE}}}Filter",
    )
    _append_property_is_null(filter_element, field)


def _append_property_is_null(
    parent: ElementTree.Element,
    field: str,
) -> None:
    """Append one property-is-null expression below an OGC parent.

    Args:
        parent: Filter or logical expression receiving the comparison.
        field: Validated authoritative property name.
    """
    comparison = ElementTree.SubElement(
        parent,
        f"{{{OGC_NAMESPACE}}}PropertyIsNull",
    )
    ElementTree.SubElement(
        comparison,
        f"{{{OGC_NAMESPACE}}}PropertyName",
    ).text = field


def _category_literal(value_kind: str, value: object) -> str:
    """Serialize one validated explicitly typed category value.

    Args:
        value_kind: Explicit scalar kind.
        value: Scalar value whose exact Python type matches the kind.

    Returns:
        Stable OGC literal text interpreted against the property schema.

    Raises:
        TypeError: If an internal caller violates the validated value contract.
    """
    expected_types = {
        "boolean": bool,
        "integer": int,
        "number": float,
        "string": str,
    }
    if value_kind not in expected_types or type(value) is not expected_types[value_kind]:
        raise TypeError("Category value kind does not match its value")
    if value_kind == "boolean":
        return "true" if value else "false"
    if value_kind == "number":
        return format(value, ".17g")
    return str(value)


def _append_label_rule(
    feature_type_style: ElementTree.Element,
    geometry_kind: VectorGeometryKind,
    label: VectorLabelStyle,
    opacity_multiplier: float,
) -> None:
    """Append one independently scaled text rule to a vector style.

    Args:
        feature_type_style: SLD feature-type style receiving the label rule.
        geometry_kind: Point, line, or polygon geometry class.
        label: Complete validated label presentation.
        opacity_multiplier: Neutral whole-layer opacity from zero through one.

    Returns:
        None. Appends the independently scaled label rule in place.
    """
    rule = ElementTree.SubElement(
        feature_type_style,
        f"{{{SLD_NAMESPACE}}}Rule",
    )
    if label.minimum_zoom > 0:
        maximum_scale = WEB_MERCATOR_ZOOM_ZERO_SCALE / (
            2 ** label.minimum_zoom
        )
        ElementTree.SubElement(
            rule,
            f"{{{SLD_NAMESPACE}}}MaxScaleDenominator",
        ).text = _number(maximum_scale)
    text_symbolizer = ElementTree.SubElement(
        rule,
        f"{{{SLD_NAMESPACE}}}TextSymbolizer",
    )
    fixed_placement = geometry_kind != "line" or label.placement == "center"
    if geometry_kind == "polygon" or (geometry_kind == "line" and fixed_placement):
        geometry = ElementTree.SubElement(text_symbolizer, f"{{{SLD_NAMESPACE}}}Geometry")
        anchor = ElementTree.SubElement(
            geometry,
            f"{{{OGC_NAMESPACE}}}Function",
            {"name": "interiorPoint" if geometry_kind == "polygon" else "centroid"},
        )
        # GeoTools' empty property name selects the feature's default geometry,
        # without guessing a source-specific geometry-column identity.
        ElementTree.SubElement(anchor, f"{{{OGC_NAMESPACE}}}PropertyName")
    label_expression = ElementTree.SubElement(
        text_symbolizer,
        f"{{{SLD_NAMESPACE}}}Label",
    )
    ElementTree.SubElement(
        label_expression,
        f"{{{OGC_NAMESPACE}}}PropertyName",
    ).text = label.field
    _append_label_font(text_symbolizer, label)
    _append_label_placement(text_symbolizer, geometry_kind, label)
    if label.halo_width > 0:
        halo = ElementTree.SubElement(
            text_symbolizer,
            f"{{{SLD_NAMESPACE}}}Halo",
        )
        ElementTree.SubElement(
            halo,
            f"{{{SLD_NAMESPACE}}}Radius",
        ).text = _number(label.halo_width)
        halo_fill = ElementTree.SubElement(
            halo,
            f"{{{SLD_NAMESPACE}}}Fill",
        )
        _append_css_parameter(halo_fill, "fill", label.halo_color)
        _append_css_parameter(
            halo_fill,
            "fill-opacity",
            _number(opacity_multiplier),
        )
    text_fill = ElementTree.SubElement(
        text_symbolizer,
        f"{{{SLD_NAMESPACE}}}Fill",
    )
    _append_css_parameter(text_fill, "fill", label.font_color)
    _append_css_parameter(
        text_fill,
        "fill-opacity",
        _number(opacity_multiplier),
    )
    if geometry_kind == "line" and label.placement != "center":
        _append_vendor_option(text_symbolizer, "followLine", "true")
    if geometry_kind == "polygon":
        # Keep polygon-fit rejection disabled alongside fixed label anchors.
        _append_vendor_option(text_symbolizer, "goodnessOfFit", "0")
    _append_vendor_option(text_symbolizer, "conflictResolution", "false")
    if fixed_placement:
        _append_vendor_option(text_symbolizer, "partials", "true")
        _append_vendor_option(text_symbolizer, "autoWrap", _number(max(120, label.font_size * 12)))


def _append_label_font(
    text_symbolizer: ElementTree.Element,
    label: VectorLabelStyle,
) -> None:
    """Append bounded font parameters to a text symbolizer.

    Args:
        text_symbolizer: SLD text symbolizer receiving font parameters.
        label: Complete validated label presentation.
    """
    font = ElementTree.SubElement(
        text_symbolizer,
        f"{{{SLD_NAMESPACE}}}Font",
    )
    _append_css_parameter(font, "font-family", label.font_family)
    _append_css_parameter(font, "font-style", "normal")
    _append_css_parameter(font, "font-weight", label.font_weight)
    _append_css_parameter(font, "font-size", _number(label.font_size))


def _append_label_placement(
    text_symbolizer: ElementTree.Element,
    geometry_kind: VectorGeometryKind,
    label: VectorLabelStyle,
) -> None:
    """Append point or line placement selected by validated label state.

    Args:
        text_symbolizer: SLD text symbolizer receiving placement parameters.
        geometry_kind: Point, line, or polygon geometry class.
        label: Complete validated label presentation.
    """
    placement = ElementTree.SubElement(
        text_symbolizer,
        f"{{{SLD_NAMESPACE}}}LabelPlacement",
    )
    if geometry_kind == "line" and label.placement != "center":
        line_placement = ElementTree.SubElement(
            placement,
            f"{{{SLD_NAMESPACE}}}LinePlacement",
        )
        if label.placement != "follow-line":
            offset = 6 if label.placement == "above" else -6
            ElementTree.SubElement(
                line_placement,
                f"{{{SLD_NAMESPACE}}}PerpendicularOffset",
            ).text = str(offset)
        return
    point_placement = ElementTree.SubElement(
        placement,
        f"{{{SLD_NAMESPACE}}}PointPlacement",
    )
    anchor_point = ElementTree.SubElement(
        point_placement,
        f"{{{SLD_NAMESPACE}}}AnchorPoint",
    )
    anchor_y = {"center": 0.5, "above": 0, "below": 1}[label.placement]
    ElementTree.SubElement(
        anchor_point,
        f"{{{SLD_NAMESPACE}}}AnchorPointX",
    ).text = "0.5"
    ElementTree.SubElement(
        anchor_point,
        f"{{{SLD_NAMESPACE}}}AnchorPointY",
    ).text = _number(anchor_y)
    displacement = ElementTree.SubElement(
        point_placement,
        f"{{{SLD_NAMESPACE}}}Displacement",
    )
    ElementTree.SubElement(
        displacement,
        f"{{{SLD_NAMESPACE}}}DisplacementX",
    ).text = "0"
    displacement_y = {"center": 0, "above": 6, "below": -6}[
        label.placement
    ]
    ElementTree.SubElement(
        displacement,
        f"{{{SLD_NAMESPACE}}}DisplacementY",
    ).text = str(displacement_y)


def _append_vendor_option(
    parent: ElementTree.Element,
    name: str,
    value: str,
) -> None:
    """Append one bounded GeoServer vendor option.

    Args:
        parent: Text symbolizer receiving the option.
        name: Fixed option name selected by the SLD generator.
        value: Fixed option value selected by the SLD generator.
    """
    ElementTree.SubElement(
        parent,
        f"{{{SLD_NAMESPACE}}}VendorOption",
        {"name": name},
    ).text = value


def _append_css_parameter(
    parent: ElementTree.Element,
    name: str,
    value: str,
) -> None:
    """Append one namespaced SLD CSS parameter.

    Args:
        parent: Fill or Stroke element receiving the parameter.
        name: GeoTools CSS parameter name.
        value: Validated serialized parameter value.
    """
    parameter = ElementTree.SubElement(
        parent,
        f"{{{SLD_NAMESPACE}}}CssParameter",
        {"name": name},
    )
    parameter.text = value


def _append_fill(
    parent: ElementTree.Element,
    style: VectorStyle,
    color: str | None = None,
    opacity_multiplier: float = 1,
) -> None:
    """Append validated fill parameters to a symbolizer component.

    Args:
        parent: Mark or polygon symbolizer receiving the fill.
        style: Validated point or polygon style.
        color: Optional categorical or graduated fill color.
        opacity_multiplier: Neutral whole-layer opacity from zero through one.
    """
    fill = ElementTree.SubElement(parent, f"{{{SLD_NAMESPACE}}}Fill")
    _append_css_parameter(
        fill,
        "fill",
        color or style.fill_color or "#000000",
    )
    _append_css_parameter(
        fill,
        "fill-opacity",
        _number(style.fill_opacity * opacity_multiplier),
    )


def _append_stroke(
    parent: ElementTree.Element,
    style: VectorStyle,
    line_cap: bool = False,
    color: str | None = None,
    opacity_multiplier: float = 1,
) -> None:
    """Append validated stroke parameters to a symbolizer component.

    Args:
        parent: Symbolizer or Mark receiving the stroke.
        style: Complete validated style.
        line_cap: Whether to request round line endings.
        color: Optional categorical or graduated stroke color.
        opacity_multiplier: Neutral whole-layer opacity from zero through one.
    """
    stroke = ElementTree.SubElement(parent, f"{{{SLD_NAMESPACE}}}Stroke")
    _append_css_parameter(stroke, "stroke", color or style.stroke_color)
    _append_css_parameter(
        stroke,
        "stroke-opacity",
        _number(style.stroke_opacity * opacity_multiplier),
    )
    _append_css_parameter(
        stroke,
        "stroke-width",
        _number(style.stroke_width),
    )
    if line_cap:
        _append_css_parameter(stroke, "stroke-linecap", "round")


def _number(value: float | None) -> str:
    """Serialize one validated finite style number without noise.

    Args:
        value: Validated style number.

    Returns:
        Compact decimal representation.
    """
    if value is None:
        raise ValueError("Required style number is absent")
    return format(value, ".15g")
