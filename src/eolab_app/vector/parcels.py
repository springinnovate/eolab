"""Validate, find and page original parcel identities without loading geometry."""

from collections.abc import Callable, Mapping
from concurrent.futures import CancelledError
from threading import Event
from time import monotonic
from typing import Any

from eolab_app.attribute_filter import matches_filter
from eolab_app.bounded_geometry import GeometryValidationError
from eolab_app.bounded_vector import VectorReadLimits
from eolab_app.catalog_selection import (
    ResolvedCatalogSelection,
    SelectionUnavailableError,
)
from eolab_app.vector.parcel_models import (
    ParcelId,
    ParcelIdType,
    ParcelIdValidation,
    ParcelRow,
    ParcelRowsPage,
)
from eolab_app.vector_fields import visit_vector_fields


def _validate_parcel_schema(
    resolved: ResolvedCatalogSelection, id_field: str, fields: tuple[str, ...]
) -> ParcelIdType:
    """Check polygon and original scalar field types without reading any feature.

    Args:
        resolved: Authorized original source and layer.
        id_field: Original string or integer field identifying each parcel.
        fields: Original scalar attributes requested for display.

    Returns:
        The original ID field's integer or string kind.

    Raises:
        GeometryValidationError: Geometry or requested fields are unsupported.
        SelectionUnavailableError: The authorized native source cannot be opened.
    """
    from osgeo import gdal, ogr

    try:
        with gdal.ExceptionMgr(), ogr.ExceptionMgr():
            with gdal.OpenEx(
                str(resolved.path), gdal.OF_VECTOR | gdal.OF_READONLY
            ) as dataset:
                layer = dataset.GetLayerByName(resolved.selection.layerName)
                if layer is None:
                    raise SelectionUnavailableError(
                        "The exact parcel source layer is missing"
                    )
                definition = layer.GetLayerDefn()
                if ogr.GT_Flatten(definition.GetGeomType()) not in {
                    ogr.wkbPolygon,
                    ogr.wkbMultiPolygon,
                }:
                    raise GeometryValidationError(
                        "Choose a Polygon or MultiPolygon parcel layer"
                    )
                original = {
                    definition.GetFieldDefn(index).GetName(): (
                        definition.GetFieldDefn(index).GetType(),
                        definition.GetFieldDefn(index).GetSubType(),
                    )
                    for index in range(definition.GetFieldCount())
                }
                if id_field not in original:
                    raise GeometryValidationError(
                        "Choose an original parcel ID field in this layer"
                    )
                field_type, subtype = original[id_field]
                if field_type == ogr.OFTString:
                    id_type: ParcelIdType = "string"
                elif (
                    field_type in {ogr.OFTInteger, ogr.OFTInteger64}
                    and subtype != ogr.OFSTBoolean
                ):
                    id_type = "integer"
                else:
                    raise GeometryValidationError(
                        "Parcel IDs require an original integer or string field"
                    )
                scalar_types = {
                    ogr.OFTInteger,
                    ogr.OFTInteger64,
                    ogr.OFTReal,
                    ogr.OFTString,
                    ogr.OFTDate,
                    ogr.OFTTime,
                    ogr.OFTDateTime,
                }
                for field in fields:
                    if field not in original or original[field][0] not in scalar_types:
                        raise GeometryValidationError(
                            "Display fields must be original scalar attributes in this layer"
                        )
                return id_type
    except (RuntimeError, OSError) as error:
        raise SelectionUnavailableError(
            "The parcel source could not be read safely"
        ) from error


def _encode_parcel_id(value: Any, id_type: ParcelIdType) -> ParcelId:
    """Convert a native original ID to exact wire text, rejecting invalid values.

    Args:
        value: Scalar from the original ID column.
        id_type: Authoritative native schema kind.

    Returns:
        A typed ID preserving int64 precision and original string spelling.

    Raises:
        GeometryValidationError: A row has a null, blank or incompatible ID.
    """
    valid = (
        type(value) is int
        if id_type == "integer"
        else isinstance(value, str) and bool(value.strip())
    )
    if not valid:
        raise GeometryValidationError(
            "Every parcel must have a nonempty original integer or string ID"
        )
    return ParcelId(type=id_type, value=str(value))


