"""Find whole target features that intersect the selected original polygons."""

from collections.abc import Awaitable, Callable, Generator, Mapping
from contextlib import closing
from dataclasses import replace
from time import monotonic
from typing import Any

import fiona
from fiona.transform import transform_geom
from shapely import STRtree, get_num_coordinates
from shapely.errors import GEOSException
from shapely.geometry import shape
from shapely.geometry.base import BaseGeometry

from eolab_app.bounded_geometry import GeometryValidationError
from eolab_app.bounded_vector import VectorReadLimits, _limit_memory, _source_collection
from eolab_app.execution.bounded_process import ProcessDeadlineError, ProcessResultWriter, run_bounded_process
from eolab_app.calculated_fields import evaluate_calculated_fields
from eolab_app.attribute_filter import matches_filter
from eolab_app.catalog_selection import (
    FeatureMatches,
    ResolvedCatalogSelection,
    SelectionUnavailableError,
    DrawingSelection,
    VectorFilter,
    VectorSelection,
)
from eolab_app.polygon_areas import SummaryPolygon

IntersectionLayer = ResolvedCatalogSelection | tuple[SummaryPolygon, ...]
"""An authorized original vector layer or committed WGS84 drawings, in browser order."""


async def bind_intersections(
    target: ResolvedCatalogSelection,
    read_layer: Callable[[VectorSelection | DrawingSelection], Awaitable[IntersectionLayer]],
    *, limits: VectorReadLimits | None = VectorReadLimits(),
    compare: Callable[[IntersectionLayer, dict[str, IntersectionLayer], VectorFilter], Awaitable[FeatureMatches]] | None = None,
) -> ResolvedCatalogSelection:
    """Evaluate spatial conditions against original files while their owners hold access.

    Args:
        target: Selected vector with the untouched field and spatial conditions.
        read_layer: Open an authorized reference with its own current filter bound.
            The caller keeps the files available until this function returns.
        limits: Interactive reading budgets or None for a retained Processing job.
        compare: Caller-owned scheduler for native comparisons, or an independently supervised process.

    Returns:
        The original target with the final matching IDs and whole-layer count.

    Raises:
        GeometryValidationError: If a native comparison fails or exceeds its budget.
        SelectionUnavailableError: If a referenced view or its authorization is unavailable.
        asyncio.CancelledError: After an in-flight comparison stops using its files.
    """
    conditions = target.selection.filter.intersections
    if not conditions:
        return target
    original = replace(target, where=None, selection=target.selection.model_copy(update={"filter": VectorFilter()}))
    boundaries = {str(rule.layerId): await read_layer(rule.source) for rule in conditions}
    predicate = target.selection.filter
    matches = (await compare(original, boundaries, predicate) if compare
               else await read_intersection(original, boundaries, predicate, limits=limits))
    return replace(target, matches=matches)


async def read_intersection(
    target: IntersectionLayer, boundaries: dict[str, IntersectionLayer], predicate: VectorFilter,
    *, limits: VectorReadLimits | None = VectorReadLimits(),
) -> FeatureMatches:
    """Read filtered features in a cancellable process while the caller holds the original files.

    Args:
        target: Original features with the target filter removed.
        boundaries: Authorized polygon views with their own filters applied.
        predicate: Complete target filter, including field conditions.
        limits: Interactive budgets or None for an unlimited Processing calculation.

    Returns:
        Matching original feature IDs and the total number of target features.

    Raises:
        GeometryValidationError: If the native read fails or exceeds its budget.
    """
    try:
        matches, error = await run_bounded_process(
            _compare_originals, (target, boundaries, predicate, limits), limits.seconds if limits else None,
        )
    except ProcessDeadlineError as error:
        raise GeometryValidationError("The spatial comparison could not finish within the map read budget.") from error
    if error:
        raise GeometryValidationError(error)
    return matches


def _compare_originals(
    writer: ProcessResultWriter, target: IntersectionLayer, boundaries: dict[str, IntersectionLayer],
    predicate: VectorFilter, limits: VectorReadLimits | None,
) -> None:
    """Send the complete selection or its source error back to the supervising reader."""
    try:
        with _limit_memory(limits.memory_bytes if limits else None):
            matches = match_features(target, boundaries, predicate, limits=limits)
        writer.put((matches, None))
    except (GeometryValidationError, SelectionUnavailableError) as error:
        writer.put((None, str(error)))
    except MemoryError:
        writer.put((None, "The spatial comparison ran out of memory."))


