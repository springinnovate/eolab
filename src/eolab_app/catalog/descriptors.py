"""Admit sidecar metadata while reusing ordinary source Item builders.

Discovery prepares descriptors and resolves their source associations before any
payload reader runs. These helpers preserve native spatial Item identities and
keep author annotations separate from physical reader metadata.
"""

from collections.abc import Callable
from copy import deepcopy
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
import stat
from typing import Any, cast
from urllib.parse import urlsplit

from eolab_app.catalog.descriptor_contract import (
    ASSET_ACCESS_KEY,
    DESCRIPTOR_ID_KEY,
    NONSPATIAL_COLLECTION_ID,
    CatalogDescriptor,
    LocalAsset,
    assets_for_item,
    catalog_asset_href,
    metadata_for_item,
    parse_catalog_descriptor,
    public_asset_fields,
    public_metadata_fields,
    public_temporal_fields,
)
from eolab_app.catalog.models import DatasetCandidate, DescriptorSource
from eolab_app.catalog.asset_access import ASSET_SOURCE_KEY

DESCRIPTOR_SOURCE_KEY = "eolab:descriptor-source"
DESCRIPTOR_HANDLER_NAME = "eolab-sidecar"
SourceBuilder = Callable[[Path, DatasetCandidate], tuple[dict[str, Any], ...]]


class DescriptorAdmissionError(ValueError):
    """Reject Asset admission while preserving the readable source associations."""

    def __init__(self, message: str, claimed_paths: tuple[Path, ...]) -> None:
        """Keep confined claims available to suppress unsafe ordinary fallback.

        Args:
            message: Actionable Asset validation failure without absolute paths.
            claimed_paths: Safely resolved local references decoded from valid YAML.
        """
        super().__init__(message)
        self.claimed_paths = claimed_paths


@dataclass(frozen=True)
class PreparedDescriptor:
    """Hold validated authoring metadata and confined local Asset locations.

    Attributes:
        root: Authorized mount used to persist relocatable source associations.
        path: Descriptor file inside the source mount.
        declaration: Validated public authoring document.
        locations: Local authoring path strings mapped to admitted absolute paths.
    """

    root: Path
    path: Path
    declaration: CatalogDescriptor
    locations: dict[str, Path]

    @property
    def primary_path(self) -> Path | None:
        """Return the admitted local primary source, or None for external data.

        Returns:
            Primary filesystem path without opening its payload.
        """
        asset = self.declaration.assets[self.declaration.primary_asset]
        return self.locations[asset.path] if isinstance(asset, LocalAsset) else None

    @property
    def selected_layer(self) -> str | None:
        """Return the explicitly selected layer/member, or None for all outputs.

        Returns:
            Exact reader selector, independent of Item display titles.
        """
        source = self.declaration.source
        return (source.layer or source.member) if source is not None else None


@dataclass(frozen=True)
class DescriptorDataset:
    """Group descriptors sharing one source reader invocation.

    Attributes:
        descriptors: Nonconflicting declarations for one primary source.
        source_candidate: Ordinary reader input, absent for nonspatial data.
        source_builder: Existing handler's Item builder, absent for nonspatial data.
    """

    descriptors: tuple[PreparedDescriptor, ...]
    source_candidate: DatasetCandidate | None
    source_builder: SourceBuilder | None


def source_path_from_relative(source_root: Path, relative_path: str) -> Path:
    """Resolve persisted source ownership against the currently configured mount.

    Args:
        source_root: Authorized mounted source root.
        relative_path: POSIX mount-relative location retained at admission.

    Returns:
        Confined source path, including a presently absent file. Relative
        ownership survives moving the whole source mount between instances.

    Raises:
        ValueError: If persisted ownership is absolute, ambiguous or escapes the mount.
        OSError: If filesystem resolution fails for reasons other than absence.
    """
    relative = PurePosixPath(relative_path)
    if (
        not relative_path
        or not relative.parts
        or relative.is_absolute()
        or ".." in relative.parts
        or "\\" in relative_path
        or ":" in relative_path
        or relative.as_posix() != relative_path
    ):
        raise ValueError("Catalog source location is not a canonical relative path")
    mount = source_root.resolve()
    path = (mount / relative_path).resolve()
    if not path.is_relative_to(mount):
        raise ValueError("Catalog source location escapes the configured mount")
    return path


