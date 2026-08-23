"""Bounded container and geometry validation for temporary uploaded AOIs."""

import json
import math
import stat
from collections.abc import Iterable, Iterator, Sequence
from numbers import Real
from pathlib import Path, PurePosixPath
from time import monotonic
from typing import Any
from zipfile import BadZipFile, ZIP_DEFLATED, ZIP_STORED, ZipFile, ZipInfo

import fiona
from fiona.model import to_dict
from fiona.transform import transform_geom
from rasterio.features import is_valid_geom

from eolab_app.temporary_aoi.errors import (
    TemporaryAoiTooLargeError,
    TemporaryAoiValidationError,
)
from eolab_app.temporary_aoi.models import DatasetChoice


MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_ZIP_ENTRIES = 512
MAX_ZIP_MEMBER_BYTES = 25 * 1024 * 1024
MAX_ZIP_EXTRACTED_BYTES = 100 * 1024 * 1024
MAX_ZIP_COMPRESSION_RATIO = 100.0
MAX_FEATURES = 10_000
MAX_COORDINATE_POSITIONS = 100_000
MAX_BROWSER_GEOMETRY_BYTES = 2 * 1024 * 1024
MAX_DATASET_CHOICES = 64
MAX_GEOMETRY_NESTING_DEPTH = 32
PROCESSING_TIME_SECONDS = 15.0
SUPPORTED_GEOMETRY_TYPES = {
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
    "GeometryCollection",
}
SHAPEFILE_COMPONENT_EXTENSIONS = {
    ".shp",
    ".shx",
    ".dbf",
    ".prj",
    ".cpg",
    ".qix",
    ".sbn",
    ".sbx",
}
REQUIRED_SHAPEFILE_COMPONENTS = {".shp", ".shx", ".dbf", ".prj"}


def discover_dataset_choices(
    source_path: Path,
    upload_directory: Path,
    choice_ids: Iterable[str],
) -> tuple[DatasetChoice, ...]:
    """Discover validated spatial datasets without reading their features.

    Args:
        source_path: Server-owned uploaded GeoPackage or ZIP path.
        upload_directory: Isolated directory available for safe extraction.
        choice_ids: Opaque identifiers consumed in deterministic order.

    Returns:
        One selectable choice for every usable spatial dataset.

    Raises:
        TemporaryAoiValidationError: If the container is malformed, unsafe,
            or has no usable spatial vector dataset.
        TemporaryAoiTooLargeError: If ZIP declarations exceed a ceiling.
        OSError: If server-owned files cannot be read or written.
    """
    id_iterator = iter(choice_ids)
    if source_path.suffix == ".gpkg":
        candidates = _discover_geopackage_candidates(source_path)
    else:
        candidates = _extract_shapefile_candidates(
            source_path,
            upload_directory / "extracted",
        )

    if len(candidates) > MAX_DATASET_CHOICES:
        raise TemporaryAoiTooLargeError(
            f"Upload contains more than {MAX_DATASET_CHOICES} dataset candidates"
        )
    choices: list[DatasetChoice] = []
    validation_errors: list[str] = []
    for label, candidate_path, layer_name in candidates:
        try:
            _validate_spatial_metadata(candidate_path, layer_name)
        except (fiona.errors.FionaError, OSError, ValueError) as error:
            validation_errors.append(f"{label}: {error}")
            continue
        choices.append(DatasetChoice(
            id=next(id_iterator),
            label=label,
            source_path=candidate_path,
            layer_name=layer_name,
        ))
    if choices:
        return tuple(choices)
    detail = (
        "; ".join(validation_errors)
        if validation_errors
        else "the upload contains no spatial vector datasets"
    )
    raise TemporaryAoiValidationError(
        f"The uploaded file has no usable AOI dataset: {detail}"
    )


