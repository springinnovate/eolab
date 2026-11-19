"""Build GeoServer color maps for an authorized continuous raster appearance."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal
from xml.etree import ElementTree


_SLD = "{http://www.opengis.net/sld}"
_OGC = "{http://www.opengis.net/ogc}"


@dataclass(frozen=True)
class RasterColorRange:
    """Inclusive sample bounds and their replacement appearance before layer opacity.

    Attributes:
        minimum: Lowest matching sample, or None for no lower bound.
        maximum: Highest matching sample, or None for no upper bound.
            Equal bounds select one exact value.
        color: Six-digit RGB hex color of matching samples.
        opacity: Fraction from transparent (0) through opaque (1).
    """

    minimum: float | None
    maximum: float | None
    color: str
    opacity: float


def _select_raster_samples(
    feature_style: ElementTree.Element, mode: Literal["gradient", "ranges"], bounds: str
) -> None:
    """Select gradient samples or matching range indices from the same sampled coverage.

    Args:
        feature_style: Raster drawing pass that receives the input mask.
        mode: `gradient` passes through unmatched values. `ranges` returns a
            one-based rule index for each match.
        bounds: Ordered pairs of inclusive sample bounds for both passes.
    """
    transformation = ElementTree.Element(_SLD + "Transformation")
    feature_style.insert(0, transformation)
    mask = ElementTree.SubElement(
        transformation, _OGC + "Function", name="eolabMaskRasterValue"
    )
    ElementTree.SubElement(mask, _OGC + "Literal").text = mode
    ElementTree.SubElement(mask, _OGC + "Literal").text = bounds


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
    overrides: Sequence[RasterColorRange],
    opacity: float,
) -> bytes:
    """Draw a continuous gradient with optional inclusive color and opacity overrides.

    Args:
        layer_name: Current workspace-qualified GeoServer raster layer.
        assignments: Authorized quantity, color and opacity for every gradient
            stop.
        overrides: Color rules in first-match order, with any exact value first.
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
            "opacity": assignments[f"a{stop}"],
            "label": stop,
        }
        for stop in ("min", "med", "max")
    ]
    gradient = _append_color_map(user_style, "ramp", opacity, stops)
    if overrides:
        bounds = "|".join(
            ",".join("" if bound is None else str(bound) for bound in (rule.minimum, rule.maximum))
            for rule in overrides
        )
        _select_raster_samples(gradient, "gradient", bounds)
        entries = [
            {"quantity": str(index), "color": rule.color, "opacity": str(rule.opacity)}
            for index, rule in enumerate(overrides, start=1)
            if rule.opacity > 0
        ]
        if entries:
            replacements = _append_color_map(user_style, "values", opacity, entries)
            _select_raster_samples(replacements, "ranges", bounds)
    return ElementTree.tostring(root, encoding="utf-8", xml_declaration=True)