def prepare_descriptor(source_root: Path, path: Path) -> PreparedDescriptor:
    """Read a descriptor and validate local Asset existence and confinement.

    Args:
        source_root: Authorized mounted source root.
        path: Recognized sidecar file.

    Returns:
        Validated metadata and resolved locations, without reading any payload.

    Raises:
        OSError: If the descriptor or an Asset cannot be inspected.
        ValueError: If authoring data, source types or confinement are invalid.
        yaml.YAMLError: If the descriptor is malformed YAML.
    """
    root = source_root.resolve()
    descriptor_path = path.resolve(strict=True)
    if not descriptor_path.is_relative_to(root):
        raise ValueError("Descriptor escapes the configured source mount")
    declaration = parse_catalog_descriptor(descriptor_path.read_text(encoding="utf-8"))
    locations: dict[str, Path] = {}
    failures: list[str] = []
    assets = list(declaration.assets.items())
    for override in declaration.item_overrides.values():
        assets.extend(override.assets.items())
    for key, asset in assets:
        if not isinstance(asset, LocalAsset):
            continue
        try:
            resolved = (descriptor_path.parent / asset.path).resolve()
            if not resolved.is_relative_to(root):
                failures.append(f"Asset {key!r} escapes the configured source mount")
                continue
            # Remember readable associations before checking file availability.
            # Missing support must not cause its valid primary to be admitted bare.
            locations[asset.path] = resolved
            status = resolved.stat()
            container = (
                key == declaration.primary_asset
                and declaration.source is not None
                and declaration.source.format == "file-geodatabase"
            )
            if not (
                stat.S_ISDIR(status.st_mode)
                if container
                else stat.S_ISREG(status.st_mode)
            ):
                failures.append(f"Asset {key!r} is not the declared source type")
        except FileNotFoundError:
            failures.append(
                f"Asset {key!r} is missing; restore the file or update the descriptor"
            )
        except OSError as error:
            failures.append(
                f"Asset {key!r} cannot be inspected: {error.strerror or type(error).__name__}"
            )
    if failures:
        raise DescriptorAdmissionError("; ".join(failures), tuple(locations.values()))
    return PreparedDescriptor(root, path, declaration, locations)


def item_source_selector(item: dict[str, Any]) -> str | None:
    """Return the native layer/member identity already published by a reader.

    Args:
        item: Existing spatial reader output.

    Returns:
        Exact vector layer/member, or None for an unlayered source.
    """
    source = item["properties"].get("eolab:vector_source")
    return source["layer_name"] if source is not None else None


def build_descriptor_items(
    source_root: Path, candidate: DatasetCandidate
) -> tuple[dict[str, Any], ...]:
    """Build ordinary spatial Items or one metadata-only nonspatial Item.

    Args:
        source_root: Authorized source mount passed to the existing reader.
        candidate: Prepared sidecar group from descriptor-first discovery.

    Returns:
        Native-identity Items enriched with their matching declarations. Layers
        not selected by any declaration retain ordinary reader metadata.

    Raises:
        ValueError: If a declared selector is absent or produced identities collide.
        Exception: Propagates the existing reader's source-admission failures.
    """
    group = cast(DescriptorDataset, candidate.metadata)
    if group.source_builder is None:
        descriptor = group.descriptors[0]
        declaration = descriptor.declaration
        item = {
            "type": "Feature",
            "stac_version": "1.0.0",
            "id": declaration.id,
            "collection": NONSPATIAL_COLLECTION_ID,
            "geometry": None,
            "properties": {},
            "links": [],
            "assets": {},
        }
        return (annotate_item(item, descriptor),)
    items = group.source_builder(
        source_root, cast(DatasetCandidate, group.source_candidate)
    )
    selectors = {item_source_selector(item) for item in items}
    for descriptor in group.descriptors:
        declared_selectors = set(descriptor.declaration.item_overrides)
        if descriptor.selected_layer is not None:
            declared_selectors.add(descriptor.selected_layer)
        missing = declared_selectors - selectors
        if missing:
            raise ValueError(
                f"Source has no admitted layer/member: {', '.join(sorted(missing))}"
            )
    result = []
    identities: set[tuple[str, str]] = set()
    for item in items:
        selector = item_source_selector(item)
        selected = next(
            (
                descriptor
                for descriptor in group.descriptors
                if descriptor.selected_layer is None
                or descriptor.selected_layer == selector
            ),
            None,
        )
        if selected is not None:
            item = annotate_item(item, selected)
        identity = (item["collection"], item["id"])
        if identity in identities:
            raise ValueError("Source produced duplicate catalog Item identities")
        identities.add(identity)
        result.append(item)
    if not result:
        raise ValueError("Described source produced no catalog Items")
    return tuple(result)


