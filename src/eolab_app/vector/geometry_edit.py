"""Read and revise a single polygon feature without modifying its original source."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
import math
from pathlib import Path
from time import monotonic
from typing import Annotated, TYPE_CHECKING
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pyproj import Transformer
from pyproj.enums import TransformDirection
from pyproj.exceptions import ProjError
from shapely import from_wkb, get_num_coordinates
from shapely.errors import GEOSException
from shapely.geometry import MultiPolygon, Point, Polygon
from shapely.geometry.base import BaseGeometry

from eolab_app.attribute_filter import matches_filter
from eolab_app.bounded_geometry import GeometryValidationError
from eolab_app.bounded_vector import VectorReadLimits, _limit_memory
from eolab_app.calculated_fields import (
    evaluate_calculated_fields,
    required_source_fields,
)
from eolab_app.catalog_selection import (
    CatalogSelection,
    ResolvedCatalogSelection,
    UploadedSelection,
)
from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
    ProcessResultWriter,
    run_bounded_process,
)
from eolab_app.vector_uploads import VectorUploadError

if TYPE_CHECKING:
    from osgeo import ogr

MAX_EDIT_VERTICES = 2000
MAX_PICK_RESULTS = 24
MAP_LATITUDE_LIMIT = 85.05112878

FeatureId = Annotated[str, Field(pattern=r"^-?(0|[1-9][0-9]{0,18})$")]
Longitude = Annotated[float, Field(strict=True, allow_inf_nan=False, ge=-180, le=180)]
Latitude = Annotated[
    float,
    Field(
        strict=True, allow_inf_nan=False, ge=-MAP_LATITUDE_LIMIT, le=MAP_LATITUDE_LIMIT
    ),
]
MapPosition = tuple[Longitude, Latitude]
EditVertex = (
    Annotated[int, Field(strict=True, ge=0, lt=MAX_EDIT_VERTICES)] | MapPosition
)
EditedRing = Annotated[
    list[EditVertex], Field(min_length=3, max_length=MAX_EDIT_VERTICES)
]
EditedPart = Annotated[
    list[EditedRing], Field(min_length=1, max_length=MAX_EDIT_VERTICES // 3)
]
EditSource = CatalogSelection | UploadedSelection
PolygonParts = list[list[list[tuple[float, float]]]]


class ClickedPolygon(BaseModel):
    """An exact map point in longitude and latitude for a filtered polygon hit test."""

    model_config = ConfigDict(extra="forbid")
    point: MapPosition


class ChosenPolygon(BaseModel):
    """A native feature ID, encoded as text to preserve all 64 bits."""

    model_config = ConfigDict(extra="forbid")
    featureId: FeatureId


class ReadPolygonEdit(BaseModel):
    """Read the selected view at a click or reopen one of the returned feature IDs."""

    model_config = ConfigDict(extra="forbid")
    source: EditSource
    target: ClickedPolygon | ChosenPolygon


class SavePolygonEdit(BaseModel):
    """Replace vertices in the existing rings while retaining other native coordinates.

    Parts and rings follow the read order. An integer retains the original vertex
    at that ring index. A longitude and latitude pair inserts or moves a vertex.
    The first coordinate is implicit at ring closure and appears only once.
    """

    model_config = ConfigDict(extra="forbid")
    source: EditSource
    featureId: FeatureId
    saveId: UUID
    name: Annotated[
        str, Field(min_length=1, max_length=160, pattern=r"^[^\x00-\x1f]+$")
    ]
    parts: Annotated[
        list[EditedPart], Field(min_length=1, max_length=MAX_EDIT_VERTICES // 3)
    ]

    @model_validator(mode="after")
    def bound_vertex_count(self) -> "SavePolygonEdit":
        """Limit the complete draft, including all parts and interior rings.

        Returns:
            The bounded draft to validate against the authorized feature.

        Raises:
            ValueError: If the draft is larger than the interactive editor supports.
        """
        if sum(len(ring) for part in self.parts for ring in part) > MAX_EDIT_VERTICES:
            raise ValueError(
                f"A polygon can have up to {MAX_EDIT_VERTICES:,} editable vertices."
            )
        return self


class EditablePolygon(BaseModel):
    """One original polygon's open rings in map coordinates for the vertex editor."""

    featureId: FeatureId
    parts: list[list[list[MapPosition]]]


