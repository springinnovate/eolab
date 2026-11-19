"""Find whole target features that intersect the selected original polygons."""

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
from eolab_app.bounded_vector import VectorReadLimits, _limit_memory, _source_collection
from eolab_app.execution.bounded_process import ProcessDeadlineError, ProcessResultWriter, run_bounded_process
from eolab_app.calculated_fields import evaluate_calculated_fields
from eolab_app.catalog_selection import ResolvedCatalogSelection
from eolab_app.polygon_areas import SummaryPolygon
from eolab_app.feature_predicate import DrawingSelection, VectorFilter, VectorSelection

IntersectionLayer = ResolvedCatalogSelection | tuple[SummaryPolygon, ...]
"""An authorized original vector layer or committed WGS84 drawings, in browser order."""


async def bind_intersections(
    target: ResolvedCatalogSelection,
    read_layer: Callable[[VectorSelection | DrawingSelection], Awaitable[IntersectionLayer]],
    *, limits: VectorReadLimits | None = VectorReadLimits(),
    compare: Callable[[IntersectionLayer, IntersectionLayer], Awaitable[tuple[int, ...]]] | None = None,
) -> ResolvedCatalogSelection:
    """Evaluate spatial conditions against original files while their owners hold access.

    Args:
        target: Selected vector with the untouched field and spatial conditions.
        read_layer: Open an authorized reference with its own current filter bound.
            The caller keeps the files available until this function returns.
        limits: Interactive reading budgets or None for a retained Processing job.
        compare: Caller-owned scheduler for native comparisons, or an independently supervised process.

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
        ids = await compare(original, polygons) if compare else await read_intersection(original, polygons, limits=limits)
        memberships[str(rule.layerId)] = frozenset(ids)
    return replace(target, intersections=memberships)


async def read_intersection(
    target: IntersectionLayer, polygons: IntersectionLayer, *, limits: VectorReadLimits | None = VectorReadLimits(),
) -> tuple[int, ...]:
    """Compare originals in a cancellable native worker and wait for it to exit.

    Args:
        target: Authorized original features or committed target drawings.
        polygons: Authorized reference polygons with their applied filter.
        limits: Interactive budgets, or None for an unlimited Processing calculation.

    Returns:
        Matching original feature IDs.

    Raises:
        GeometryValidationError: If geometry, native memory or the elapsed-time budget prevents a result.
        asyncio.CancelledError: After a cancelled worker has stopped using its files.
    """
    try:
        ids, error = await run_bounded_process(_compare_originals, (target, polygons, limits), limits.seconds if limits else None)
    except ProcessDeadlineError as error:
        raise GeometryValidationError("The spatial comparison could not finish within the map read budget.") from error
    if error:
        raise GeometryValidationError(error)
    return ids


def _compare_originals(writer: ProcessResultWriter, target: IntersectionLayer, polygons: IntersectionLayer,
                       limits: VectorReadLimits | None) -> None:
    """Return matching IDs or a readable source error through the supervised native worker's pipe.

    Args:
        writer: Parent process waiting for one result.
        target: Authorized target source.
        polygons: Authorized polygon view.
        limits: Interactive budgets, or None for unlimited Processing work.
    """
    from eolab_app.catalog_selection import SelectionUnavailableError
    try:
        with _limit_memory(limits.memory_bytes if limits else None):
            ids = intersecting_feature_ids(target, polygons, limits=limits)
        writer.put((ids, None))
    except (GeometryValidationError, SelectionUnavailableError) as error:
        writer.put(((), str(error)))
    except MemoryError:
        writer.put(((), "The spatial comparison ran out of memory."))


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
        with read_original_features(polygons, limits, deadline) as features:
            selected = []
            for _, polygon in features:
                if polygon.geom_type not in {"Polygon", "MultiPolygon"} or not polygon.is_valid:
                    raise GeometryValidationError("Choose a layer with valid polygon geometry.")
                selected.append(polygon)
        index = STRtree(selected)
        if not len(index):
            return ()
        with read_original_features(target, limits, deadline) as features:
            return tuple(
                feature_id for feature_id, geometry in features
                if index.query(geometry, predicate="intersects").size
            )
    except (fiona.errors.TransformError, GEOSException) as error:
        raise GeometryValidationError("The layer geometries could not be compared in WGS84.") from error


@contextmanager
def read_original_features(
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

        needs_projection = dataset.crs.to_epsg() != 4326

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
                if needs_projection:
                    geometry = shape(transform_geom(dataset.crs, "EPSG:4326", feature.geometry, antimeridian_cutting=False))
                yield int(feature.id), geometry

        yield records()
