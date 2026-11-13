"""Measure filtered vector bounds without retaining display geometry."""

import math
from time import monotonic
from typing import Any

import fiona
from fiona.model import to_dict
from rasterio.errors import RasterioError
from rasterio.warp import transform_bounds

from eolab_app.attribute_filter import matches_filter, validate_filter, ogr_predicate
from eolab_app.vector.models import VectorLayer
from eolab_app.vector.filters import VectorFilter
from eolab_app.bounded_geometry import (
    GeometryValidationError,
    _iter_geometry_coordinates,
)
from eolab_app.bounded_vector import VectorReadLimits, _source_collection
from eolab_app.catalog_selection import (
    ResolvedCatalogSelection,
    SelectionUnavailableError,
)


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
        with _source_collection(resolved) as dataset:
            return _read_dataset_extent(
                dataset, resolved.selection.filter, resolved.where, limits, deadline
            )


def read_layer_extent(layer: VectorLayer, candidate: VectorFilter) -> dict[str, Any]:
    """Measure an authorized result layer using the ordinary interactive extent budget.

    Args:
        layer: Source-owner-authorized GeoPackage and field metadata.
        candidate: Attribute filter checked against that layer's fields.

    Returns:
        Exact matching count and WGS84 envelopes without retaining geometry.

    Raises:
        GeometryValidationError: If source geometry or the read budget is invalid.
        SelectionUnavailableError: If a native projection cannot be read.
        OSError: If the original source cannot be opened.
    """
    limits = VectorReadLimits()
    deadline = monotonic() + limits.seconds
    with fiona.Env(OGR_CT_FORCE_TRADITIONAL_GIS_ORDER="YES"):
        with fiona.open(
            layer.source.source_path,
            layer=layer.source.layer_name,
            enabled_drivers=["GPKG"],
        ) as dataset:
            return _read_dataset_extent(
                dataset, candidate, ogr_predicate(candidate), limits, deadline
            )


def _read_dataset_extent(
    dataset: fiona.Collection,
    candidate: VectorFilter,
    where: str | None,
    limits: VectorReadLimits,
    deadline: float,
) -> dict[str, Any]:
    """Measure filtered feature envelopes from an already authorized open dataset.

    Args:
        dataset: Original native layer, kept open by the caller.
        candidate: Exact attribute predicate, applied after driver filtering.
        where: Driver-level candidate predicate or None.
        limits: Ordinary interactive source-reading budgets.
        deadline: Monotonic deadline established before opening the original file.

    Returns:
        Matching count and transformed bounds without source geometry.

    Raises:
        GeometryValidationError: If coordinates or source-reading budgets fail.
        SelectionUnavailableError: If a feature envelope cannot be projected.
        ValueError: If the predicate conflicts with the native field schema.
    """
    matched = 0
    bounds = None
    validate_filter(candidate, dataset.schema.get("properties", {}))
    if not dataset.crs:
        raise GeometryValidationError(
            "The selected vector has no coordinate reference system"
        )
    options = {"where": where} if where else {}
    for count, feature in enumerate(dataset.filter(**options), 1):
        if count > limits.features:
            raise GeometryValidationError(
                f"Vector reading exceeded its {limits.features:,}-feature budget"
            )
        if monotonic() > deadline:
            raise GeometryValidationError(
                "Vector extent reading exceeded its time budget"
            )
        if not matches_filter(candidate, feature.properties):
            continue
        matched += 1
        if feature.geometry is None:
            continue
        raw = to_dict(feature.geometry)
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
