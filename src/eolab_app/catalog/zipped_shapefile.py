"""Safely catalog ESRI Shapefiles contained in mounted ZIP archives."""

import hashlib
import logging
import math
import stat
import struct
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any
from zipfile import (
    BadZipFile,
    ZIP_DEFLATED,
    ZIP_STORED,
    ZipFile,
    ZipInfo,
)

import fiona
from rasterio.crs import CRS
from rasterio.warp import transform_bounds

from eolab_app.catalog.shapefile import (
    COMPONENT_EXTENSION_ORDER,
    GEOJSON_GEOMETRY_TYPES,
    PROJECTION_EXTENSION,
    REQUIRED_COMPONENT_EXTENSIONS,
    SHAPEFILE_COMPONENT_TYPES,
)
from eolab_app.catalog.vector import (
    MOUNTED_VECTOR_COLLECTION_ID,
    TABLE_EXTENSION,
    build_bbox_polygon,
    build_vector_table_properties,
)


LOGGER = logging.getLogger(__name__)
ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = b"PK\x05\x06"
ZIP_END_OF_CENTRAL_DIRECTORY_SIZE = 22
ZIP_MAX_COMMENT_BYTES = 65_535
ZIP64_SENTINEL_16 = 0xFFFF
ZIP64_SENTINEL_32 = 0xFFFFFFFF
ZIP_MEDIA_TYPE = "application/zip"
FALLBACK_DATETIME_DESCRIPTION = (
    "ZIP-contained Shapefiles have no standardized observation or acquisition "
    "timestamp used by EOLab. The Item datetime uses the mounted ZIP archive's "
    "filesystem modification time."
)


@dataclass(frozen=True)
class ZipResourceLimits:
    """Hard resource ceilings applied before GDAL opens a ZIP archive.

    Attributes:
        archive_bytes: Maximum compressed archive size on the mounted source.
        central_directory_bytes: Maximum ZIP central-directory size.
        member_count: Maximum number of entries declared by the archive.
        member_uncompressed_bytes: Maximum uncompressed size of one member.
        total_uncompressed_bytes: Maximum summed uncompressed member size.
        compression_ratio: Maximum uncompressed-to-compressed ratio per member.
    """

    archive_bytes: int = 2 * 1024 * 1024 * 1024
    central_directory_bytes: int = 16 * 1024 * 1024
    member_count: int = 4096
    member_uncompressed_bytes: int = 2 * 1024 * 1024 * 1024
    total_uncompressed_bytes: int = 4 * 1024 * 1024 * 1024
    compression_ratio: float = 1000.0

    def __post_init__(self) -> None:
        """Validate every resource ceiling.

        Raises:
            ValueError: If a resource ceiling is not greater than zero.
        """
        limits = {
            "archive_bytes": self.archive_bytes,
            "central_directory_bytes": self.central_directory_bytes,
            "member_count": self.member_count,
            "member_uncompressed_bytes": self.member_uncompressed_bytes,
            "total_uncompressed_bytes": self.total_uncompressed_bytes,
            "compression_ratio": self.compression_ratio,
        }
        if any(not math.isfinite(value) or value <= 0 for value in limits.values()):
            raise ValueError("ZIP resource limits must be finite and greater than zero")


@dataclass(frozen=True)
class ArchiveSignature:
    """Filesystem identity used to detect archive replacement during a read.

    Attributes:
        device: Filesystem device identifier.
        inode: Filesystem inode or equivalent file identifier.
        size: Compressed archive size in bytes.
        modified_nanoseconds: Archive modification time in nanoseconds.
    """

    device: int
    inode: int
    size: int
    modified_nanoseconds: int


@dataclass(frozen=True)
class ArchivedShapefile:
    """One internal Shapefile and its validated component entries.

    Attributes:
        shapefile_path: Normalized POSIX path of the internal `.shp` member.
        components: Canonical component extensions paired with member paths.
    """

    shapefile_path: PurePosixPath
    components: tuple[tuple[str, PurePosixPath], ...]


DEFAULT_ZIP_RESOURCE_LIMITS = ZipResourceLimits()