class PolygonEditRead(BaseModel):
    """Matching feature IDs and exact editable vertices when one feature is chosen."""

    featureIds: list[FeatureId]
    feature: EditablePolygon | None = None


class InvalidEditGeometry(ValueError):
    """Report an unsupported source geometry or a draft the user can correct."""


@dataclass(frozen=True)
class EditFailure:
    """Return a browser-safe failure from the supervised native worker."""

    status: int
    detail: str


def _editable_parts(geometry: BaseGeometry) -> PolygonParts:
    """Return the open native rings of an editable two-dimensional feature.

    Args:
        geometry: Exact original polygon read from the GeoPackage.

    Returns:
        Native points in original part, ring and vertex order.

    Raises:
        InvalidEditGeometry: If the feature is invalid, unsupported or too detailed.
    """
    if (
        geometry.geom_type not in {"Polygon", "MultiPolygon"}
        or geometry.has_z
        or geometry.has_m
    ):
        raise InvalidEditGeometry("Choose a two-dimensional polygon or multipolygon.")
    if geometry.is_empty or not geometry.is_valid:
        raise InvalidEditGeometry(
            "This polygon has invalid source geometry and can’t be edited."
        )
    polygons = geometry.geoms if isinstance(geometry, MultiPolygon) else (geometry,)
    parts = [
        [list(ring.coords)[:-1] for ring in (polygon.exterior, *polygon.interiors)]
        for polygon in polygons
    ]
    if sum(len(ring) for part in parts for ring in part) > MAX_EDIT_VERTICES:
        raise InvalidEditGeometry(
            f"This polygon has more than {MAX_EDIT_VERTICES:,} vertices."
        )
    if any(len(set(ring)) != len(ring) for part in parts for ring in part):
        raise InvalidEditGeometry(
            "This polygon has repeated vertices and can’t be edited."
        )
    return parts


def _map_parts(parts: PolygonParts, projection: Transformer) -> PolygonParts:
    """Project native vertices onto the map and require rings that can be displayed.

    Args:
        parts: Open rings in the source coordinate system.
        projection: Transformation from map to source coordinates, used in reverse.

    Returns:
        The same vertices in longitude and latitude.

    Raises:
        InvalidEditGeometry: If this feature crosses the date line or lies off the map.
        ProjError: If a vertex cannot be projected.
    """
    mapped = [
        [
            [
                projection.transform(
                    *point, direction=TransformDirection.INVERSE, errcheck=True
                )
                for point in ring
            ]
            for ring in part
        ]
        for part in parts
    ]
    for part in mapped:
        for ring in part:
            if any(
                not (
                    -180 <= lng <= 180
                    and -MAP_LATITUDE_LIMIT <= lat <= MAP_LATITUDE_LIMIT
                )
                for lng, lat in ring
            ):
                raise InvalidEditGeometry(
                    "This polygon extends beyond the editable map."
                )
            if any(
                abs(point[0] - ring[index - 1][0]) > 180
                for index, point in enumerate(ring)
            ):
                raise InvalidEditGeometry(
                    "Polygons that cross the date line can’t be edited."
                )
    return mapped


