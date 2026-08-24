"""Resolve exact catalog vector source identities inside the scan mount."""

from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import unquote, urlsplit

from eolab_app.catalog.filegeodatabase import FILE_GEODATABASE_MEDIA_TYPE
from eolab_app.catalog.geojson import GEOJSON_MEDIA_TYPE
from eolab_app.catalog.geopackage import (
    GEOPACKAGE_LAYER_PROPERTY,
    GEOPACKAGE_MEDIA_TYPE,
)
from eolab_app.catalog.shapefile import (
    REQUIRED_COMPONENT_EXTENSIONS,
    SHAPEFILE_COMPONENT_TYPES,
)
from eolab_app.catalog.zipped_shapefile import ZIP_MEDIA_TYPE
from eolab_app.catalog.vector import MOUNTED_VECTOR_COLLECTION_ID
from eolab_app.vector.errors import (
    VectorAssetError,
    VectorConflictError,
)
from eolab_app.vector.models import (
    ResolvedVectorSource,
    VECTOR_SOURCE_METADATA_KEY,
    VectorFormat,
    VectorSourceSignature,
)


_FORMAT_ITEM_PREFIXES: dict[VectorFormat, str] = {
    "shapefile": "shapefile-",
    "geopackage": "geopackage-",
    "geojson": "geojson-",
    "zipped-shapefile": "zipped-shapefile-",
    "file-geodatabase": "file-geodatabase-",
}
_FORMAT_ASSET_CONTRACTS: dict[VectorFormat, tuple[str, str]] = {
    "shapefile": ("shp", SHAPEFILE_COMPONENT_TYPES[".shp"]),
    "geopackage": ("data", GEOPACKAGE_MEDIA_TYPE),
    "geojson": ("data", GEOJSON_MEDIA_TYPE),
    "zipped-shapefile": ("archive", ZIP_MEDIA_TYPE),
    "file-geodatabase": ("data", FILE_GEODATABASE_MEDIA_TYPE),
}


def vector_source_signature(source: ResolvedVectorSource) -> VectorSourceSignature:
    """Identify the complete mounted source used by one vector assessment.

    Args:
        source: Resolved mounted source with exact Shapefile components when
            applicable.

    Returns:
        Deterministically ordered relative names and filesystem identity fields.

    Raises:
        OSError: If a source path cannot be inspected.
        ValueError: If a remote source is supplied.
    """
    if source.source_path is None:
        raise ValueError("Remote vector sources have no mounted signature")
    paths = source.component_paths or (source.source_path,)
    signature_entries = []
    base_path = source.source_path.parent
    for path in sorted(paths, key=lambda candidate: candidate.name.lower()):
        status = path.stat()
        signature_entries.append((
            path.relative_to(base_path).as_posix(),
            status.st_dev,
            status.st_ino,
            status.st_size,
            status.st_mtime_ns,
            status.st_ctime_ns,
        ))
    return tuple(signature_entries)