def build_stac_items(
    source_root: Path,
    archive_path: Path,
    limits: ZipResourceLimits = DEFAULT_ZIP_RESOURCE_LIMITS,
) -> tuple[dict[str, Any], ...]:
    """Build one STAC Item for each valid Shapefile in a mounted ZIP.

    Direct GDAL `/vsizip/` paths avoid temporary extraction. Invalid internal
    Shapefiles are logged independently so a valid sibling can still be
    returned. When every discovered Shapefile is invalid, the aggregate error
    is raised for capture by the scanner's existing per-source error boundary.

    Args:
        source_root: Root directory mounted for scanning.
        archive_path: ZIP archive below the mounted root.
        limits: Resource ceilings enforced before GDAL reads archive members.

    Returns:
        Deterministically ordered STAC Items for valid internal Shapefiles.

    Raises:
        ValueError: If the archive path, structure, entries, resource use, or
            all internal Shapefiles violate the catalog contract.
        OSError: If the archive cannot be inspected or changes during reading.
        BadZipFile: If the ZIP central directory is malformed.
    """
    relative_archive_path = archive_path.relative_to(source_root)
    if not stat.S_ISREG(archive_path.lstat().st_mode):
        raise OSError("ZIP dataset is not a mounted regular file")
    resolved_source_root = source_root.resolve()
    resolved_archive_path = archive_path.resolve(strict=True)
    if not resolved_archive_path.is_relative_to(resolved_source_root):
        raise ValueError("ZIP archive is outside the mounted scan source")
    archive_path = resolved_archive_path
    archive_signature = _archive_signature(archive_path)
    if archive_signature.size > limits.archive_bytes:
        raise ValueError(
            "ZIP archive compressed size exceeds the "
            f"{limits.archive_bytes}-byte limit"
        )

    _validate_end_of_central_directory(archive_path, limits)
    with ZipFile(archive_path, mode="r") as archive:
        archived_shapefiles = _validated_shapefiles(archive, limits)

    if not archived_shapefiles:
        raise ValueError("ZIP archive contains no Shapefile datasets")

    archive_modified_at = datetime.fromtimestamp(
        archive_signature.modified_nanoseconds / 1_000_000_000,
        tz=timezone.utc,
    )
    items: list[dict[str, Any]] = []
    internal_errors: list[str] = []
    for archived_shapefile in archived_shapefiles:
        try:
            items.append(_build_stac_item(
                source_root,
                archive_path,
                relative_archive_path,
                archive_modified_at,
                archived_shapefile,
            ))
        except Exception as error:
            internal_error = (
                f"{archived_shapefile.shapefile_path.as_posix()}: {error}"
            )
            internal_errors.append(internal_error)
            LOGGER.warning(
                "Skipped invalid Shapefile in %s: %s",
                relative_archive_path.as_posix(),
                internal_error,
            )

    if _archive_signature(archive_path) != archive_signature:
        raise OSError("ZIP archive changed while metadata was being read")
    if items:
        return tuple(items)
    raise ValueError(
        "ZIP archive contains no valid Shapefile datasets: "
        + "; ".join(internal_errors)
    )


def _validate_end_of_central_directory(
    archive_path: Path,
    limits: ZipResourceLimits,
) -> None:
    """Bound central-directory parsing before constructing ``ZipFile``.

    Args:
        archive_path: Mounted ZIP archive to preflight.
        limits: Resource ceilings for entry count and directory bytes.

    Raises:
        BadZipFile: If no unambiguous single-disk ZIP directory is present.
        ValueError: If ZIP64 or a configured resource ceiling is encountered.
        OSError: If the archive cannot be read.
    """
    archive_size = archive_path.stat().st_size
    tail_size = min(
        archive_size,
        ZIP_END_OF_CENTRAL_DIRECTORY_SIZE + ZIP_MAX_COMMENT_BYTES,
    )
    with archive_path.open("rb") as archive_stream:
        archive_stream.seek(archive_size - tail_size)
        archive_tail = archive_stream.read(tail_size)

    end_record = None
    search_end = len(archive_tail)
    while search_end:
        record_offset = archive_tail.rfind(
            ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE,
            0,
            search_end,
        )
        if record_offset < 0:
            break
        if record_offset + ZIP_END_OF_CENTRAL_DIRECTORY_SIZE <= len(archive_tail):
            candidate = struct.unpack_from("<4s4H2LH", archive_tail, record_offset)
            comment_length = candidate[-1]
            if (
                record_offset
                + ZIP_END_OF_CENTRAL_DIRECTORY_SIZE
                + comment_length
                == len(archive_tail)
            ):
                end_record = candidate
                break
        search_end = record_offset

    if end_record is None:
        raise BadZipFile("ZIP archive has no valid end-of-central-directory record")
    (
        _signature,
        disk_number,
        central_directory_disk,
        entries_on_disk,
        entry_count,
        central_directory_size,
        central_directory_offset,
        _comment_length,
    ) = end_record
    if disk_number or central_directory_disk or entries_on_disk != entry_count:
        raise BadZipFile("Multi-disk ZIP archives are not supported")
    if (
        entry_count == ZIP64_SENTINEL_16
        or central_directory_size == ZIP64_SENTINEL_32
        or central_directory_offset == ZIP64_SENTINEL_32
    ):
        raise ValueError("ZIP64 archives exceed the supported resource profile")
    if entry_count > limits.member_count:
        raise ValueError(
            f"ZIP archive contains {entry_count} entries; limit is "
            f"{limits.member_count}"
        )
    if central_directory_size > limits.central_directory_bytes:
        raise ValueError(
            "ZIP central directory exceeds the "
            f"{limits.central_directory_bytes}-byte limit"
        )