def _original_polygons(
    resolved: ResolvedCatalogSelection,
    target: ClickedPolygon | ChosenPolygon,
) -> tuple[list[int], BaseGeometry | None, Transformer]:
    """Find eligible originals at the click or by native ID in the applied view.

    Args:
        resolved: Exact source and bound field or spatial predicate.
        target: Map point or one native feature ID.

    Returns:
        Matching IDs, native geometry when there is one match, and its projection.

    Raises:
        InvalidEditGeometry: If the dataset or read is outside interactive edit scope.
        SelectionUnavailableError: If a requested feature can no longer be found.
    """
    if resolved.driver != "GPKG":
        raise InvalidEditGeometry(
            "Geometry editing is available for GeoPackage polygon layers."
        )
    from osgeo import gdal, ogr

    limits = VectorReadLimits(features=2048)
    deadline = monotonic() + limits.seconds
    # The native FID accessor keeps 64-bit IDs, including IDs outside JavaScript's
    # safe integer range or the range returned by some Fiona builds.
    with (
        _limit_memory(limits.memory_bytes),
        gdal.ExceptionMgr(),
        ogr.ExceptionMgr(),
        gdal.OpenEx(
            str(resolved.path),
            gdal.OF_VECTOR | gdal.OF_READONLY,
            allowed_drivers=["GPKG"],
        ) as dataset,
    ):
        layer = dataset.GetLayerByName(resolved.selection.layerName)
        if layer is None:
            raise InvalidEditGeometry("The original polygon layer is unavailable.")
        crs = layer.GetSpatialRef()
        if (
            layer.GetGeomType() not in {ogr.wkbPolygon, ogr.wkbMultiPolygon}
            or crs is None
        ):
            raise InvalidEditGeometry(
                "Choose a two-dimensional GeoPackage polygon layer with a coordinate system."
            )
        projection = Transformer.from_crs(4326, crs.ExportToWkt(), always_xy=True)
        if isinstance(target, ChosenPolygon):
            fid = int(target.featureId)
            if not -(2**63) <= fid < 2**63:
                raise InvalidEditGeometry(
                    "The selected polygon ID is outside the GeoPackage range."
                )
            point = None
            candidates = (layer.GetFeature(fid),)
        else:
            x, y = projection.transform(*target.point, errcheck=True)
            point = Point(x, y)
            layer.SetSpatialFilterRect(
                math.nextafter(x, -math.inf),
                math.nextafter(y, -math.inf),
                math.nextafter(x, math.inf),
                math.nextafter(y, math.inf),
            )
            if resolved.where:
                layer.SetAttributeFilter(resolved.where)
            candidates = layer

        matches = []
        chosen = None
        fields = required_source_fields(
            resolved.calculated_fields, resolved.selection.filter.fields
        )
        for count, feature in enumerate(candidates, 1):
            if count > limits.features or monotonic() >= deadline:
                raise InvalidEditGeometry(
                    "Too many features to read at this position. Filter the layer and try again."
                )
            if feature is None or not _matches_original(feature, resolved, fields):
                continue
            native = feature.GetGeometryRef()
            if native is None:
                continue
            geometry = from_wkb(bytes(native.ExportToIsoWkb()))
            if get_num_coordinates(geometry) > limits.coordinates_per_feature:
                raise InvalidEditGeometry(
                    "A polygon at this position is too detailed to load for editing."
                )
            if geometry.is_empty or (point is not None and not geometry.covers(point)):
                continue
            matches.append(feature.GetFID())
            chosen = geometry if len(matches) == 1 else None
            if len(matches) > MAX_PICK_RESULTS:
                raise InvalidEditGeometry(
                    "Too many polygons overlap here. Apply a layer filter and choose a polygon again."
                )
        return sorted(matches), chosen, projection


def _matches_original(
    feature: ogr.Feature,
    resolved: ResolvedCatalogSelection,
    fields: tuple[str, ...],
) -> bool:
    """Apply the map view's bound spatial membership or exact attribute predicate.

    Args:
        feature: Native GeoPackage record with an exact original ID.
        resolved: Authorized view and its validated filter and calculated fields.
        fields: Original attributes the filter and its calculations read.

    Returns:
        Whether this original feature belongs to the view.
    """
    if resolved.matches is not None:
        return feature.GetFID() in resolved.matches.ids
    properties = {}
    for name in fields:
        value = feature.GetField(name)
        if value is not None and feature.GetFieldDefnRef(name).GetTypeName() == "Date":
            value = date(*feature.GetFieldAsDateTime(name)[:3]).isoformat()
        properties[name] = value
    properties.update(
        evaluate_calculated_fields(resolved.calculated_fields, properties)
    )
    return matches_filter(resolved.selection.filter, properties)


def _read_edit_worker(
    result: ProcessResultWriter,
    resolved: ResolvedCatalogSelection,
    target: ClickedPolygon | ChosenPolygon,
) -> None:
    """Send the matching original IDs and, for a single match, all editable rings.

    Args:
        result: Pipe receiving the read result or a public failure.
        resolved: Authorized original source with its applied predicate.
        target: Map point or requested native polygon ID.
    """
    try:
        ids, geometry, projection = _original_polygons(resolved, target)
        vertices = (
            None
            if geometry is None
            else EditablePolygon(
                featureId=str(ids[0]),
                parts=_map_parts(_editable_parts(geometry), projection),
            )
        )
        result.put(
            PolygonEditRead(featureIds=[str(fid) for fid in ids], feature=vertices)
        )
    except (InvalidEditGeometry, GeometryValidationError) as error:
        result.put(EditFailure(422, str(error)))
    except (GEOSException, ProjError, OSError, RuntimeError, ValueError, MemoryError):
        result.put(
            EditFailure(422, "The original polygon could not be read for editing.")
        )


