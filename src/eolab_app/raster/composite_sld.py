"""Build GeoServer color maps for an authorized continuous raster appearance."""

from collections.abc import Mapping, Sequence
from xml.etree import ElementTree


_SLD = "{http://www.opengis.net/sld}"
_OGC = "{http://www.opengis.net/ogc}"


def _append_color_map(
    user_style: ElementTree.Element,
    map_type: str,
    opacity: float,
    entries: Sequence[dict[str, str]],
) -> ElementTree.Element:
    """Add one raster drawing pass to a GeoServer style.

    Args:
        user_style: SLD UserStyle that receives the pass in drawing order.
        map_type: Either a continuous `ramp` or exact `values` lookup.
        opacity: Opacity of the entire pass, from zero through one.
        entries: Ordered ColorMapEntry attributes for its numeric samples.

    Returns:
        The FeatureTypeStyle that owns the color map and its optional input mask.
    """
    feature_style = ElementTree.SubElement(user_style, _SLD + "FeatureTypeStyle")
    rule = ElementTree.SubElement(feature_style, _SLD + "Rule")
    symbolizer = ElementTree.SubElement(rule, _SLD + "RasterSymbolizer")
    ElementTree.SubElement(symbolizer, _SLD + "Opacity").text = format(opacity, ".15g")
    color_map = ElementTree.SubElement(symbolizer, _SLD + "ColorMap", type=map_type)
    for entry in entries:
        ElementTree.SubElement(color_map, _SLD + "ColorMapEntry", entry)
    return feature_style


def build_raster_composite_sld(
    layer_name: str,
    assignments: Mapping[str, str],
    opacity: float,
) -> bytes:
    """Draw the ordinary gradient and replace the color of one optional exact value.

    Args:
        layer_name: Current workspace-qualified GeoServer raster layer.
        assignments: Authorized gradient stops and optional value, color and opacity.
        opacity: Whole-layer opacity from zero through one.

    Returns:
        Single-layer SLD for direct or combined rendering with normal raster sampling.
    """
    root = ElementTree.Element(_SLD + "StyledLayerDescriptor", version="1.0.0")
    layer = ElementTree.SubElement(root, _SLD + "NamedLayer")
    ElementTree.SubElement(layer, _SLD + "Name").text = layer_name
    user_style = ElementTree.SubElement(layer, _SLD + "UserStyle")
    stops = [
        {
            "quantity": assignments[stop],
            "color": assignments[f"c{stop}"],
            "opacity": assignments.get(f"a{stop}", "1"),
            "label": stop,
        }
        for stop in ("min", "med", "max")
    ]
    gradient = _append_color_map(user_style, "ramp", opacity, stops)
    if "vexact" in assignments:
        quantity = str(float(assignments["vexact"]))
        transformation = ElementTree.Element(_SLD + "Transformation")
        gradient.insert(0, transformation)
        mask = ElementTree.SubElement(transformation, _OGC + "Function", name="eolabMaskRasterValue")
        ElementTree.SubElement(mask, _OGC + "Literal").text = quantity
        alpha = float(assignments["aexact"])
        if alpha > 0:
            replacement = {"quantity": quantity, "color": assignments["cexact"], "opacity": str(alpha)}
            _append_color_map(user_style, "values", opacity, [replacement])
    return ElementTree.tostring(root, encoding="utf-8", xml_declaration=True)