def _visit_parcel_attributes(
    resolved: ResolvedCatalogSelection,
    fields: tuple[str, ...],
    visit: Callable[[Mapping[str, Any]], None],
    stop: Event,
    limits: VectorReadLimits | None,
    cancellation_requested: Callable[[], bool] | None,
    *,
    filtered: bool,
    deadline: float | None,
    original_where: str | None = None,
) -> bool:
    """Read original attributes under a job's time, work and cancellation budgets.

    Args:
        resolved: Authorized source and optional exact selection.
        fields: Original or compiled attributes needed by the caller.
        visit: Callback accepting each native candidate row.
        stop: Set by the caller once the requested result has been found.
        limits: Interactive read limits, or None for externally supervised work.
        cancellation_requested: Optional cooperative cancellation check.
        filtered: Whether to apply the source's candidate filter and calculations.
        deadline: Absolute monotonic deadline, including schema-reading time.
        original_where: Native candidate predicate for an unfiltered original-layer
            lookup; the caller must compare candidate attributes exactly.

    Returns:
        Whether every candidate was consumed without the caller stopping the read.

    Raises:
        GeometryValidationError: The read exceeded its time or candidate budget.
        SelectionUnavailableError: The native attribute source could not be read.
        CancelledError: The caller abandoned the read.
    """

    def check_read() -> None:
        """Raise when cancellation or the elapsed read budget requires stopping.

        Raises:
            CancelledError: The caller abandoned the read.
            GeometryValidationError: The elapsed read budget was exceeded.
        """
        if cancellation_requested is not None and cancellation_requested():
            raise CancelledError("Parcel reading was canceled")
        if deadline is not None and monotonic() > deadline:
            raise GeometryValidationError("Parcel reading exceeded its time budget")

    def receive(properties: Mapping[str, Any]) -> None:
        """Check work lifetime before handing one native row to the accumulator.

        Args:
            properties: Original attributes and any requested calculated values.

        Raises:
            CancelledError: The caller abandoned the read.
            GeometryValidationError: The read or accumulator rejected the row.
        """
        check_read()
        visit(properties)

    check_read()
    try:
        complete = visit_vector_fields(
            str(resolved.path),
            resolved.selection.layerName,
            fields,
            limits.features if limits else None,
            stop,
            receive,
            calculated_fields=resolved.calculated_fields if filtered else (),
            where=resolved.where if filtered else original_where,
        )
    except (RuntimeError, OSError, UnicodeDecodeError) as error:
        raise SelectionUnavailableError(
            "The parcel attributes could not be read safely"
        ) from error
    check_read()
    if not complete and not stop.is_set():
        raise GeometryValidationError(
            "Parcel reading exceeded its candidate-feature budget"
        )
    return complete


def validate_parcel_ids(
    resolved: ResolvedCatalogSelection,
    id_field: str,
    *,
    limits: VectorReadLimits | None = VectorReadLimits(),
    cancellation_requested: Callable[[], bool] | None = None,
) -> ParcelIdValidation:
    """Validate one original ID field across every feature in the complete layer.

    The selection's filter and calculated fields are deliberately ignored so later
    filter expansion cannot introduce duplicate or empty parcel identities.

    Args:
        resolved: Authorized immutable Catalog source and native layer.
        id_field: Original string or integer field to validate.
        limits: Interactive scan limits, or None for externally supervised work.
        cancellation_requested: Optional cooperative cancellation callback.

    Returns:
        ID field, type and exact whole-layer feature count after complete validation.

    Raises:
        GeometryValidationError: IDs or schema are invalid, or a read budget expires.
        SelectionUnavailableError: The original native source cannot be read.
        CancelledError: The caller abandoned the read.
    """
    deadline = monotonic() + limits.seconds if limits else None
    if cancellation_requested is not None and cancellation_requested():
        raise CancelledError("Parcel reading was canceled")
    id_type = _validate_parcel_schema(resolved, id_field, ())
    seen: set[str] = set()

    def validate(properties: Mapping[str, Any]) -> None:
        """Reject invalid or repeated IDs while counting every original feature.

        Args:
            properties: The original ID column from one native row.

        Raises:
            GeometryValidationError: The ID is invalid or already appeared.
        """
        parcel_id = _encode_parcel_id(properties[id_field], id_type)
        if parcel_id.value in seen:
            raise GeometryValidationError(
                "Parcel IDs must be unique across the entire original layer"
            )
        seen.add(parcel_id.value)

    _visit_parcel_attributes(
        resolved,
        (id_field,),
        validate,
        Event(),
        limits,
        cancellation_requested,
        filtered=False,
        deadline=deadline,
    )
    return ParcelIdValidation(idField=id_field, idType=id_type, featureCount=len(seen))


