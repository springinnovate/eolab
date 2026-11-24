"""Read authorized native vector layers without narrowing their feature identities."""

from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from datetime import date
import json
from typing import TYPE_CHECKING, Any

from shapely import from_wkb
from shapely.errors import GEOSException
from shapely.geometry import GeometryCollection
from shapely.geometry.base import BaseGeometry

from eolab_app.catalog_selection import (
    ResolvedCatalogSelection,
    SelectionUnavailableError,
)

if TYPE_CHECKING:
    from osgeo import ogr

NativeField = tuple[int, str, int, int]
"""Native field index, name, OGR type and subtype needed for value decoding."""


@contextmanager
def open_native_vector_layer(
    resolved: ResolvedCatalogSelection,
    *,
    ignore_geometry: bool = False,
    include_fields: tuple[str, ...] | None = None,
    where: str | None = None,
    bbox: tuple[float, float, float, float] | None = None,
) -> Iterator["ogr.Layer"]:
    """Keep an authorized original layer open for exact native-ID scans and lookups.

    Args:
        resolved: Source identity and immutable file authorized by its owner.
        ignore_geometry: Omit native geometry unless a bbox filter needs it.
            Callers can leave the borrowed geometry undecoded until a feature matches.
        include_fields: Attribute names to read, or None to retain every field.
        where: Source-owner-compiled candidate predicate, or no native restriction.
        bbox: Candidate envelope in the layer's native CRS, or no spatial restriction.

    Yields:
        Read-only native layer. Features and borrowed geometries must not outlive
        this context. Callers own exact filtering, budgets, projection and cancellation.

    Raises:
        SelectionUnavailableError: If opening or configuring the exact layer fails.
    """
    from osgeo import gdal, ogr

    with gdal.ExceptionMgr(), ogr.ExceptionMgr(), ExitStack() as sources:
        try:
            dataset = sources.enter_context(
                gdal.OpenEx(
                    str(resolved.path),
                    gdal.OF_VECTOR | gdal.OF_READONLY,
                    allowed_drivers=[resolved.driver],
                )
            )
            layer = dataset.GetLayerByName(resolved.selection.layerName)
            if layer is None:
                raise SelectionUnavailableError(
                    "The original vector layer is unavailable."
                )
            # A driver's exact bbox test may need native coordinates. They
            # need not be decoded into Python until the feature is selected.
            ignored = ["OGR_GEOMETRY"] if ignore_geometry and bbox is None else []
            if include_fields is not None:
                definition = layer.GetLayerDefn()
                ignored.extend(
                    definition.GetFieldDefn(index).GetName()
                    for index in range(definition.GetFieldCount())
                    if definition.GetFieldDefn(index).GetName() not in include_fields
                )
            if ignored:
                layer.SetIgnoredFields(ignored)
            if where is not None:
                layer.SetAttributeFilter(where)
            if bbox is not None:
                layer.SetSpatialFilterRect(*bbox)
        except (RuntimeError, OSError) as error:
            raise SelectionUnavailableError(
                "The original vector features could not be read."
            ) from error
        yield layer


def iter_native_features(layer: "ogr.Layer") -> Iterator["ogr.Feature"]:
    """Stream native features and translate errors from advancing the source only.

    Args:
        layer: Open authorized layer with candidate filters already configured.

    Yields:
        Native source records, with IDs available through GetFID without narrowing.

    Raises:
        SelectionUnavailableError: If advancing the original source fails.
    """
    try:
        yield from layer
    except (RuntimeError, OSError) as error:
        raise SelectionUnavailableError(
            "The original vector features could not be read."
        ) from error


def get_native_feature(layer: "ogr.Layer", identifier: int) -> "ogr.Feature | None":
    """Read one exact signed-64-bit feature ID without changing scan predicates.

    Args:
        layer: Open authorized original layer for indexed native lookup.
        identifier: Exact native ID selected by the owning consumer.

    Returns:
        Original record, or None when the requested record is absent. Native
        lookups do not apply scan filters; the caller verifies selected membership.

    Raises:
        SelectionUnavailableError: If the native lookup fails.
    """
    try:
        return layer.GetFeature(identifier)
    except (RuntimeError, OSError) as error:
        raise SelectionUnavailableError(
            "The original vector features could not be read."
        ) from error