async def read_polygon_edit(
    resolved: ResolvedCatalogSelection,
    target: ClickedPolygon | ChosenPolygon,
) -> PolygonEditRead:
    """Read original vertices with the ordinary interactive native-read deadline.

    Args:
        resolved: Authorized source and exact applied predicate.
        target: Map point or native ID.

    Returns:
        Complete polygon choices and the single match's exact editable vertices.

    Raises:
        VectorUploadError: If the read fails or cannot fit the interactive budget.
        asyncio.CancelledError: After the native read has stopped.
    """
    try:
        result = await run_bounded_process(
            _read_edit_worker, (resolved, target), VectorReadLimits().seconds
        )
    except ProcessDeadlineError as error:
        raise VectorUploadError(
            422, "The polygon read took too long. Filter the layer and try again."
        ) from error
    if isinstance(result, EditFailure):
        raise VectorUploadError(result.status, result.detail)
    return result


def _revised_geometry(
    original: BaseGeometry, edits: list[EditedPart], projection: Transformer
) -> Polygon | MultiPolygon:
    """Apply the submitted vertex replacements in the original coordinate system.

    Args:
        original: Exact original feature geometry.
        edits: Each existing ring with retained indices and replacement map positions.
        projection: Map to original-source coordinate transformation.

    Returns:
        A valid two-dimensional polygon of the original geometry type.

    Raises:
        InvalidEditGeometry: If parts or rings are missing, or the revision is invalid.
        ProjError: If a changed vertex cannot be projected.
    """
    original_parts = _editable_parts(original)
    if len(original_parts) != len(edits) or any(
        len(part) != len(edit) for part, edit in zip(original_parts, edits)
    ):
        raise InvalidEditGeometry("Edit the existing rings and parts of this polygon.")
    polygons = []
    for part, edited in zip(original_parts, edits):
        rings = []
        for before, after in zip(part, edited):
            points = []
            previous = -1
            for vertex in after:
                if isinstance(vertex, int):
                    if vertex <= previous or vertex >= len(before):
                        raise InvalidEditGeometry(
                            "Select the polygon again before changing its original vertices."
                        )
                    previous = vertex
                    points.append(before[vertex])
                else:
                    points.append(projection.transform(*vertex, errcheck=True))
            if len(set(points)) != len(points):
                raise InvalidEditGeometry(
                    "Move overlapping vertices apart before saving."
                )
            rings.append(points)
        polygons.append(Polygon(rings[0], rings[1:]))
    revised = (
        MultiPolygon(polygons) if isinstance(original, MultiPolygon) else polygons[0]
    )
    if (
        revised.is_empty
        or not revised.is_valid
        or any(polygon.area <= 0 for polygon in polygons)
    ):
        raise InvalidEditGeometry(
            "Give every ring an area, keep holes inside their polygon, and move vertices so the edges don’t cross."
        )
    _map_parts(_editable_parts(revised), projection)
    return revised