def _validated_shapefiles(
    archive: ZipFile,
    limits: ZipResourceLimits,
) -> tuple[ArchivedShapefile, ...]:
    """Validate members and group internal Shapefile components.

    Args:
        archive: Open ZIP archive whose central directory was preflighted.
        limits: Resource ceilings applied to declared member sizes.

    Returns:
        Internal Shapefiles ordered by their normalized POSIX `.shp` paths.

    Raises:
        ValueError: If an entry is unsafe, ambiguous, encrypted, unsupported,
            or exceeds a resource ceiling.
    """
    members = archive.infolist()
    if len(members) > limits.member_count:
        raise ValueError(
            f"ZIP archive contains {len(members)} entries; limit is "
            f"{limits.member_count}"
        )

    normalized_member_names: set[str] = set()
    total_uncompressed_bytes = 0
    components_by_group: dict[
        tuple[PurePosixPath, str],
        list[tuple[str, PurePosixPath]],
    ] = {}
    for member in members:
        member_path = _validated_member_path(member)
        casefolded_member_name = member_path.as_posix().casefold()
        if casefolded_member_name in normalized_member_names:
            raise ValueError(
                f"ZIP archive has duplicate or case-ambiguous entry: {member.filename}"
            )
        normalized_member_names.add(casefolded_member_name)
        if member.is_dir():
            continue
        if member.extract_version >= 45:
            raise ValueError(
                f"ZIP64 entry exceeds the supported resource profile: "
                f"{member.filename}"
            )
        _validate_member_resource_use(member, limits)
        total_uncompressed_bytes += member.file_size
        if total_uncompressed_bytes > limits.total_uncompressed_bytes:
            raise ValueError(
                "ZIP members exceed the "
                f"{limits.total_uncompressed_bytes}-byte total uncompressed limit"
            )

        component_extension = _component_extension(member_path.name)
        if component_extension is None:
            continue
        component_stem = member_path.name[: -len(component_extension)]
        group_key = member_path.parent, component_stem
        components_by_group.setdefault(group_key, []).append((
            component_extension,
            member_path,
        ))

    shapefiles: list[ArchivedShapefile] = []
    for components in components_by_group.values():
        shapefile_paths = [
            member_path
            for extension, member_path in components
            if extension == ".shp"
        ]
        if shapefile_paths:
            shapefiles.append(ArchivedShapefile(
                shapefile_path=min(
                    shapefile_paths,
                    key=lambda path: path.as_posix(),
                ),
                components=tuple(sorted(
                    components,
                    key=lambda component: component[1].as_posix(),
                )),
            ))
    return tuple(sorted(
        shapefiles,
        key=lambda dataset: dataset.shapefile_path.as_posix(),
    ))


