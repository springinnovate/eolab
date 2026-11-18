"""Find whole target features that intersect the selected original polygons."""

import asyncio
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from dataclasses import replace
from time import monotonic

import fiona
from fiona.transform import transform_geom
from shapely import STRtree, get_num_coordinates
from shapely.errors import GEOSException
from shapely.geometry import shape
from shapely.geometry.base import BaseGeometry

from eolab_app.bounded_geometry import GeometryValidationError
from eolab_app.bounded_vector import VectorReadLimits, _source_collection, polygon_features
from eolab_app.calculated_fields import evaluate_calculated_fields
from eolab_app.catalog_selection import ResolvedCatalogSelection
from eolab_app.polygon_areas import SummaryPolygon
from eolab_app.source_files import finish_source_task
from eolab_app.feature_predicate import DrawingSelection, VectorFilter, VectorSelection

IntersectionLayer = ResolvedCatalogSelection | tuple[SummaryPolygon, ...]
"""An authorized original vector layer or committed WGS84 drawings, in browser order."""


async def bind_intersections(
    target: ResolvedCatalogSelection,
    read_layer: Callable[[VectorSelection | DrawingSelection], Awaitable[IntersectionLayer]],
    *, limits: VectorReadLimits | None = VectorReadLimits(),
) -> ResolvedCatalogSelection:
    """Evaluate spatial conditions against original files while their owners hold access.

    Args:
        target: Selected vector with the untouched field and spatial conditions.
        read_layer: Open an authorized reference with its own current filter bound.
            The caller keeps the files available until this function returns.
        limits: Interactive reading budgets or None for a retained Processing job.

    Returns:
        The original target with membership for each spatial clause. Field comparisons
        and spatial matches are combined when the caller reads a feature.

    Raises:
        GeometryValidationError: If a native comparison fails or exceeds its budget.
        SelectionUnavailableError: If a referenced view or its authorization is unavailable.
        asyncio.CancelledError: After an in-flight comparison stops using its files.
    """
    conditions = target.selection.filter.intersections
    if not conditions:
        return target
    original = replace(target, where=None, selection=target.selection.model_copy(update={"filter": VectorFilter()}))
    memberships = {}
    for rule in conditions:
        polygons = await read_layer(rule.source)
        read = asyncio.create_task(asyncio.to_thread(intersecting_feature_ids, original, polygons, limits=limits))
        try:
            memberships[str(rule.layerId)] = frozenset(await asyncio.shield(read))
        finally:
            await finish_source_task(read)
    return replace(target, intersections=memberships)


def intersecting_feature_ids(
    target: IntersectionLayer,
    polygons: IntersectionLayer,
    *,
    limits: VectorReadLimits | None = VectorReadLimits(),
) -> tuple[int, ...]:
    """Return each original target ID once if any selected polygon touches it.

    Both layers use their applied predicates. The comparison uses full geometries
    in WGS84, including holes and multipart polygons. The spatial index lasts
    for one comparison. Drawings use their position in the supplied tuple as ID.

    Args:
        target: Original features or committed drawings to filter.
        polygons: Selected catalog, uploaded, result or drawn polygons.
        limits: Interactive read budgets, or None for supervised unlimited work.

    Returns:
        Matching target IDs in native read order, including an empty result.

    Raises:
        GeometryValidationError: If geometries cannot be compared or a read exceeds its budget.
        SelectionUnavailableError: If an authorized original source cannot be read.
    """
    deadline = monotonic() + limits.seconds if limits else None
    try:
        if isinstance(polygons, ResolvedCatalogSelection):
            with polygon_features(polygons, limits=limits) as features:
                index = STRtree([shape(feature) for feature in features])
        else:
            index = STRtree([shape(polygon.model_dump()) for polygon in polygons])
        if not len(index):
            return ()
        with _target_features(target, limits, deadline) as features:
            return tuple(
                feature_id for feature_id, geometry in features
                if index.query(geometry, predicate="intersects").size
            )
    except (fiona.errors.TransformError, GEOSException) as error:
        raise GeometryValidationError("The layer geometries could not be compared in WGS84.") from error


@contextmanager
def _target_features(
    layer: IntersectionLayer, limits: VectorReadLimits | None, deadline: float | None,
) -> Iterator[Iterator[tuple[int, BaseGeometry]]]:
    """Open the target's original point, line or polygon features with their IDs.

    Args:
        layer: Authorized original source or committed editor polygons.
        limits: Interactive feature and coordinate budgets, or None for unlimited work.
        deadline: Monotonic deadline shared with the polygon read, or None.

    Yields:
        Selected native IDs and WGS84 geometry while the dataset remains open.

    Raises:
        GeometryValidationError: If the source has no CRS or exceeds a read budget.
        SelectionUnavailableError: If the native dataset cannot be opened.
    """
    if not isinstance(layer, ResolvedCatalogSelection):
        yield ((index, shape(polygon.model_dump())) for index, polygon in enumerate(layer))
        return
    with fiona.Env(OGR_CT_FORCE_TRADITIONAL_GIS_ORDER="YES"), _source_collection(layer) as dataset:
        if not dataset.crs:
            raise GeometryValidationError("The target layer has no coordinate reference system.")

        def records() -> Iterator[tuple[int, BaseGeometry]]:
            """Yield nonempty original features after applying the target view's predicate."""
            options = {"where": layer.where} if layer.where else {}
            for count, feature in enumerate(dataset.filter(**options), 1):
                if limits and count > limits.features:
                    raise GeometryValidationError("The intersection exceeded the interactive feature limit.")
                if deadline is not None and monotonic() >= deadline:
                    raise GeometryValidationError("The intersection exceeded the interactive read time.")
                properties = dict(feature.properties)
                properties.update(evaluate_calculated_fields(layer.calculated_fields, properties))
                if feature.geometry is None or not layer.matches_feature(feature.id, properties):
                    continue
                geometry = shape(feature.geometry)
                if geometry.is_empty:
                    continue
                if limits and get_num_coordinates(geometry) > limits.coordinates_per_feature:
                    raise GeometryValidationError("A target feature exceeds the interactive coordinate limit.")
                if not dataset.crs.is_geographic or dataset.crs.to_epsg() != 4326:
                    geometry = shape(transform_geom(dataset.crs, "EPSG:4326", feature.geometry, antimeridian_cutting=False))
                yield int(feature.id), geometry

        yield records()