class MountedVectorResolver:
    """Resolve scanner-owned vector Assets without guessing a container layer."""

    def __init__(self, scan_mount_path: Path) -> None:
        """Create a resolver confined to the shared read-only mount.

        Args:
            scan_mount_path: Root shared by scanner, application, and GeoServer.
        """
        self._scan_mount_path = scan_mount_path

    def resolve(self, item: dict[str, Any]) -> ResolvedVectorSource:
        """Resolve one authoritative vector Item to its explicit source identity.

        Current Items use ``eolab:vector_source``. Legacy scanner Items are
        upgraded only when their Item prefix, Asset key, media type, and exact
        format-specific layer metadata agree. A non-file Asset is classified
        as remote and is never interpreted as a mounted path.

        Args:
            item: Authoritative vector STAC Item.

        Returns:
            Exact source kind, format, mounted path, and native layer identity.

        Raises:
            VectorAssetError: If source, format, Asset, or layer identity is
                missing, contradictory, or outside the scan mount.
            VectorConflictError: If a formerly mounted source is unavailable.
        """
        if item.get("collection") != MOUNTED_VECTOR_COLLECTION_ID:
            raise VectorAssetError("The Item is not a mounted vector dataset")
        source_format, asset_key, layer_name, declared_kind = (
            self._source_contract(item)
        )
        assets = item.get("assets")
        asset = assets.get(asset_key) if isinstance(assets, dict) else None
        expected_media_type = _FORMAT_ASSET_CONTRACTS[source_format][1]
        if (
            not isinstance(asset, dict)
            or asset.get("type") != expected_media_type
            or asset.get("roles") != ["data"]
            or not isinstance(asset.get("href"), str)
        ):
            raise VectorAssetError(
                f"The Item has no exact {source_format} data Asset"
            )

        asset_uri = urlsplit(asset["href"])
        if asset_uri.scheme != "file":
            return ResolvedVectorSource(
                source_kind="remote",
                source_format=source_format,
                source_path=None,
                asset_key=asset_key,
                layer_name=layer_name,
            )
        if declared_kind == "remote":
            raise VectorAssetError(
                "The remote vector source contract points to a mounted Asset"
            )
        source_path = self._resolve_mounted_uri(asset["href"])
        self._validate_source_path(source_format, source_path)
        component_paths: tuple[Path, ...] = ()
        if source_format == "shapefile":
            component_paths = self._resolve_shapefile_components(item, source_path)
        return ResolvedVectorSource(
            source_kind="mounted",
            source_format=source_format,
            source_path=source_path,
            asset_key=asset_key,
            layer_name=layer_name,
            component_paths=component_paths,
        )

    def apply_contract(
        self,
        item: dict[str, Any],
        source: ResolvedVectorSource,
    ) -> None:
        """Write the normalized source-kind and container-layer contract.

        Args:
            item: Mutable authoritative STAC Item.
            source: Validated source identity to persist.
        """
        properties = item.setdefault("properties", {})
        properties[VECTOR_SOURCE_METADATA_KEY] = {
            "kind": source.source_kind,
            "format": source.source_format,
            "asset_key": source.asset_key,
            "layer_name": source.layer_name,
        }

    def _source_contract(
        self,
        item: dict[str, Any],
    ) -> tuple[VectorFormat, str, str | None, str | None]:
        """Read or narrowly derive an Item's exact format contract.

        Args:
            item: Authoritative vector STAC Item.

        Returns:
            Format, primary Asset key, exact native layer name, and declared
            source kind when the Item already carries the normalized contract.

        Raises:
            VectorAssetError: If the explicit or legacy identity is invalid.
        """
        properties = item.get("properties")
        metadata = (
            properties.get(VECTOR_SOURCE_METADATA_KEY)
            if isinstance(properties, dict)
            else None
        )
        if metadata is not None:
            if not isinstance(metadata, dict) or set(metadata) != {
                "kind", "format", "asset_key", "layer_name"
            }:
                raise VectorAssetError("The vector source contract is invalid")
            source_format = metadata.get("format")
            if (
                metadata.get("kind") not in {"mounted", "remote"}
                or source_format not in _FORMAT_ASSET_CONTRACTS
            ):
                raise VectorAssetError("The vector source contract is invalid")
            expected_asset_key = _FORMAT_ASSET_CONTRACTS[source_format][0]
            if metadata.get("asset_key") != expected_asset_key:
                raise VectorAssetError("The vector source Asset identity conflicts")
            layer_name = metadata.get("layer_name")
            if layer_name is not None and (
                not isinstance(layer_name, str) or not layer_name
            ):
                raise VectorAssetError("The vector layer identity is invalid")
            return (
                source_format,
                expected_asset_key,
                layer_name,
                metadata["kind"],
            )

        item_id = item.get("id")
        if not isinstance(item_id, str):
            raise VectorAssetError("The vector Item identity is invalid")
        matching_formats = [
            source_format
            for source_format, prefix in _FORMAT_ITEM_PREFIXES.items()
            if item_id.startswith(prefix)
        ]
        if len(matching_formats) != 1:
            raise VectorAssetError("The vector source format is not explicit")
        source_format = matching_formats[0]
        asset_key = _FORMAT_ASSET_CONTRACTS[source_format][0]
        return (
            source_format,
            asset_key,
            self._legacy_layer_name(item, source_format, asset_key),
            None,
        )

    @staticmethod
    def _legacy_layer_name(
        item: dict[str, Any],
        source_format: VectorFormat,
        asset_key: str,
    ) -> str | None:
        """Recover only exact layer identities recorded by legacy handlers.

        Args:
            item: Legacy vector Item.
            source_format: Format fixed by the Item namespace.
            asset_key: Format-owned primary Asset key.

        Returns:
            Exact native layer name or ``None`` for a single-layer GeoJSON.

        Raises:
            VectorAssetError: If a multi-layer identity is absent or conflicts.
        """
        properties = item.get("properties")
        assets = item.get("assets")
        asset = assets.get(asset_key) if isinstance(assets, dict) else None
        if not isinstance(properties, dict) or not isinstance(asset, dict):
            raise VectorAssetError("The vector source identity is incomplete")
        if source_format == "geopackage":
            property_layer = properties.get(GEOPACKAGE_LAYER_PROPERTY)
            asset_layer = asset.get(GEOPACKAGE_LAYER_PROPERTY)
            if (
                not isinstance(property_layer, str)
                or not property_layer
                or property_layer != asset_layer
            ):
                raise VectorAssetError("The GeoPackage layer identity is invalid")
            return property_layer
        if source_format == "file-geodatabase":
            property_layer = properties.get("eolab:layer_name")
            asset_layer = asset.get("eolab:layer_name")
            if (
                not isinstance(property_layer, str)
                or not property_layer
                or property_layer != asset_layer
            ):
                raise VectorAssetError(
                    "The File Geodatabase layer identity is invalid"
                )
            return property_layer
        if source_format == "zipped-shapefile":
            explicit_layer = properties.get("eolab:archive_member")
            if isinstance(explicit_layer, str) and explicit_layer:
                return explicit_layer
            title = properties.get("title")
            archive_title = asset.get("title")
            prefix = f"{archive_title}!/"
            if (
                isinstance(title, str)
                and isinstance(archive_title, str)
                and title.startswith(prefix)
                and len(title) > len(prefix)
            ):
                return title[len(prefix):]
            raise VectorAssetError(
                "The zipped Shapefile member identity is missing"
            )
        if source_format == "shapefile":
            href = asset.get("href")
            if not isinstance(href, str):
                raise VectorAssetError("The Shapefile layer identity is invalid")
            return PurePosixPath(unquote(urlsplit(href).path)).stem
        return None

    def _resolve_mounted_uri(self, asset_href: str) -> Path:
        """Resolve one file URI below the configured scan mount.

        Args:
            asset_href: Authoritative scanner-owned Asset URI.

        Returns:
            Canonical existing mounted path.

        Raises:
            VectorAssetError: If the URI escapes the mount.
            VectorConflictError: If the path no longer exists.
        """
        asset_uri = urlsplit(asset_href)
        mount_uri = urlsplit(self._scan_mount_path.resolve().as_uri())
        mount_uri_path = unquote(mount_uri.path).rstrip("/")
        asset_uri_path = unquote(asset_uri.path)
        if (
            asset_uri.scheme != "file"
            or asset_uri.netloc != mount_uri.netloc
            or asset_uri.query
            or asset_uri.fragment
            or not asset_uri_path.startswith(f"{mount_uri_path}/")
        ):
            raise VectorAssetError(
                "The vector Asset is outside the mounted scan source"
            )
        relative_path = Path(asset_uri_path[len(mount_uri_path) + 1:])
        try:
            source_path = (self._scan_mount_path / relative_path).resolve(
                strict=True
            )
        except OSError as error:
            raise VectorConflictError(
                "The cataloged vector source is no longer available"
            ) from error
        if not source_path.is_relative_to(self._scan_mount_path.resolve()):
            raise VectorAssetError(
                "The vector Asset is outside the mounted scan source"
            )
        return source_path

    @staticmethod
    def _validate_source_path(
        source_format: VectorFormat,
        source_path: Path,
    ) -> None:
        """Require a path shape matching its explicit vector format.

        Args:
            source_format: Format declared by the Item contract.
            source_path: Canonical mounted source path.

        Raises:
            VectorAssetError: If file/directory shape or suffix conflicts.
        """
        suffixes = {
            "shapefile": ".shp",
            "geopackage": ".gpkg",
            "geojson": ".geojson",
            "zipped-shapefile": ".zip",
        }
        if source_format == "file-geodatabase":
            valid = source_path.is_dir() and source_path.suffix.lower() == ".gdb"
        else:
            valid = (
                source_path.is_file()
                and source_path.suffix.lower() == suffixes[source_format]
            )
        if not valid:
            raise VectorAssetError(
                f"The mounted source does not match {source_format}"
            )

    def _resolve_shapefile_components(
        self,
        item: dict[str, Any],
        shapefile_path: Path,
    ) -> tuple[Path, ...]:
        """Resolve every recorded Shapefile component without globbing.

        Args:
            item: Authoritative Shapefile Item.
            shapefile_path: Canonical primary `.shp` path.

        Returns:
            Deterministically ordered canonical component paths.

        Raises:
            VectorAssetError: If required components are absent, ambiguous, or
                do not share the primary file's exact directory and stem.
        """
        assets = item.get("assets")
        if not isinstance(assets, dict):
            raise VectorAssetError("The Shapefile component Assets are missing")
        paths: dict[str, Path] = {}
        for extension in SHAPEFILE_COMPONENT_TYPES:
            asset_key = extension.removeprefix(".").replace(".", "_")
            asset = assets.get(asset_key)
            if asset is None:
                continue
            if (
                not isinstance(asset, dict)
                or asset.get("type") != SHAPEFILE_COMPONENT_TYPES[extension]
                or not isinstance(asset.get("href"), str)
            ):
                raise VectorAssetError("A Shapefile component Asset is invalid")
            path = self._resolve_mounted_uri(asset["href"])
            if (
                not path.is_file()
                or path.parent != shapefile_path.parent
                or path.name[: -len(extension)].casefold()
                != shapefile_path.stem.casefold()
            ):
                raise VectorAssetError(
                    "Shapefile components do not share one dataset identity"
                )
            paths[extension] = path
        missing = REQUIRED_COMPONENT_EXTENSIONS - paths.keys()
        if missing:
            raise VectorAssetError(
                "The Shapefile is missing required component Assets"
            )
        return tuple(paths[extension] for extension in SHAPEFILE_COMPONENT_TYPES
                     if extension in paths)
