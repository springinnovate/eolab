"""Build inline GeoServer styles for continuous raster layers."""

from collections.abc import Mapping
from xml.etree import ElementTree


SLD_NAMESPACE = "http://www.opengis.net/sld"
OGC_NAMESPACE = "http://www.opengis.net/ogc"


def build_raster_composite_sld(
    layer_name: str,
    assignments: Mapping[str, str],
    opacity: float,
) -> bytes:
    """Build a gradient with an optional exact-value color for WMS rendering.

    Args:
        layer_name: Current workspace-qualified GeoServer raster layer.
        assignments: Authorized gradient stops and optional complete exact-value rule.
        opacity: Neutral retained-layer opacity from zero through one.

    Returns:
        Single-layer SLD for direct or composite rendering, with whole-layer
        opacity applied after coloring the samples.
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
    if "vexact" in assignments:
        transformation = ElementTree.Element(f"{{{SLD_NAMESPACE}}}Transformation")
        feature_type_style.insert(0, transformation)
        function = ElementTree.SubElement(
            transformation, f"{{{OGC_NAMESPACE}}}Function", {"name": "eolabRasterValueOverride"}
        )
        for quantity, suffix in (("min", "min"), ("med", "med"), ("max", "max"), ("vexact", "exact")):
            value = float(assignments[quantity])
            alpha = float(assignments.get(f"a{suffix}", "1"))
            ElementTree.SubElement(function, f"{{{OGC_NAMESPACE}}}Literal").text = (
                f"{value}:{assignments[f'c{suffix}']}:{alpha}"
            )
        return ElementTree.tostring(root, encoding="utf-8", xml_declaration=True)
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