def _copy_edited_layer(
    resolved: ResolvedCatalogSelection,
    path: Path,
    limit: int,
    feature_id: int,
    revised: Polygon | MultiPolygon,
) -> None:
    """Write one private native layer with the selected feature's revised geometry.

    Args:
        resolved: Authorized original GeoPackage and native layer.
        path: Unused staging path created by private upload admission.
        limit: Bytes available for this staged single-file GeoPackage.
        feature_id: Original native ID in both source and destination.
        revised: Validated geometry already in the native coordinate system.

    Raises:
        InvalidEditGeometry: If the source cannot be copied with its native identity.
        VectorUploadError: If there is insufficient space for the edited copy.
        RuntimeError: If the native GeoPackage writer fails.
    """
    from osgeo import gdal, ogr

    with (
        gdal.ExceptionMgr(),
        ogr.ExceptionMgr(),
        gdal.config_options(
            {
                "OGR_SQLITE_JOURNAL": "OFF",
                "SQLITE_TMPDIR": str(path.parent),
            }
        ),
    ):
        with gdal.OpenEx(
            str(resolved.path),
            gdal.OF_VECTOR | gdal.OF_READONLY,
            allowed_drivers=["GPKG"],
        ) as source:
            name = resolved.selection.layerName
            layer = source.GetLayerByName(name)
            options = gdal.VectorTranslateOptions(
                layers=[name],
                preserveFID=True,
                layerCreationOptions=[
                    f"FID={layer.GetFIDColumn()}",
                    f"GEOMETRY_NAME={layer.GetGeometryColumn()}",
                ],
            )
            if limit < 4096:
                raise VectorUploadError(
                    413, "The edited copy does not fit in Your uploads."
                )
            driver = gdal.GetDriverByName("GPKG")
            with driver.Create(str(path), 0, 0, 0, gdal.GDT_Unknown) as destination:
                destination.ExecuteSQL("PRAGMA temp_store=MEMORY")
                with destination.ExecuteSQL("PRAGMA page_size") as rows:
                    page_size = rows.GetNextFeature().GetField(0)
                pages = limit // page_size
                if pages < 1:
                    raise VectorUploadError(
                        413, "The edited copy does not fit in Your uploads."
                    )
                with destination.ExecuteSQL(f"PRAGMA max_page_count={pages}") as rows:
                    if rows.GetNextFeature().GetField(0) > pages:
                        raise VectorUploadError(
                            413, "The edited copy does not fit in Your uploads."
                        )
                if not gdal.VectorTranslate(destination, source, options=options):
                    raise InvalidEditGeometry(
                        "The GeoPackage layer could not be copied."
                    )
                edited = destination.GetLayerByName(name)
                feature = edited.GetFeature(feature_id)
                if feature is None:
                    raise InvalidEditGeometry(
                        "The copy could not preserve the polygon’s original ID."
                    )
                feature.SetGeometry(ogr.CreateGeometryFromWkb(revised.wkb))
                edited.SetFeature(feature)
                # The GeoPackage driver treats the full suffix as a literal layer name.
                destination.ExecuteSQL(f"RECOMPUTE EXTENT ON {name}")


def _write_edit_worker(
    result: ProcessResultWriter,
    resolved: ResolvedCatalogSelection,
    draft: SavePolygonEdit,
    path: Path,
    limit: int,
) -> None:
    """Validate the exact feature and write a complete staged GeoPackage before returning.

    Args:
        result: Pipe receiving completion or a browser-safe failure.
        resolved: Authorized original layer and active view predicate.
        draft: Path-free feature identity and vertex changes.
        path: New private staging path.
        limit: Upload admission's maximum number of output bytes.
    """
    try:
        ids, original, projection = _original_polygons(
            resolved, ChosenPolygon(featureId=draft.featureId)
        )
        if original is None:
            raise InvalidEditGeometry("This polygon is no longer in the selected view.")
        revised = _revised_geometry(original, draft.parts, projection)
        _copy_edited_layer(resolved, path, limit, ids[0], revised)
        result.put(None)
    except (InvalidEditGeometry, GeometryValidationError) as error:
        result.put(EditFailure(422, str(error)))
    except VectorUploadError as error:
        result.put(EditFailure(error.status, str(error)))
    except (
        GEOSException,
        ProjError,
        RuntimeError,
        OSError,
        ValueError,
        MemoryError,
    ) as error:
        if "disk is full" in str(error).lower():
            result.put(
                EditFailure(
                    413, "The edited copy exceeds the available upload storage."
                )
            )
        else:
            result.put(
                EditFailure(
                    422,
                    "The edited layer could not be written. Check the source and try again.",
                )
            )


async def write_polygon_edit(
    resolved: ResolvedCatalogSelection,
    draft: SavePolygonEdit,
    path: Path,
    limit: int,
) -> None:
    """Write the validated edit inside the caller's existing private admission.

    Args:
        resolved: Authorized original source and current view predicate.
        draft: Vertex changes for one exact feature.
        path: New staging file in the upload owner's pending directory.
        limit: Existing private storage's byte allowance for the new file.

    Raises:
        VectorUploadError: If validation, output writing or the deadline fails.
        asyncio.CancelledError: After the native writer has exited.
    """
    try:
        failure = await run_bounded_process(
            _write_edit_worker, (resolved, draft, path, limit), 120
        )
    except ProcessDeadlineError as error:
        raise VectorUploadError(
            422, "The edited layer took too long to save. Try a smaller layer."
        ) from error
    if failure is not None:
        raise VectorUploadError(failure.status, failure.detail)
