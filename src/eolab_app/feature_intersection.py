"""Find whole target features that intersect the selected original polygons."""

import sqlite3
from collections.abc import Awaitable, Callable, Generator, Iterable, Iterator, Mapping
from contextlib import ExitStack, closing, contextmanager
from dataclasses import replace
from time import monotonic
from typing import Any

import fiona
from fiona.transform import transform_geom
from pyproj import Transformer
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

from eolab_app.native_vector import (
    get_native_feature,
    iter_native_features,
    native_feature_properties,
    native_field_types,
    native_spatial_geometry,
    open_native_vector_layer,
)

IntersectionLayer = ResolvedCatalogSelection | tuple[SummaryPolygon, ...]
"""An authorized original vector layer or committed WGS84 drawings, in browser order."""

_Envelope = tuple[float, float, float, float]
"""West, south, east and north in the coordinate system of the read."""


def _project_index_envelopes(
    epsg: int | None, envelope: _Envelope
) -> tuple[_Envelope, _Envelope | None] | None:
    """Return a conservative native search envelope for an eligible coordinate system.

    Web Mercator and EPSG:6933 transform longitude and latitude independently
    and monotonically within their unwrapped domains. A feature's native
    envelope therefore contains the inverse envelope of its projected vertices.
    Other projected coordinate systems can have extrema along edges.

    Args:
        epsg: The original layer's EPSG code, if it declares one.
        envelope: WGS84 bounds of the area being tested.

    Returns:
        The native search bounds and, for projected sources, the native domain
        the whole source must fit inside to avoid wrapping. None indicates that
        this envelope cannot safely narrow the original feature read.
    """
    west, south, east, north = envelope
    if not (
        -180 <= west < east <= 180 and -90 <= south < north <= 90 and east - west < 180
    ):
        return None
    if epsg == 4326:
        return envelope, None
    if epsg not in (3857, 6933):
        return None

    projection = Transformer.from_crs(4326, epsg, always_xy=True)
    domain = projection.target_crs.area_of_use.bounds
    if not domain[1] <= south < north <= domain[3]:
        return None
    left, bottom, right, top = projection.transform_bounds(*envelope, errcheck=True)
    # Pad by a centimeter for roundoff when the exact test projects back to WGS84.
    return (
        (left - 0.01, bottom - 0.01, right + 0.01, top + 0.01),
        projection.transform_bounds(*domain, errcheck=True),
    )


