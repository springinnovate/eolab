"""Pure vector single-symbol defaults, identity, and SLD generation."""

from hashlib import sha256
from xml.etree import ElementTree

from eolab_app.vector.models import (
    VectorGeometryKind,
    VectorSingleSymbolStyle,
)


SLD_NAMESPACE = "http://www.opengis.net/sld"
OGC_NAMESPACE = "http://www.opengis.net/ogc"
ElementTree.register_namespace("", SLD_NAMESPACE)
ElementTree.register_namespace("ogc", OGC_NAMESPACE)


def default_vector_style(
    geometry_kind: VectorGeometryKind,
) -> VectorSingleSymbolStyle:
    """Return the initializer-equivalent style for one geometry class.

    Args:
        geometry_kind: Point, line, or polygon geometry class.

    Returns:
        Complete validated single-symbol state.
    """
    if geometry_kind == "point":
        return VectorSingleSymbolStyle(
            geometryKind="point",
            fillColor="#06b6d4",
            fillOpacity=1,
            strokeColor="#083344",
            strokeOpacity=1,
            strokeWidth=1.5,
            pointSize=9,
        )
    if geometry_kind == "line":
        return VectorSingleSymbolStyle(
            geometryKind="line",
            strokeColor="#f97316",
            strokeOpacity=1,
            strokeWidth=3,
        )
    return VectorSingleSymbolStyle(
        geometryKind="polygon",
        fillColor="#a855f7",
        fillOpacity=0.38,
        strokeColor="#581c87",
        strokeOpacity=1,
        strokeWidth=2,
    )


def vector_style_name(resource_name: str) -> str:
    """Build a bounded deterministic GeoServer style name for one layer.

    Args:
        resource_name: Authoritative server-side vector resource identity.

    Returns:
        Safe unqualified per-layer style name.
    """
    digest = sha256(resource_name.encode("utf-8")).hexdigest()[:24]
    return f"vector-single-{digest}"


def build_vector_sld(
    style_name: str,
    style: VectorSingleSymbolStyle,
) -> bytes:
    """Serialize one validated vector style as an SLD 1.0 document.

    Args:
        style_name: Safe deterministic GeoServer style name.
        style: Complete geometry-specific style state.

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
        style_name
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
    rule = ElementTree.SubElement(
        feature_type_style,
        f"{{{SLD_NAMESPACE}}}Rule",
    )
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
        _append_fill(mark, style)
        _append_stroke(mark, style)
        ElementTree.SubElement(
            graphic,
            f"{{{SLD_NAMESPACE}}}Size",
        ).text = _number(style.point_size)
    elif style.geometry_kind == "line":
        _append_stroke(symbolizer, style, line_cap=True)
    else:
        _append_fill(symbolizer, style)
        _append_stroke(symbolizer, style)
    return ElementTree.tostring(
        root,
        encoding="utf-8",
        xml_declaration=True,
    )


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
    style: VectorSingleSymbolStyle,
) -> None:
    """Append validated fill parameters to a symbolizer component.

    Args:
        parent: Mark or polygon symbolizer receiving the fill.
        style: Validated point or polygon style.
    """
    fill = ElementTree.SubElement(parent, f"{{{SLD_NAMESPACE}}}Fill")
    _append_css_parameter(fill, "fill", style.fill_color or "#000000")
    _append_css_parameter(
        fill,
        "fill-opacity",
        _number(style.fill_opacity),
    )


def _append_stroke(
    parent: ElementTree.Element,
    style: VectorSingleSymbolStyle,
    line_cap: bool = False,
) -> None:
    """Append validated stroke parameters to a symbolizer component.

    Args:
        parent: Symbolizer or Mark receiving the stroke.
        style: Complete validated style.
        line_cap: Whether to request round line endings.
    """
    stroke = ElementTree.SubElement(parent, f"{{{SLD_NAMESPACE}}}Stroke")
    _append_css_parameter(stroke, "stroke", style.stroke_color)
    _append_css_parameter(
        stroke,
        "stroke-opacity",
        _number(style.stroke_opacity),
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
