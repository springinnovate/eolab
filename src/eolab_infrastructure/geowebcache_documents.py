"""Pure XML documents shared by GeoServer publishers and deployment setup."""

from xml.etree import ElementTree


GEOWEBCACHE_GRIDSET_NAME = "EPSG:3857"
GEOSERVER_WORKSPACE_NAME = "eolab"


def geowebcache_layer_document(
    resource_name: str,
    *,
    allow_style_environment: bool,
) -> bytes:
    """Build a GeoWebCache layer document for an eolab GeoServer resource.

    Args:
        resource_name: Unqualified GeoServer resource name.
        allow_style_environment: Whether the WMS ``ENV`` parameter participates
            in the cache key. Raster color ramps use this parameter, while
            vector layers do not.

    Returns:
        The UTF-8 XML document accepted by the GeoWebCache layer REST endpoint.
    """
    layer = ElementTree.Element("GeoServerLayer")
    ElementTree.SubElement(layer, "enabled").text = "true"
    ElementTree.SubElement(layer, "name").text = (
        f"{GEOSERVER_WORKSPACE_NAME}:{resource_name}"
    )
    mime_formats = ElementTree.SubElement(layer, "mimeFormats")
    ElementTree.SubElement(mime_formats, "string").text = "image/png"
    grid_subsets = ElementTree.SubElement(layer, "gridSubsets")
    grid_subset = ElementTree.SubElement(grid_subsets, "gridSubset")
    ElementTree.SubElement(grid_subset, "gridSetName").text = (
        GEOWEBCACHE_GRIDSET_NAME
    )
    ElementTree.SubElement(grid_subset, "zoomStart").text = "0"
    ElementTree.SubElement(grid_subset, "zoomStop").text = "24"
    ElementTree.SubElement(layer, "metaWidthHeight").extend(
        (
            ElementTree.Element("int"),
            ElementTree.Element("int"),
        )
    )
    meta = layer.find("metaWidthHeight")
    assert meta is not None
    meta[0].text = "4"
    meta[1].text = "4"
    if allow_style_environment:
        parameter_filters = ElementTree.SubElement(layer, "parameterFilters")
        filter_element = ElementTree.SubElement(
            parameter_filters,
            "regexParameterFilter",
        )
        ElementTree.SubElement(filter_element, "key").text = "ENV"
        ElementTree.SubElement(filter_element, "defaultValue")
        ElementTree.SubElement(filter_element, "regex").text = r"[^\r\n]{1,384}"
    ElementTree.SubElement(layer, "gutter").text = "0"
    ElementTree.SubElement(layer, "autoCacheStyles").text = "true"
    return ElementTree.tostring(
        layer,
        encoding="utf-8",
        xml_declaration=True,
    )
