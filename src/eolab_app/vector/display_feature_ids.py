"""Translate selected native records into compact GeoServer feature-ID intervals."""

import struct

from eolab_app.catalog_selection import ResolvedCatalogSelection, SelectionUnavailableError


def display_feature_ranges(layer: ResolvedCatalogSelection) -> dict[str, str]:
    """Encode each spatial clause as ordered, inclusive GeoServer feature-ID intervals.

    GeoPackages use the integer primary key. Shapefiles use a one-based record
    number unless GeoTools has a feature-ID index mapping records to persistent IDs.

    Args:
        layer: Authorized original with computed matches for each polygon view.

    Returns:
        Per-view interval text for the server-generated WMS filter and SLD.

    Raises:
        SelectionUnavailableError: If the Shapefile index cannot identify a selected record.
    """
    indexed = None
    if layer.driver == "ESRI Shapefile":
        sidecar = layer.path.with_suffix(".fix")
        if sidecar.exists():
            if sidecar.resolve().parent != layer.path.parent.resolve():
                raise SelectionUnavailableError("The Shapefile feature index is outside its source directory.")
            try:
                with sidecar.open("rb") as index:
                    version, count, _ = struct.unpack(">Bqi", index.read(13))
                    if version != 1:
                        raise ValueError("Unknown feature index version")
                    indexed = {}
                    for _ in range(count):
                        fid, record = struct.unpack(">qi", index.read(12))
                        indexed[record] = fid
            except (OSError, ValueError, struct.error) as error:
                raise SelectionUnavailableError("The Shapefile feature index could not be read.") from error
    encoded = {}
    for key, native in layer.intersections.items():
        ids = native
        if layer.driver == "ESRI Shapefile":
            try:
                ids = {indexed[index] if indexed is not None else index + 1 for index in native}
            except KeyError as error:
                raise SelectionUnavailableError("A selected Shapefile record has no display ID.") from error
        ranges = []
        first = last = None
        for value in sorted(ids):
            if last is None or value != last + 1:
                if first is not None:
                    ranges.append(str(first) if first == last else f"{first}:{last}")
                first = value
            last = value
        if first is not None:
            ranges.append(str(first) if first == last else f"{first}:{last}")
        encoded[key] = ",".join(ranges)
    return encoded