def _validated_member_path(member: ZipInfo) -> PurePosixPath:
    """Return one safe, deterministic archive member path.

    Args:
        member: ZIP central-directory entry to validate.

    Returns:
        Relative POSIX path preserved exactly from the ZIP directory.

    Raises:
        ValueError: If the name is absolute, traversing, empty, ambiguous on
            Windows, a symbolic link, or otherwise unsafe for GDAL access.
    """
    member_name = member.orig_filename
    if (
        not member_name
        or "\x00" in member_name
        or any(
            ord(character) < 32 or ord(character) == 127
            for character in member_name
        )
    ):
        raise ValueError("ZIP archive contains an empty or control-containing path")
    if "\\" in member_name:
        raise ValueError(f"ZIP entry uses ambiguous backslashes: {member_name}")
    is_directory = member_name.endswith("/")
    path_text = member_name[:-1] if is_directory else member_name
    raw_parts = path_text.split("/")
    if (
        not path_text
        or member_name.startswith("/")
        or any(part in {"", ".", ".."} for part in raw_parts)
        or ":" in raw_parts[0]
    ):
        raise ValueError(f"ZIP entry is not a safe relative path: {member_name}")
    unix_mode = member.external_attr >> 16
    if stat.S_ISLNK(unix_mode):
        raise ValueError(f"ZIP symbolic-link entries are not supported: {member_name}")
    return PurePosixPath(*raw_parts)


def _validate_member_resource_use(
    member: ZipInfo,
    limits: ZipResourceLimits,
) -> None:
    """Reject encrypted, unsupported, or oversized ZIP members.

    Args:
        member: Non-directory archive member to inspect.
        limits: Per-member size and compression-ratio ceilings.

    Raises:
        ValueError: If the member violates the supported resource profile.
    """
    if member.flag_bits & 0x1:
        raise ValueError(f"Encrypted ZIP entry is not supported: {member.filename}")
    if member.compress_type not in {ZIP_STORED, ZIP_DEFLATED}:
        raise ValueError(
            f"ZIP entry uses unsupported compression method: {member.filename}"
        )
    if member.file_size > limits.member_uncompressed_bytes:
        raise ValueError(
            f"ZIP entry exceeds the {limits.member_uncompressed_bytes}-byte "
            f"uncompressed limit: {member.filename}"
        )
    if member.file_size and not member.compress_size:
        raise ValueError(
            f"ZIP entry declares uncompressed data with no compressed bytes: "
            f"{member.filename}"
        )
    if member.compress_size:
        compression_ratio = member.file_size / member.compress_size
        if compression_ratio > limits.compression_ratio:
            raise ValueError(
                f"ZIP entry compression ratio {compression_ratio:.1f} exceeds "
                f"the {limits.compression_ratio:g} limit: {member.filename}"
            )