def lookup_parcel(
    resolved: ResolvedCatalogSelection,
    id_field: str,
    parcel_id: ParcelId,
    *,
    limits: VectorReadLimits | None = VectorReadLimits(),
    cancellation_requested: Callable[[], bool] | None = None,
) -> bool:
    """Find one exact typed ID in the original layer without revalidating uniqueness.

    Ignore selection filters and calculated fields. Native equality narrows candidates
    using an existing source index when available; exact comparison preserves string
    case and int64 identity despite driver-specific comparison rules.

    Args:
        resolved: Authorized immutable Catalog source and native layer.
        id_field: Original ID field already validated for whole-layer uniqueness.
        parcel_id: Requested integer decimal text or original string identity.
        limits: Interactive read limits, or None for externally supervised work.
        cancellation_requested: Optional cooperative cancellation callback.

    Returns:
        Whether the original layer contains that exact typed ID. A mismatched type
        or integer outside the native int64 range is absent.

    Raises:
        GeometryValidationError: Schema or a candidate ID is invalid, or a budget expires.
        SelectionUnavailableError: The original native source cannot be read.
        CancelledError: The caller abandoned the read.
    """
    deadline = monotonic() + limits.seconds if limits else None
    if cancellation_requested is not None and cancellation_requested():
        raise CancelledError("Parcel reading was canceled")
    id_type = _validate_parcel_schema(resolved, id_field, ())
    if parcel_id.type != id_type:
        return False
    if id_type == "integer":
        if not -(2**63) <= int(parcel_id.value) < 2**63:
            return False
        literal = parcel_id.value
    else:
        literal = "'" + parcel_id.value.replace("'", "''") + "'"
    identifier = '"' + id_field.replace('"', '""') + '"'
    found = False
    stop = Event()

    def receive(properties: Mapping[str, Any]) -> None:
        """Stop after finding the exact typed ID among native equality candidates.

        Args:
            properties: The original ID attribute from one candidate row.

        Raises:
            GeometryValidationError: A candidate has an invalid original ID.
        """
        nonlocal found
        if _encode_parcel_id(properties[id_field], id_type) == parcel_id:
            found = True
            stop.set()

    _visit_parcel_attributes(
        resolved,
        (id_field,),
        receive,
        stop,
        limits,
        cancellation_requested,
        filtered=False,
        deadline=deadline,
        original_where=f"{identifier} = {literal}",
    )
    return found


def read_parcel_rows(
    resolved: ResolvedCatalogSelection,
    id_field: str,
    fields: tuple[str, ...],
    offset: int,
    limit: int,
    *,
    limits: VectorReadLimits | None = VectorReadLimits(),
    cancellation_requested: Callable[[], bool] | None = None,
) -> ParcelRowsPage:
    """Page exact selected parcel attributes in original native order.

    Offset counts matching rows, not source candidates. One extra matching row
    establishes nextOffset. No geometry is decoded and no row is deduplicated.

    Args:
        resolved: Authorized Catalog source and compiled exact selection.
        id_field: Original field previously chosen for parcel identity.
        fields: Original scalar attributes returned as display text or null.
        offset: Validated nonnegative number of exact matches to skip.
        limit: Validated number of returned rows, from 1 through 500.
        limits: Interactive scan limits, or None for externally supervised work.
        cancellation_requested: Optional cooperative cancellation callback.

    Returns:
        Typed IDs, display attributes, and a next offset only when another match exists.

    Raises:
        GeometryValidationError: Schema, ID or field is invalid, or a budget expires.
        SelectionUnavailableError: The original native source cannot be read.
        CancelledError: The caller abandoned the read.
    """
    deadline = monotonic() + limits.seconds if limits else None
    if cancellation_requested is not None and cancellation_requested():
        raise CancelledError("Parcel reading was canceled")
    id_type = _validate_parcel_schema(resolved, id_field, fields)
    requested = tuple(
        dict.fromkeys(
            (
                id_field,
                *fields,
                *resolved.selection.filter.fields,
            )
        )
    )
    rows: list[ParcelRow] = []
    matched = 0
    stop = Event()

    def receive(properties: Mapping[str, Any]) -> None:
        """Keep exact matches and stop only after finding the next page's first row.

        Args:
            properties: Original and calculated values needed by the selection.

        Raises:
            GeometryValidationError: A selected feature has an invalid ID.
        """
        nonlocal matched
        if not resolved.matches_feature(feature.id, properties):
            return
        parcel_id = _encode_parcel_id(properties[id_field], id_type)
        matched += 1
        if matched <= offset:
            return
        if len(rows) == limit:
            stop.set()
            return
        rows.append(
            ParcelRow(
                id=parcel_id,
                properties={
                    field: None if properties[field] is None else str(properties[field])
                    for field in fields
                },
            )
        )

    _visit_parcel_attributes(
        resolved,
        requested,
        receive,
        stop,
        limits,
        cancellation_requested,
        filtered=True,
        deadline=deadline,
    )
    return ParcelRowsPage(
        rows=tuple(rows),
        offset=offset,
        nextOffset=offset + len(rows) if stop.is_set() else None,
    )
