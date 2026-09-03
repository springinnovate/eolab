"""Raster-owned SLD generation for a validated composite map layer."""

from collections.abc import Mapping
from xml.etree import ElementTree


SLD_NAMESPACE = "http://www.opengis.net/sld"


def build_raster_composite_sld(
    layer_name: str,
    assignments: Mapping[str, str],
    opacity: float,
) -> bytes:
    """Build one inline raster style from validated dynamic assignments.

    Args:
        layer_name: Current workspace-qualified GeoServer raster layer.
        assignments: Validated threshold, color, and stop-opacity values.
        opacity: Neutral retained-layer opacity from zero through one.

    Returns:
        Complete single-layer SLD document for composite rendering.
    """
    root = ElementTree.Element(
        f"{{{SLD_NAMESPACE}}}StyledLayerDescriptor",
        {"version": "1.0.0"},
    )
    named_layer = ElementTree.SubElement(
        root,
        f"{{{SLD_NAMESPACE}}}NamedLayer",
    )
    ElementTree.SubElement(
        named_layer,
        f"{{{SLD_NAMESPACE}}}Name",
    ).text = layer_name
    user_style = ElementTree.SubElement(
        named_layer,
        f"{{{SLD_NAMESPACE}}}UserStyle",
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
        f"{{{SLD_NAMESPACE}}}RasterSymbolizer",
    )
    ElementTree.SubElement(
        symbolizer,
        f"{{{SLD_NAMESPACE}}}Opacity",
    ).text = format(opacity, ".15g")
    color_map = ElementTree.SubElement(
        symbolizer,
        f"{{{SLD_NAMESPACE}}}ColorMap",
        {"type": "ramp"},
    )
    for suffix, label in (("min", "min"), ("med", "med"), ("max", "max")):
        ElementTree.SubElement(
            color_map,
            f"{{{SLD_NAMESPACE}}}ColorMapEntry",
            {
                "color": assignments[f"c{suffix}"],
                "quantity": assignments[suffix],
                "opacity": assignments.get(f"a{suffix}", "1"),
                "label": label,
            },
        )
    return ElementTree.tostring(root, encoding="utf-8", xml_declaration=True)
