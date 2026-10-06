"""Raster-owned SLD for exact categorical rendering in the GeoServer adapter."""

from xml.etree import ElementTree

from eolab_app.raster.styles import CategoricalRasterStyle

SLD_NAMESPACE = "http://www.opengis.net/sld"
OGC_NAMESPACE = "http://www.opengis.net/ogc"


def build_categorical_raster_sld(
    layer_name: str,
    style: CategoricalRasterStyle,
    opacity: float,
) -> bytes:
    """Build a trusted categorical rendering transformation and layer opacity.

    Args:
        layer_name: Authorized workspace-qualified GeoServer raster identity.
        style: Validated immutable categorical appearance.
        opacity: Validated retained-layer opacity from zero through one.

    Returns:
        Complete single-layer SLD bytes. Only bounded numeric, hex-color, and
        opacity literals enter the native rendering function. Labels stay in
        the display contract and cannot become GeoServer expressions.
    """
    root = ElementTree.Element(
        f"{{{SLD_NAMESPACE}}}StyledLayerDescriptor", {"version": "1.0.0"}
    )
    layer = ElementTree.SubElement(root, f"{{{SLD_NAMESPACE}}}NamedLayer")
    ElementTree.SubElement(layer, f"{{{SLD_NAMESPACE}}}Name").text = layer_name
    user_style = ElementTree.SubElement(layer, f"{{{SLD_NAMESPACE}}}UserStyle")
    feature_style = ElementTree.SubElement(
        user_style, f"{{{SLD_NAMESPACE}}}FeatureTypeStyle"
    )
    transformation = ElementTree.SubElement(
        feature_style, f"{{{SLD_NAMESPACE}}}Transformation"
    )
    function = ElementTree.SubElement(
        transformation,
        f"{{{OGC_NAMESPACE}}}Function",
        {"name": "eolabCategoricalRaster"},
    )
    table = ";".join(
        f"{category.value}:{category.color}:{format(category.opacity, '.17g')}"
        for category in sorted(style.categories, key=lambda item: item.value)
    )
    for value in (table, style.unmapped.color, format(style.unmapped.opacity, ".17g")):
        ElementTree.SubElement(function, f"{{{OGC_NAMESPACE}}}Literal").text = value
    rule = ElementTree.SubElement(feature_style, f"{{{SLD_NAMESPACE}}}Rule")
    symbolizer = ElementTree.SubElement(rule, f"{{{SLD_NAMESPACE}}}RasterSymbolizer")
    ElementTree.SubElement(symbolizer, f"{{{SLD_NAMESPACE}}}Opacity").text = format(
        opacity, ".17g"
    )
    return ElementTree.tostring(root, encoding="utf-8", xml_declaration=True)