@contextmanager
def _indexed_candidates(
    target: ResolvedCatalogSelection, envelope: _Envelope
) -> Iterator[tuple[Iterator[int], int] | None]:
    """Stream overlapping GeoPackage envelope IDs before reading their geometries.

    Args:
        target: Authorized original vector layer held by the requesting owner.
        envelope: WGS84 bounds of the required area.

    Yields:
        Candidate native IDs and the whole-layer count while the source is open.
        None indicates that the layer, projection or index requires the ordinary
        source scan. The IDs are candidates for an exact geometry test.

    Raises:
        SelectionUnavailableError: If the source's spatial index cannot be read.
    """
    if target.driver != "GPKG":
        yield None
        return
    with _source_collection(target) as dataset:
        bounds = _project_index_envelopes(dataset.crs.to_epsg(), envelope)
        if bounds is None:
            yield None
            return
        query, domain = bounds
        try:
            with closing(
                sqlite3.connect(target.path.resolve().as_uri() + "?mode=ro", uri=True)
            ) as index:
                if (
                    index.execute(
                        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='gpkg_extensions'"
                    ).fetchone()
                    is None
                ):
                    yield None
                    return
                row = index.execute(
                    """SELECT schema.name FROM gpkg_extensions AS extension
                    JOIN sqlite_schema AS schema
                      ON schema.name = 'rtree_' || extension.table_name || '_' || extension.column_name
                    WHERE extension.table_name = ? AND extension.extension_name = 'gpkg_rtree_index'
                      AND schema.type = 'table'""",
                    (target.selection.layerName,),
                ).fetchone()
                if row is None:
                    yield None
                    return
                table = '"' + row[0].replace('"', '""') + '"'
                # Each arm can prune the R-tree. Bounds touching the domain edge
                # use the full reader because inverse projection can wrap them.
                if (
                    domain is not None
                    and index.execute(
                        f"""SELECT 1 FROM {table} WHERE minx <= ?
                    UNION ALL SELECT 1 FROM {table} WHERE miny <= ?
                    UNION ALL SELECT 1 FROM {table} WHERE maxx >= ?
                    UNION ALL SELECT 1 FROM {table} WHERE maxy >= ? LIMIT 1""",
                        domain,
                    ).fetchone()
                    is not None
                ):
                    yield None
                    return
                with closing(
                    index.execute(
                        f"SELECT id FROM {table} WHERE maxx >= ? AND maxy >= ? AND minx <= ? AND miny <= ?",
                        query,
                    )
                ) as rows:
                    yield (row[0] for row in rows), len(dataset)
        except sqlite3.Error as error:
            raise SelectionUnavailableError(
                "The GeoPackage spatial index could not be read."
            ) from error


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
    """Evaluate polygon and field conditions against original target features.

    When the required area can use a GeoPackage index, only candidates from the
    original layer reach the same exact WGS84 intersection test.

    Args:
        target: Original vector features or committed drawing polygons in browser order.
        boundaries: Current polygon views keyed by the condition's layer ID.
        predicate: Field and intersection conditions to evaluate together.
        drawing_properties: Name and note for each target drawing, in the same order.
        limits: Interactive read budgets or None for a retained calculation.
        required_area: Optional validated WGS84 area every selected feature must
            intersect, independently of Match all or Match any field conditions.

    Returns:
        Selected native IDs (zero-based positions for drawings) and a feature
        count. Indexed area reads use the native whole-layer count.

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
        with ExitStack() as sources:
            indexed = (
                sources.enter_context(_indexed_candidates(target, required_area.bounds))
                if required_area is not None
                and isinstance(target, ResolvedCatalogSelection)
                else None
            )
            feature_ids, total = indexed if indexed is not None else (None, 0)
            features = sources.enter_context(
                closing(
                    iter_original_features(
                        target, limits, deadline, feature_ids=feature_ids
                    )
                )
            )
            for fid, properties, geometry in features:
                if indexed is None:
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
    layer: IntersectionLayer,
    limits: VectorReadLimits | None,
    deadline: float | None,
    *,
    feature_ids: Iterable[int] | None = None,
    read_geometry: bool = True,
) -> Generator[tuple[int, Mapping[str, Any], BaseGeometry | None], None, None]:
    """Open the target's original point, line or polygon features with their IDs.

    Args:
        layer: Authorized original source or committed editor polygons.
        limits: Interactive feature and coordinate budgets, or None for unlimited work.
        deadline: Monotonic deadline shared with the polygon read, or None.
        feature_ids: Optional native IDs to read directly from a file. The
            layer's exact field and bound spatial filters still apply.
        read_geometry: Whether to decode and project original geometry. False
            reads attributes only, without requiring a CRS or coordinate budget.

    Yields:
        Selected native IDs, properties and optional WGS84 geometry while the
        dataset remains open. JSON-subtype fields retain their decoded values;
        ordinary text remains text. Geometry is None when read_geometry is False.

    Raises:
        GeometryValidationError: If requested geometry has no CRS, or the read
            exceeds its feature, elapsed-time, or applicable coordinate budget.
        SelectionUnavailableError: If the dataset or a requested original feature cannot be read.
    """
    if not isinstance(layer, ResolvedCatalogSelection):
        for index, polygon in enumerate(layer):
            yield index, {}, shape(polygon.model_dump()) if read_geometry else None
        return
    from shapely.geometry import mapping

    with open_native_vector_layer(
        layer,
        ignore_geometry=not read_geometry,
        where=layer.where if feature_ids is None else None,
    ) as original:
        crs = original.GetSpatialRef()
        if read_geometry and crs is None:
            raise GeometryValidationError(
                "The target layer has no coordinate reference system."
            )
        projection = crs.ExportToWkt() if read_geometry else None
        needs_projection = (
            read_geometry and fiona.crs.CRS.from_wkt(projection).to_epsg() != 4326
        )
        fields = native_field_types(original)
        originals = (
            iter_native_features(original)
            if feature_ids is None
            else (get_native_feature(original, fid) for fid in feature_ids)
        )
        for count, feature in enumerate(originals, 1):
            if limits and count > limits.features:
                raise GeometryValidationError(
                    "The intersection exceeded the interactive feature limit."
                )
            if deadline is not None and monotonic() >= deadline:
                raise GeometryValidationError(
                    "The intersection exceeded the interactive read time."
                )
            if feature is None:
                raise SelectionUnavailableError(
                    "A selected feature could not be read from its source."
                )
            fid = feature.GetFID()
            if layer.matches is not None and fid not in layer.matches.ids:
                continue
            properties = native_feature_properties(feature, fields)
            properties.update(
                evaluate_calculated_fields(layer.calculated_fields, properties)
            )
            if layer.matches is None and not matches_filter(
                layer.selection.filter, properties
            ):
                continue
            native_geometry = feature.GetGeometryRef() if read_geometry else None
            geometry = (
                native_spatial_geometry(native_geometry)
                if native_geometry is not None
                else None
            )
            if geometry is None or geometry.is_empty:
                yield fid, properties, None
                continue
            if (
                limits
                and get_num_coordinates(geometry) > limits.coordinates_per_feature
            ):
                raise GeometryValidationError(
                    "A target feature exceeds the interactive coordinate limit."
                )
            if needs_projection:
                geometry = shape(
                    transform_geom(
                        projection,
                        "EPSG:4326",
                        mapping(geometry),
                        antimeridian_cutting=False,
                    )
                )
            yield fid, properties, geometry
