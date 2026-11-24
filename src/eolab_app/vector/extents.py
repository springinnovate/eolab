"""Measure filtered vector bounds without retaining display geometry."""

import math
from contextlib import ExitStack
from pathlib import Path
from time import monotonic
from typing import TYPE_CHECKING, Any

import fiona
from fiona.model import to_dict
from rasterio.errors import RasterioError
from rasterio.warp import transform_bounds
from shapely.geometry import mapping

from eolab_app.attribute_filter import matches_filter, validate_filter, ogr_predicate
from eolab_app.calculated_fields import (
    CalculatedField,
    CompiledCalculatedField,
    evaluate_calculated_fields,
    validate_calculated_fields,
)
from eolab_app.vector.filters import VectorFilter
from eolab_app.bounded_geometry import (
    GeometryValidationError,
    _iter_geometry_coordinates,
)
from eolab_app.bounded_vector import VectorReadLimits, _source_collection
from eolab_app.vector_native import (
    iter_native_features,
    native_spatial_geometry,
    open_native_vector_layer,
)
from eolab_app.catalog_selection import (
    ResolvedCatalogSelection,
    SelectionUnavailableError,
)

if TYPE_CHECKING:
    from osgeo import ogr


def read_selected_extent(
    resolved: ResolvedCatalogSelection, *, limits: VectorReadLimits = VectorReadLimits()
) -> dict[str, Any]:
    """Return matching-feature count and combined projected feature envelopes.

    Read the authorized original layer once, using its exact typed predicate.
    Each native feature envelope is transformed with the same 21-point edge
    densification used for catalog/upload bounds to sample curved projected edges.
    Only one feature is retained at a time; no outline or geometry snapshot is
    returned. Null or empty geometries count as matches but add no coordinates.
    The worker supervisor interrupts blocked native calls and abandoned reads.

    Args:
        resolved: Authorized immutable source, native layer and compiled predicate.
        limits: Existing interactive vector time, feature and coordinate budgets.

    Returns:
        Matched count and combined WGS84 feature envelopes, or null when no
        coordinates matched. Antimeridian crossings use the full longitude range.

    Raises:
        GeometryValidationError: Missing CRS, invalid coordinates or exhausted budget.
        SelectionUnavailableError: A native source or projection cannot be read.
        ValueError: The source predicate no longer matches its admitted fields.
    """
    deadline = monotonic() + limits.seconds
    with fiona.Env(OGR_CT_FORCE_TRADITIONAL_GIS_ORDER="YES"):
        with ExitStack() as sources:
            dataset = sources.enter_context(_source_collection(resolved))
            native = (
                sources.enter_context(
                    open_native_vector_layer(
                        resolved,
                        where=resolved.where,
                    )
                )
                if resolved.matches is not None
                else None
            )
            return _read_dataset_extent(
                dataset,
                resolved.selection.filter,
                resolved.where,
                limits,
                deadline,
                resolved.calculated_fields,
                resolved.matches.ids if resolved.matches is not None else None,
                native_layer=native,
            )


def read_file_extent(
    path: Path,
    candidate: VectorFilter,
    calculated_fields: tuple[CalculatedField, ...] = (),
) -> dict[str, Any]:
    """Measure an authorized result layer using the ordinary interactive extent budget.

    Args:
        path: Authorized single-layer GeoPackage retained by the source owner.
        candidate: Attribute filter to validate against the original field schema.
        calculated_fields: View definitions to bind to the original native schema.

    Returns:
        Exact matching count and WGS84 envelopes without retaining geometry.

    Raises:
        GeometryValidationError: If source geometry or the read budget is invalid.
        SelectionUnavailableError: If a native projection cannot be read.
        OSError: If the original source cannot be opened.
        ValueError: If the file contains more than one layer or fields do not match.
    """
    limits = VectorReadLimits()
    deadline = monotonic() + limits.seconds
    with fiona.Env(OGR_CT_FORCE_TRADITIONAL_GIS_ORDER="YES"):
        (layer_name,) = fiona.listlayers(path)
        with fiona.open(
            path,
            layer=layer_name,
            enabled_drivers=["GPKG"],
        ) as dataset:
            compiled = validate_calculated_fields(
                calculated_fields, dataset.schema["properties"]
            )
            return _read_dataset_extent(
                dataset,
                candidate,
                ogr_predicate(
                    candidate, frozenset(field.definition.name for field in compiled)
                ),
                limits,
                deadline,
                compiled,
            )