def annotate_item(
    item: dict[str, Any], descriptor: PreparedDescriptor
) -> dict[str, Any]:
    """Attach curated meaning without replacing native physical source metadata.

    Args:
        item: Fresh reader Item, or the nonspatial Item shell.
        descriptor: Validated descriptor and confined local references.

    Returns:
        The same Item enriched for finalization, with private provenance. Local
        hrefs remain native until finalization; publication converts them later.
    """
    declaration = descriptor.declaration
    selector = item_source_selector(item)
    metadata = metadata_for_item(declaration, selector)
    for key in ("title", "description", "keywords", "license"):
        if key in metadata.model_fields_set and getattr(metadata, key) is None:
            item["properties"].pop(key, None)
    item["properties"].update(public_metadata_fields(metadata))
    item["properties"][DESCRIPTOR_ID_KEY] = declaration.id
    if declaration.temporal is not None:
        modified = None
        if descriptor.primary_path is not None:
            modified = datetime.fromtimestamp(
                descriptor.primary_path.stat().st_mtime, timezone.utc
            ).isoformat()
        for key in ("datetime", "start_datetime", "end_datetime"):
            item["properties"].pop(key, None)
        item["properties"].update(
            public_temporal_fields(declaration.temporal, modified_at=modified)
        )
    for key, asset in assets_for_item(declaration, selector).items():
        if key in item["assets"] and key != declaration.primary_asset:
            raise ValueError(
                f"Supporting Asset key {key!r} conflicts with a native source component"
            )
        public = public_asset_fields(asset, item["collection"], item["id"], key)
        if isinstance(asset, LocalAsset):
            public["href"] = descriptor.locations[asset.path].as_uri()
        native = item["assets"].get(key, {})
        # Native type/roles and source metadata remain authoritative for the primary.
        item["assets"][key] = {
            **public,
            **native,
            **public_metadata_fields(asset.metadata),
        }
        item["assets"][key][ASSET_ACCESS_KEY] = public[ASSET_ACCESS_KEY]
    primary = declaration.assets[declaration.primary_asset]
    primary_href = (
        descriptor.locations[primary.path].as_uri()
        if isinstance(primary, LocalAsset)
        else primary.href
    )
    ownership = DescriptorSource(
        href=descriptor.path.resolve().as_uri(),
        relative_path=descriptor.path.resolve().relative_to(descriptor.root).as_posix(),
        descriptor_id=declaration.id,
        primary_href=primary_href,
        primary_relative_path=(
            descriptor.primary_path.relative_to(descriptor.root).as_posix()
            if descriptor.primary_path is not None
            else None
        ),
        primary_asset_key=declaration.primary_asset,
        kind=declaration.kind,
        claimed_paths=tuple(
            sorted(
                path.relative_to(descriptor.root).as_posix()
                for path in set(descriptor.locations.values())
            )
        ),
        selector=selector,
    )
    item["assets"][DESCRIPTOR_SOURCE_KEY] = asdict(ownership)
    return item


def publish_descriptor_assets(item: dict[str, Any]) -> dict[str, Any]:
    """Replace described local hrefs after finalizers have inspected native sources.

    Args:
        item: Finalized Item, possibly without a sidecar.

    Returns:
        The same Item with identity-only local hrefs and private source metadata.
        Ordinary Items remain unchanged.
    """
    if DESCRIPTOR_SOURCE_KEY not in item["assets"]:
        return item
    for key, asset in item["assets"].items():
        if key == DESCRIPTOR_SOURCE_KEY:
            continue
        if urlsplit(asset["href"]).scheme == "file":
            asset[ASSET_SOURCE_KEY] = {"href": asset["href"]}
            asset["href"] = catalog_asset_href(item["collection"], item["id"], key)
            asset[ASSET_ACCESS_KEY] = {"kind": "catalog"}
    return item


def preserve_admitted_descriptor_metadata(
    rebuilt_item: dict[str, Any], admitted_item: dict[str, Any]
) -> dict[str, Any]:
    """Keep admitted study metadata when an existing reader refreshes an Item.

    Selected vector reassessment refreshes physical source and rendering facts,
    not descriptor admission. This copies the stored curated fields, supporting
    Assets and private descriptor association without reopening the YAML file.
    Native Assets keep newly read physical metadata and regain their admitted
    annotations. Publication wraps their native source hrefs after finalization.

    Args:
        rebuilt_item: Fresh format-owned Item to enrich in place.
        admitted_item: Authoritative stored Item representing the last scan.

    Returns:
        The same rebuilt Item with admitted descriptor metadata restored.
        Ordinary Items are unchanged, and the stored Item is never mutated.
    """
    admitted_assets = admitted_item["assets"]
    if DESCRIPTOR_SOURCE_KEY not in admitted_assets:
        return rebuilt_item
    admitted_properties = admitted_item["properties"]
    properties = rebuilt_item["properties"]
    curated_fields = ("eolab:metadata", "title", "description", "keywords", "license")
    for name in (*curated_fields, DESCRIPTOR_ID_KEY):
        properties.pop(name, None)
        if name in admitted_properties:
            properties[name] = deepcopy(admitted_properties[name])
    if "eolab:time_basis" in admitted_properties:
        for name in ("datetime", "start_datetime", "end_datetime", "eolab:time_basis"):
            properties.pop(name, None)
            if name in admitted_properties:
                properties[name] = deepcopy(admitted_properties[name])
    rebuilt_assets = rebuilt_item["assets"]
    for key, admitted_asset in admitted_assets.items():
        if key not in rebuilt_assets:
            rebuilt_assets[key] = deepcopy(admitted_asset)
        elif "eolab:metadata" in admitted_asset:
            native_asset = rebuilt_assets[key]
            for name in curated_fields:
                native_asset.pop(name, None)
                if name in admitted_asset:
                    native_asset[name] = deepcopy(admitted_asset[name])
    return rebuilt_item