def native_field_types(layer: "ogr.Layer") -> tuple[NativeField, ...]:
    """Return the nonignored native fields to decode for this open layer.

    Args:
        layer: Original layer after its requested fields have been selected.

    Returns:
        Field indexes, names and native type codes in source order.
    """
    definition = layer.GetLayerDefn()
    return tuple(
        (index, field.GetName(), field.GetType(), field.GetSubType())
        for index in range(definition.GetFieldCount())
        if not (field := definition.GetFieldDefn(index)).IsIgnored()
    )


def native_feature_properties(
    feature: "ogr.Feature", fields: tuple[NativeField, ...]
) -> dict[str, Any]:
    """Decode original field values with the established Fiona scalar semantics.

    Args:
        feature: Native source feature retained while its fields are read.
        fields: Nonignored field definitions captured from the owning layer.

    Returns:
        Native values, with JSON subtypes decoded and dates in ISO text form.
        Ordinary text remains text; binary data remains bytes.

    Raises:
        SelectionUnavailableError: If a native field cannot be read or its JSON decoded.
    """
    from osgeo import ogr

    try:
        properties = {}
        for index, name, field_type, field_subtype in fields:
            if field_type == ogr.OFTBinary:
                # GDAL's generic getter first expands binary fields to hex text.
                properties[name] = (
                    bytes(feature.GetFieldAsBinary(index))
                    if feature.IsFieldSetAndNotNull(index)
                    else None
                )
                continue
            value = feature.GetField(index)
            if value is not None:
                if field_subtype == ogr.OFSTJSON:
                    value = json.loads(value)
                elif field_type == ogr.OFTDate:
                    value = date(*feature.GetFieldAsDateTime(index)[:3]).isoformat()
                elif field_type == ogr.OFTDateTime:
                    value = feature.GetFieldAsISO8601DateTime(index)
            properties[name] = value
        return properties
    except (RuntimeError, OSError, json.JSONDecodeError) as error:
        raise SelectionUnavailableError(
            "The original vector features could not be read."
        ) from error


def native_spatial_geometry(geometry: "ogr.Geometry") -> BaseGeometry:
    """Read an OGR geometry as points, lines or polygons in its native CRS.

    Args:
        geometry: Borrowed feature geometry, possibly a curve, surface or
            collection. Spatial coordinates include elevation when present.

    Returns:
        A Shapely geometry with all parts and holes. Measured ordinates are
        omitted, as the spatial transforms and GeoJSON consumers use XYZ.

    Raises:
        GEOSException: If the normalized native geometry cannot be decoded.
        RuntimeError: If GDAL cannot convert or export the native geometry.
    """
    from osgeo import ogr

    if geometry.IsMeasured():
        geometry = geometry.Clone()
        geometry.SetMeasured(False)
    if geometry.HasCurveGeometry():
        geometry = geometry.GetLinearGeometry()
    kind = geometry.GetGeometryName()
    # These conversions take ownership of their argument.
    if kind == "TRIANGLE":
        geometry = ogr.ForceToPolygon(geometry.Clone())
    elif kind in {"TIN", "POLYHEDRALSURFACE"}:
        geometry = ogr.ForceToMultiPolygon(geometry.Clone())
    try:
        return from_wkb(bytes(geometry.ExportToIsoWkb()))
    except GEOSException:
        if kind != "GEOMETRYCOLLECTION":
            raise
        # Most collections can be decoded in one call. Convert members
        # individually when a collection contains a native surface type.
        return GeometryCollection(
            [
                native_spatial_geometry(geometry.GetGeometryRef(index))
                for index in range(geometry.GetGeometryCount())
            ]
        )