def _read_dataset_extent(
    dataset: fiona.Collection,
    candidate: VectorFilter,
    where: str | None,
    limits: VectorReadLimits,
    deadline: float,
    calculated_fields: tuple[CompiledCalculatedField, ...] = (),
    matched_ids: frozenset[int] | None = None,
    *,
    native_layer: "ogr.Layer | None" = None,
) -> dict[str, Any]:
    """Measure filtered feature envelopes from an already authorized open dataset.

    Args:
        dataset: Original native layer, kept open by the caller.
        candidate: Exact attribute predicate, applied after driver filtering.
        where: Driver-level candidate predicate or None.
        limits: Ordinary interactive source-reading budgets.
        deadline: Monotonic deadline established before opening the original file.
        calculated_fields: Programs already validated against the original schema.
        matched_ids: Original IDs selected by the complete spatial filter, if present.
        native_layer: Exact-ID geometry scan when matched_ids is supplied; otherwise None.

    Returns:
        Matching count and transformed bounds without source geometry.

    Raises:
        GeometryValidationError: If coordinates or source-reading budgets fail.
        SelectionUnavailableError: If a feature envelope cannot be projected.
        ValueError: If the predicate conflicts with the native field schema.
    """
    matched = 0
    bounds = None
    validate_filter(
        candidate,
        {
            **dataset.schema["properties"],
            **{field.definition.name: "float" for field in calculated_fields},
        },
    )
    if not dataset.crs:
        raise GeometryValidationError(
            "The selected vector has no coordinate reference system"
        )
    options = {"where": where} if where else {}
    features = (
        iter_native_features(native_layer)
        if native_layer is not None
        else dataset.filter(**options)
    )
    for count, feature in enumerate(features, 1):
        if count > limits.features:
            raise GeometryValidationError(
                f"Vector reading exceeded its {limits.features:,}-feature budget"
            )
        if monotonic() > deadline:
            raise GeometryValidationError(
                "Vector extent reading exceeded its time budget"
            )
        if native_layer is not None:
            if feature.GetFID() not in matched_ids:
                continue
            geometry = feature.GetGeometryRef()
        else:
            properties = dict(feature.properties)
            properties.update(evaluate_calculated_fields(calculated_fields, properties))
            if not matches_filter(candidate, properties):
                continue
            geometry = feature.geometry
        matched += 1
        if geometry is None:
            continue
        raw = (
            mapping(native_spatial_geometry(geometry))
            if native_layer is not None
            else to_dict(geometry)
        )
        native_bounds = None
        for positions, (x, y) in enumerate(
            _iter_geometry_coordinates(raw, validate_wgs84_bounds=False), 1
        ):
            if positions > limits.coordinates_per_feature:
                raise GeometryValidationError(
                    "A source feature exceeds the bounded coordinate buffer"
                )
            native_bounds = (
                [x, y, x, y]
                if native_bounds is None
                else [
                    min(native_bounds[0], x),
                    min(native_bounds[1], y),
                    max(native_bounds[2], x),
                    max(native_bounds[3], y),
                ]
            )
        if native_bounds is None:
            continue
        try:
            west, south, east, north = transform_bounds(
                dataset.crs_wkt, "EPSG:4326", *native_bounds
            )
        except (RasterioError, ValueError) as error:
            raise SelectionUnavailableError(
                "The selected vector bounds could not be projected."
            ) from error
        if not all(math.isfinite(value) for value in (west, south, east, north)):
            raise GeometryValidationError(
                "The selected vector bounds could not be projected."
            )
        if west > east:
            west, east = -180.0, 180.0
        bounds = (
            [west, south, east, north]
            if bounds is None
            else [
                min(bounds[0], west),
                min(bounds[1], south),
                max(bounds[2], east),
                max(bounds[3], north),
            ]
        )
        if monotonic() > deadline:
            raise GeometryValidationError(
                "Vector extent reading exceeded its time budget"
            )
    return {"matched": matched, "bbox": bounds}