def _build_stac_item(
    source_root: Path,
    archive_path: Path,
    relative_archive_path: Path,
    archive_modified_at: datetime,
    archived_shapefile: ArchivedShapefile,
) -> dict[str, Any]:
    """Build one vector Item by opening an internal Shapefile directly.

    Args:
        source_root: Root directory mounted for scanning.
        archive_path: Mounted ZIP archive containing the dataset.
        relative_archive_path: Archive location relative to the mount.
        archive_modified_at: Filesystem modification timestamp of the archive.
        archived_shapefile: Validated internal component group to inspect.

    Returns:
        A STAC Item with projection, table, and archive Asset metadata.

    Raises:
        ValueError: If components, CRS, geometry, or bounds violate the vector
            catalog contract.
        fiona.errors.FionaError: If GDAL cannot open or inspect the dataset.
    """
    del source_root
    components: dict[str, PurePosixPath] = {}
    for extension, component_path in archived_shapefile.components:
        if extension in components:
            raise ValueError(
                "Shapefile has duplicate components for "
                f"{extension}: {components[extension].name}, {component_path.name}"
            )
        components[extension] = component_path
    missing_extensions = REQUIRED_COMPONENT_EXTENSIONS - components.keys()
    if missing_extensions:
        missing_list = ", ".join(sorted(missing_extensions))
        raise ValueError(f"Shapefile is missing required components: {missing_list}")

    archive_modified_at_text = archive_modified_at.isoformat().replace(
        "+00:00",
        "Z",
    )
    dataset_path = _gdal_zip_member_path(
        archive_path,
        archived_shapefile.shapefile_path,
    )
    with fiona.open(
        dataset_path,
        enabled_drivers=["ESRI Shapefile"],
    ) as dataset:
        if not dataset.crs:
            raise ValueError("Shapefile has no coordinate reference system")
        feature_count = len(dataset)
        if not feature_count:
            raise ValueError(
                "Shapefile has no spatial footprint; pgSTAC requires Item geometry"
            )
        wkt2 = dataset.crs.to_wkt(version="WKT2_2019")
        geometry_type = dataset.schema["geometry"].removeprefix("3D ")
        if geometry_type not in GEOJSON_GEOMETRY_TYPES:
            raise ValueError(
                f"Shapefile has unsupported geometry type: {geometry_type}"
            )
        internal_path_text = archived_shapefile.shapefile_path.as_posix()
        relative_archive_text = relative_archive_path.as_posix()
        properties: dict[str, Any] = {
            "title": f"{relative_archive_text}!/{internal_path_text}",
            "description": FALLBACK_DATETIME_DESCRIPTION,
            "datetime": archive_modified_at_text,
            **build_vector_table_properties(
                feature_count,
                geometry_type,
                (
                    (field_name, str(field_type))
                    for field_name, field_type in dataset.schema[
                        "properties"
                    ].items()
                ),
            ),
        }
        if epsg_code := dataset.crs.to_epsg():
            properties["proj:epsg"] = epsg_code
        else:
            properties["proj:wkt2"] = wkt2

        bbox = None
        if feature_count:
            native_bbox = list(dataset.bounds)
            bbox = list(
                transform_bounds(CRS.from_wkt(wkt2), "EPSG:4326", *native_bbox)
            )
            if not all(
                math.isfinite(coordinate) for coordinate in native_bbox + bbox
            ):
                raise ValueError(
                    "Shapefile bounds could not be transformed to WGS 84"
                )
            properties["proj:bbox"] = native_bbox

    footprint = build_bbox_polygon(bbox) if bbox is not None else None
    identity_text = (
        f"{relative_archive_path.as_posix()}\x00"
        f"{archived_shapefile.shapefile_path.as_posix()}"
    )
    item_identifier = hashlib.sha256(identity_text.encode("utf-8")).hexdigest()
    item: dict[str, Any] = {
        "type": "Feature",
        "stac_version": "1.0.0",
        "stac_extensions": [PROJECTION_EXTENSION, TABLE_EXTENSION],
        "id": f"zipped-shapefile-{item_identifier[:24]}",
        "collection": MOUNTED_VECTOR_COLLECTION_ID,
        "geometry": footprint,
        "properties": properties,
        "links": [],
        "assets": {
            "archive": {
                "href": archive_path.resolve().as_uri(),
                "type": ZIP_MEDIA_TYPE,
                "title": relative_archive_path.as_posix(),
                "roles": ["data"],
                "updated": archive_modified_at_text,
            },
        },
    }
    if bbox is not None:
        item["bbox"] = bbox
    return item


def _archive_signature(archive_path: Path) -> ArchiveSignature:
    """Read the stable filesystem fields used around archive inspection.

    Args:
        archive_path: Mounted archive to identify.

    Returns:
        Device, inode, size, and nanosecond modification time.

    Raises:
        OSError: If the archive is absent, unreadable, or not a regular file.
    """
    archive_status = archive_path.lstat()
    if not stat.S_ISREG(archive_status.st_mode):
        raise OSError("ZIP dataset is not a mounted regular file")
    return ArchiveSignature(
        device=archive_status.st_dev,
        inode=archive_status.st_ino,
        size=archive_status.st_size,
        modified_nanoseconds=archive_status.st_mtime_ns,
    )


def _gdal_zip_member_path(
    archive_path: Path,
    member_path: PurePosixPath,
) -> str:
    """Build an explicit GDAL `/vsizip/` member path.

    Args:
        archive_path: Mounted archive on the local filesystem.
        member_path: Validated relative POSIX member path.

    Returns:
        Cross-platform GDAL virtual-filesystem path with an explicit archive
        boundary.
    """
    mounted_archive_path = archive_path.resolve().as_posix()
    return f"/vsizip/{{{mounted_archive_path}}}/{member_path.as_posix()}"


def _component_extension(file_name: str) -> str | None:
    """Return a recognized internal Shapefile component extension.

    Args:
        file_name: Final path segment of an archive member.

    Returns:
        Canonical lower-case extension, or ``None`` for unrelated members.
    """
    lower_file_name = file_name.lower()
    for extension in SHAPEFILE_COMPONENT_TYPES:
        if lower_file_name.endswith(extension):
            return extension
    return None