def read_browser_geometry(
    choice: DatasetChoice,
    processing_seconds: float = PROCESSING_TIME_SECONDS,
) -> tuple[dict[str, Any], tuple[float, float, float, float]]:
    """Read one selected dataset into a bounded WGS 84 FeatureCollection.

    Fiona/GDAL is explicitly configured for traditional GIS axis order, so
    every transformed position is longitude then latitude regardless of the
    authority-axis declaration in the source CRS.

    Args:
        choice: Previously validated server-owned dataset choice.
        processing_seconds: Maximum synchronous processing time.

    Returns:
        Bounded GeoJSON FeatureCollection and canonical WGS 84 bounds.

    Raises:
        TemporaryAoiValidationError: If geometry, CRS, bounds, feature count,
            coordinate count, output size, or processing time is invalid.
        fiona.errors.FionaError: If GDAL cannot read the selected dataset.
    """
    deadline = monotonic() + processing_seconds
    features: list[dict[str, Any]] = []
    bounds = [math.inf, math.inf, -math.inf, -math.inf]
    coordinate_count = 0
    open_options: dict[str, object] = {}
    if choice.layer_name is not None:
        open_options["layer"] = choice.layer_name
        open_options["enabled_drivers"] = ["GPKG"]
    else:
        open_options["enabled_drivers"] = ["ESRI Shapefile"]

    with fiona.Env(OGR_CT_FORCE_TRADITIONAL_GIS_ORDER="YES"):
        with fiona.open(choice.source_path, **open_options) as dataset:
            if not dataset.crs:
                raise TemporaryAoiValidationError(
                    f"Dataset {choice.label!r} has no coordinate reference system"
                )
            feature_count = len(dataset)
            if feature_count < 1:
                raise TemporaryAoiValidationError(
                    f"Dataset {choice.label!r} has no features"
                )
            if feature_count > MAX_FEATURES:
                raise TemporaryAoiValidationError(
                    f"Dataset has {feature_count} features; limit is {MAX_FEATURES}"
                )
            for source_feature in dataset:
                if monotonic() > deadline:
                    raise TemporaryAoiValidationError(
                        "AOI processing exceeded the "
                        f"{processing_seconds:g}-second limit"
                    )
                source_geometry = source_feature.geometry
                if source_geometry is None:
                    raise TemporaryAoiValidationError(
                        "AOI features must not contain null geometry"
                    )
                geometry_mapping = dict(source_geometry.__geo_interface__)
                transformed = transform_geom(
                    dataset.crs,
                    "EPSG:4326",
                    geometry_mapping,
                    antimeridian_cutting=False,
                )
                transformed_geometry = to_dict(transformed)
                if (
                    transformed_geometry.get("type") not in SUPPORTED_GEOMETRY_TYPES
                    or not is_valid_geom(transformed_geometry)
                ):
                    raise TemporaryAoiValidationError(
                        "AOI contains unsupported or malformed geometry"
                    )
                added_count = _merge_geometry_bounds(
                    transformed_geometry,
                    bounds,
                    0,
                )
                coordinate_count += added_count
                if coordinate_count > MAX_COORDINATE_POSITIONS:
                    raise TemporaryAoiValidationError(
                        "AOI geometry exceeds the "
                        f"{MAX_COORDINATE_POSITIONS}-coordinate limit"
                    )
                features.append({
                    "type": "Feature",
                    "properties": {},
                    "geometry": transformed_geometry,
                })

    if not features or not all(math.isfinite(value) for value in bounds):
        raise TemporaryAoiValidationError("AOI has no finite spatial bounds")
    feature_collection = {"type": "FeatureCollection", "features": features}
    try:
        output_bytes = len(json.dumps(
            feature_collection,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8"))
    except (TypeError, ValueError) as error:
        raise TemporaryAoiValidationError(
            "AOI geometry cannot be represented safely in the browser"
        ) from error
    if output_bytes > MAX_BROWSER_GEOMETRY_BYTES:
        raise TemporaryAoiValidationError(
            "AOI browser geometry exceeds the "
            f"{MAX_BROWSER_GEOMETRY_BYTES}-byte limit"
        )
    return feature_collection, (bounds[0], bounds[1], bounds[2], bounds[3])


def _discover_geopackage_candidates(
    source_path: Path,
) -> tuple[tuple[str, Path, str | None], ...]:
    """List deterministic GeoPackage layer candidates.

    Args:
        source_path: Uploaded GeoPackage path.

    Returns:
        Display labels, container paths, and exact layer names.

    Raises:
        TemporaryAoiValidationError: If the container is malformed or has an
            excessive layer name.
    """
    try:
        layer_names = sorted(fiona.listlayers(source_path))
    except (fiona.errors.FionaError, OSError) as error:
        raise TemporaryAoiValidationError(
            "The uploaded GeoPackage is malformed or unreadable"
        ) from error
    if any(not layer_name or len(layer_name) > 512 for layer_name in layer_names):
        raise TemporaryAoiValidationError(
            "The uploaded GeoPackage contains an invalid layer name"
        )
    return tuple((layer_name, source_path, layer_name) for layer_name in layer_names)


def _extract_shapefile_candidates(
    archive_path: Path,
    extraction_root: Path,
) -> tuple[tuple[str, Path, str | None], ...]:
    """Validate and extract complete Shapefiles from one bounded ZIP.

    Args:
        archive_path: Server-owned uploaded ZIP path.
        extraction_root: Isolated destination outside the scan source.

    Returns:
        Display labels and extracted `.shp` paths in deterministic order.

    Raises:
        TemporaryAoiValidationError: If the ZIP is unsafe, malformed,
            encrypted, nested, or contains no complete Shapefile.
        TemporaryAoiTooLargeError: If declared or actual extraction exceeds a
            resource ceiling.
        OSError: If server-owned extraction fails.
    """
    try:
        archive = ZipFile(archive_path, mode="r")
    except (BadZipFile, OSError) as error:
        raise TemporaryAoiValidationError(
            "The uploaded ZIP archive is malformed or unreadable"
        ) from error
    with archive:
        members = archive.infolist()
        if len(members) > MAX_ZIP_ENTRIES:
            raise TemporaryAoiTooLargeError(
                f"ZIP archive contains more than {MAX_ZIP_ENTRIES} entries"
            )
        validated_members = _validate_zip_members(members)
        groups = _group_shapefile_members(validated_members)
        complete_groups = []
        incomplete_details = []
        for label, components in groups:
            missing = REQUIRED_SHAPEFILE_COMPONENTS - components.keys()
            if missing:
                incomplete_details.append(
                    f"{label} is missing {', '.join(sorted(missing))}"
                )
            else:
                complete_groups.append((label, components))
        if not complete_groups:
            detail = (
                "; ".join(incomplete_details)
                if incomplete_details
                else "no .shp dataset was found"
            )
            raise TemporaryAoiValidationError(
                f"ZIP archive contains no complete Shapefile: {detail}"
            )
        extraction_root.mkdir(parents=True, exist_ok=False)
        extracted_bytes = 0
        for _label, components in complete_groups:
            for member_path, member in components.values():
                destination = extraction_root.joinpath(*member_path.parts)
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member, mode="r") as source, destination.open(
                    "xb"
                ) as target:
                    extracted_bytes = _copy_bounded_member(
                        source,
                        target,
                        member,
                        extracted_bytes,
                    )
    return tuple(
        (
            label,
            extraction_root.joinpath(*components[".shp"][0].parts),
            None,
        )
        for label, components in complete_groups
    )


def _validate_zip_members(
    members: Sequence[ZipInfo],
) -> tuple[tuple[PurePosixPath, ZipInfo], ...]:
    """Validate ZIP paths, identities, methods, and declared resources.

    Args:
        members: Central-directory entries supplied by Python's ZIP parser.

    Returns:
        Safe relative POSIX member paths paired with their entries.

    Raises:
        TemporaryAoiValidationError: If a member is unsafe or unsupported.
        TemporaryAoiTooLargeError: If declared extraction exceeds a ceiling.
    """
    validated: list[tuple[PurePosixPath, ZipInfo]] = []
    normalized_names: set[str] = set()
    total_bytes = 0
    for member in members:
        member_path = _validate_zip_member_path(member)
        normalized_name = member_path.as_posix().casefold()
        if normalized_name in normalized_names:
            raise TemporaryAoiValidationError(
                "ZIP archive contains duplicate or ambiguous entry "
                f"{member.filename!r}"
            )
        normalized_names.add(normalized_name)
        if member.is_dir():
            continue
        if member_path.suffix.casefold() == ".zip":
            raise TemporaryAoiValidationError(
                "ZIP archives nested inside the upload are not supported"
            )
        if member.flag_bits & 0x1:
            raise TemporaryAoiValidationError(
                f"Encrypted ZIP entry is not supported: {member.filename}"
            )
        if member.compress_type not in {ZIP_STORED, ZIP_DEFLATED}:
            raise TemporaryAoiValidationError(
                f"Unsupported ZIP compression method: {member.filename}"
            )
        if member.file_size > MAX_ZIP_MEMBER_BYTES:
            raise TemporaryAoiTooLargeError(
                f"ZIP entry exceeds the {MAX_ZIP_MEMBER_BYTES}-byte limit"
            )
        if member.file_size and member.compress_size == 0:
            raise TemporaryAoiValidationError(
                f"ZIP entry has an invalid compressed size: {member.filename}"
            )
        if member.compress_size and (
            member.file_size / member.compress_size > MAX_ZIP_COMPRESSION_RATIO
        ):
            raise TemporaryAoiTooLargeError(
                "ZIP entry exceeds the "
                f"{MAX_ZIP_COMPRESSION_RATIO:g}:1 compression-ratio limit"
            )
        total_bytes += member.file_size
        if total_bytes > MAX_ZIP_EXTRACTED_BYTES:
            raise TemporaryAoiTooLargeError(
                "ZIP archive exceeds the "
                f"{MAX_ZIP_EXTRACTED_BYTES}-byte extracted limit"
            )
        validated.append((member_path, member))
    return tuple(validated)


def _validate_zip_member_path(member: ZipInfo) -> PurePosixPath:
    """Return an unambiguous safe relative path for one ZIP member.

    Args:
        member: Central-directory entry to validate.

    Returns:
        Relative POSIX path preserved from the archive.

    Raises:
        TemporaryAoiValidationError: If the path traverses, is absolute,
            contains controls or backslashes, is drive-qualified, or is a
            symbolic link.
    """
    name = member.orig_filename
    if (
        not name
        or len(name) > 1024
        or "\x00" in name
        or "\\" in name
        or any(
            ord(character) < 32 or ord(character) == 127
            for character in name
        )
    ):
        raise TemporaryAoiValidationError("ZIP archive contains an unsafe path")
    path_text = name[:-1] if name.endswith("/") else name
    parts = path_text.split("/")
    if (
        not path_text
        or name.startswith("/")
        or any(part in {"", ".", ".."} for part in parts)
        or len(parts) > 32
        or ":" in parts[0]
    ):
        raise TemporaryAoiValidationError(
            f"ZIP entry is not a safe relative path: {name}"
        )
    if stat.S_ISLNK(member.external_attr >> 16):
        raise TemporaryAoiValidationError(
            f"ZIP symbolic-link entry is not supported: {name}"
        )
    return PurePosixPath(*parts)


def _group_shapefile_members(
    members: Sequence[tuple[PurePosixPath, ZipInfo]],
) -> tuple[tuple[str, dict[str, tuple[PurePosixPath, ZipInfo]]], ...]:
    """Group recognized Shapefile components by exact internal basename.

    Args:
        members: Validated non-directory ZIP members.

    Returns:
        Deterministically ordered `.shp` labels and component mappings.

    Raises:
        TemporaryAoiValidationError: If a component extension is duplicated
            case-insensitively in one dataset group.
    """
    groups: dict[
        tuple[PurePosixPath, str],
        dict[str, tuple[PurePosixPath, ZipInfo]],
    ] = {}
    for member_path, member in members:
        extension = member_path.suffix.casefold()
        if extension not in SHAPEFILE_COMPONENT_EXTENSIONS:
            continue
        component_stem = member_path.name[
            : -len(member_path.suffix)
        ].casefold()
        key = member_path.parent, component_stem
        components = groups.setdefault(key, {})
        if extension in components:
            raise TemporaryAoiValidationError(
                f"Shapefile contains duplicate {extension} components"
            )
        components[extension] = (member_path, member)
    results = []
    for components in groups.values():
        if ".shp" not in components:
            continue
        label = components[".shp"][0].as_posix()
        results.append((label, components))
    return tuple(sorted(results, key=lambda result: result[0]))


def _copy_bounded_member(
    source: Any,
    target: Any,
    member: ZipInfo,
    extracted_bytes: int,
) -> int:
    """Copy one ZIP member while enforcing actual extracted byte limits.

    Args:
        source: Readable decompressed member stream.
        target: Writable server-owned destination stream.
        member: Declared central-directory metadata for the member.
        extracted_bytes: Actual bytes extracted before this member.

    Returns:
        Updated total actual extracted bytes.

    Raises:
        TemporaryAoiTooLargeError: If actual member or total bytes exceed a
            ceiling or disagree with the declared member size.
    """
    member_bytes = 0
    while chunk := source.read(64 * 1024):
        member_bytes += len(chunk)
        extracted_bytes += len(chunk)
        if (
            member_bytes > MAX_ZIP_MEMBER_BYTES
            or extracted_bytes > MAX_ZIP_EXTRACTED_BYTES
        ):
            raise TemporaryAoiTooLargeError(
                "ZIP extraction exceeded its actual-byte limit"
            )
        target.write(chunk)
    if member_bytes != member.file_size:
        raise TemporaryAoiValidationError(
            f"ZIP entry size changed while extracting {member.filename}"
        )
    return extracted_bytes


def _validate_spatial_metadata(source_path: Path, layer_name: str | None) -> None:
    """Validate one candidate's bounded spatial metadata.

    Args:
        source_path: Server-owned GeoPackage or extracted `.shp` path.
        layer_name: Exact GeoPackage layer name, or ``None`` for Shapefile.

    Returns:
        None.

    Raises:
        ValueError: If the dataset is nonspatial, empty, excessive, lacks a
            CRS, declares unsupported geometry, or has invalid finite bounds.
        fiona.errors.FionaError: If GDAL cannot inspect the dataset.
    """
    options: dict[str, object] = {}
    if layer_name is None:
        options["enabled_drivers"] = ["ESRI Shapefile"]
    else:
        options["layer"] = layer_name
        options["enabled_drivers"] = ["GPKG"]
    with fiona.open(source_path, **options) as dataset:
        geometry_type = dataset.schema.get("geometry")
        normalized_type = str(geometry_type).removeprefix("3D ")
        if geometry_type in {None, "None"}:
            raise ValueError("layer is nonspatial")
        if normalized_type == "Unknown":
            raise ValueError(
                "layer is nonspatial or has an unknown geometry type"
            )
        if normalized_type not in SUPPORTED_GEOMETRY_TYPES:
            raise ValueError(f"unsupported geometry type {geometry_type!r}")
        if not dataset.crs:
            raise ValueError("dataset has no coordinate reference system")
        feature_count = len(dataset)
        if feature_count < 1:
            raise ValueError("dataset has no features")
        if feature_count > MAX_FEATURES:
            raise ValueError(
                f"dataset has {feature_count} features; limit is {MAX_FEATURES}"
            )
        bounds = tuple(dataset.bounds)
        if (
            len(bounds) != 4
            or not all(math.isfinite(value) for value in bounds)
            or bounds[0] > bounds[2]
            or bounds[1] > bounds[3]
        ):
            raise ValueError("dataset has invalid finite bounds")


def _merge_geometry_bounds(
    geometry: dict[str, Any],
    bounds: list[float],
    depth: int,
) -> int:
    """Validate WGS 84 positions and merge them into aggregate bounds.

    Args:
        geometry: Transformed GeoJSON geometry mapping.
        bounds: Mutable west, south, east, and north aggregate.
        depth: Current GeometryCollection nesting depth.

    Returns:
        Number of coordinate positions contained in the geometry.

    Raises:
        TemporaryAoiValidationError: If positions are non-finite, outside the
            canonical world, malformed, or absent.
    """
    if depth > MAX_GEOMETRY_NESTING_DEPTH:
        raise TemporaryAoiValidationError(
            "AOI geometry exceeds the supported nesting depth"
        )
    if geometry.get("type") == "GeometryCollection":
        geometries = geometry.get("geometries")
        if not isinstance(geometries, Sequence) or not geometries:
            raise TemporaryAoiValidationError(
                "AOI contains an empty or malformed GeometryCollection"
            )
        count = 0
        for child in geometries:
            if not isinstance(child, dict):
                child = dict(child)
            count += _merge_geometry_bounds(child, bounds, depth + 1)
        return count
    coordinates = geometry.get("coordinates")
    positions = tuple(_iter_positions(coordinates))
    if not positions:
        raise TemporaryAoiValidationError("AOI contains empty geometry")
    for longitude, latitude in positions:
        if not -180 <= longitude <= 180 or not -90 <= latitude <= 90:
            raise TemporaryAoiValidationError(
                "AOI geometry is outside canonical WGS 84 bounds"
            )
        bounds[0] = min(bounds[0], longitude)
        bounds[1] = min(bounds[1], latitude)
        bounds[2] = max(bounds[2], longitude)
        bounds[3] = max(bounds[3], latitude)
    return len(positions)


def _iter_positions(value: Any) -> Iterator[tuple[float, float]]:
    """Yield finite longitude/latitude pairs from nested coordinates.

    Args:
        value: GeoJSON coordinates at any nesting depth.

    Yields:
        Floating-point longitude and latitude positions.

    Raises:
        TemporaryAoiValidationError: If coordinate nesting or ordinates are
            malformed or non-finite.
    """
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise TemporaryAoiValidationError("AOI has malformed coordinates")
    if value and all(isinstance(ordinate, Real) for ordinate in value):
        if len(value) < 2 or not all(math.isfinite(float(item)) for item in value):
            raise TemporaryAoiValidationError(
                "AOI coordinates must contain finite positions"
            )
        yield float(value[0]), float(value[1])
        return
    for child in value:
        yield from _iter_positions(child)