def match_features(
    target: IntersectionLayer, boundaries: dict[str, IntersectionLayer], predicate: VectorFilter,
    drawing_properties: tuple[dict[str, str], ...] = (), *, limits: VectorReadLimits | None = VectorReadLimits(),
    required_area: BaseGeometry | None = None,
) -> FeatureMatches:
    """Index each selected polygon view once and evaluate every condition in one pass over the target.

    Args:
        target: Original vector features or committed drawing polygons in browser order.
        boundaries: Current polygon views keyed by the condition's layer ID.
        predicate: Field and intersection conditions to evaluate together.
        drawing_properties: Name and note for each target drawing, in the same order.
        limits: Interactive read budgets or None for a retained calculation.
        required_area: Optional validated WGS84 area every selected feature must
            intersect, independently of Match all or Match any field conditions.

    Returns:
        Selected native feature IDs (zero-based positions for drawings) and total features read.

    Raises:
        GeometryValidationError: If original geometries cannot be compared or a read exceeds its budget.
        SelectionUnavailableError: If an authorized original cannot be read.
    """
    deadline = monotonic() + limits.seconds if limits else None
    indexes = {}
    try:
        for key, layer in boundaries.items():
            polygons = []
            with closing(iter_original_features(layer, limits, deadline)) as features:
                for _, _, geometry in features:
                    if geometry is None:
                        continue
                    if geometry.geom_type not in {"Polygon", "MultiPolygon"} or not geometry.is_valid:
                        raise GeometryValidationError("Choose a layer with valid polygon geometry.")
                    polygons.append(geometry)
            indexes[key] = STRtree(polygons)
        ids = set()
        total = 0
        with closing(iter_original_features(target, limits, deadline)) as features:
            for fid, properties, geometry in features:
                total += 1
                if required_area is not None and (geometry is None or not geometry.intersects(required_area)):
                    continue
                spatial = {key: geometry is not None and index.query(geometry, predicate="intersects").size > 0
                           for key, index in indexes.items()}
                if matches_filter(predicate, drawing_properties[fid] if drawing_properties else properties, spatial):
                    ids.add(fid)
        return FeatureMatches(ids=ids, total=total)
    except (fiona.errors.TransformError, GEOSException) as error:
        raise GeometryValidationError("The layer geometries could not be compared in WGS84.") from error


def iter_original_features(
    layer: IntersectionLayer, limits: VectorReadLimits | None, deadline: float | None,
) -> Generator[tuple[int, Mapping[str, Any], BaseGeometry | None], None, None]:
    """Open the target's original point, line or polygon features with their IDs.

    Args:
        layer: Authorized original source or committed editor polygons.
        limits: Interactive feature and coordinate budgets, or None for unlimited work.
        deadline: Monotonic deadline shared with the polygon read, or None.

    Yields:
        Selected native IDs, properties and optional WGS84 geometry while the dataset remains open.

    Raises:
        GeometryValidationError: If the source has no CRS or exceeds a read budget.
        SelectionUnavailableError: If the native dataset cannot be opened.
    """
    if not isinstance(layer, ResolvedCatalogSelection):
        for index, polygon in enumerate(layer):
            yield index, {}, shape(polygon.model_dump())
        return
    with fiona.Env(OGR_CT_FORCE_TRADITIONAL_GIS_ORDER="YES"), _source_collection(layer) as dataset:
        if not dataset.crs:
            raise GeometryValidationError("The target layer has no coordinate reference system.")

        needs_projection = dataset.crs.to_epsg() != 4326
        options = {"where": layer.where} if layer.where else {}
        for count, feature in enumerate(dataset.filter(**options), 1):
            if limits and count > limits.features:
                raise GeometryValidationError("The intersection exceeded the interactive feature limit.")
            if deadline is not None and monotonic() >= deadline:
                raise GeometryValidationError("The intersection exceeded the interactive read time.")
            fid = int(feature.id)
            if layer.matches is not None and fid not in layer.matches.ids:
                continue
            properties = dict(feature.properties)
            properties.update(evaluate_calculated_fields(layer.calculated_fields, properties))
            if layer.matches is None and not matches_filter(layer.selection.filter, properties):
                continue
            geometry = shape(feature.geometry) if feature.geometry is not None else None
            if geometry is None or geometry.is_empty:
                yield fid, properties, None
                continue
            if limits and get_num_coordinates(geometry) > limits.coordinates_per_feature:
                raise GeometryValidationError("A target feature exceeds the interactive coordinate limit.")
            if needs_projection:
                geometry = shape(transform_geom(dataset.crs, "EPSG:4326", feature.geometry, antimeridian_cutting=False))
            yield fid, properties, geometry
