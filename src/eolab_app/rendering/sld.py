"""Neutral SLD assembly and WMS GetMap POST serialization."""

from copy import deepcopy
from xml.etree import ElementTree


SLD_NAMESPACE = "http://www.opengis.net/sld"
OWS_NAMESPACE = "http://www.opengis.net/ows"
GML_NAMESPACE = "http://www.opengis.net/gml"
ElementTree.register_namespace("ows", OWS_NAMESPACE)
ElementTree.register_namespace("gml", GML_NAMESPACE)


def combine_sld_layers(layer_documents: list[bytes]) -> bytes:
    """Combine single-layer SLD documents in their supplied drawing order.

    Args:
        layer_documents: Complete feature-owned SLD documents ordered from
            bottommost to topmost.

    Returns:
        One SLD document containing every named layer in drawing order.

    Raises:
        ValueError: If a feature owner returns an invalid SLD boundary value.
    """
    root = ElementTree.Element(
        f"{{{SLD_NAMESPACE}}}StyledLayerDescriptor",
        {"version": "1.0.0"},
    )
    for document in layer_documents:
        candidate = ElementTree.fromstring(document)
        if candidate.tag != f"{{{SLD_NAMESPACE}}}StyledLayerDescriptor":
            raise ValueError("Composite style must be an SLD document")
        named_layers = candidate.findall(f"{{{SLD_NAMESPACE}}}NamedLayer")
        if len(named_layers) != 1:
            raise ValueError("Composite style must contain one named layer")
        root.append(deepcopy(named_layers[0]))
    return ElementTree.tostring(root, encoding="utf-8", xml_declaration=True)


def build_get_map_document(
    sld_document: bytes,
    bbox: tuple[float, float, float, float],
    width: int,
    height: int,
    spatial_reference: str,
) -> bytes:
    """Build one WMS 1.1.1 GetMap XML request with inline authorized SLD.

    Args:
        sld_document: Composite SLD assembled from authorized feature styles.
        bbox: Map extent in minimum-x, minimum-y, maximum-x, maximum-y order.
        width: Requested PNG width in pixels.
        height: Requested PNG height in pixels.
        spatial_reference: Validated EPSG identifier.

    Returns:
        UTF-8 WMS GetMap XML accepted by GeoServer's POST endpoint.
    """
    root = ElementTree.Element(
        f"{{{OWS_NAMESPACE}}}GetMap",
        {"version": "1.1.1", "service": "WMS"},
    )
    root.append(ElementTree.fromstring(sld_document))
    epsg_code = spatial_reference.partition(":")[2]
    bounding_box = ElementTree.SubElement(
        root,
        "BoundingBox",
        {
            "srsName": (
                "http://www.opengis.net/gml/srs/epsg.xml#" + epsg_code
            )
        },
    )
    for x_coordinate, y_coordinate in (
        (bbox[0], bbox[1]),
        (bbox[2], bbox[3]),
    ):
        coordinate = ElementTree.SubElement(
            bounding_box,
            f"{{{GML_NAMESPACE}}}coord",
        )
        ElementTree.SubElement(
            coordinate,
            f"{{{GML_NAMESPACE}}}X",
        ).text = format(x_coordinate, ".17g")
        ElementTree.SubElement(
            coordinate,
            f"{{{GML_NAMESPACE}}}Y",
        ).text = format(y_coordinate, ".17g")
    output = ElementTree.SubElement(root, "Output")
    ElementTree.SubElement(output, "Format").text = "image/png"
    size = ElementTree.SubElement(output, "Size")
    ElementTree.SubElement(size, "Width").text = str(width)
    ElementTree.SubElement(size, "Height").text = str(height)
    ElementTree.SubElement(output, "Transparent").text = "true"
    return ElementTree.tostring(root, encoding="utf-8", xml_declaration=True)
