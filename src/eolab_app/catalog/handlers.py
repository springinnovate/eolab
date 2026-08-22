"""Explicit dataset-handler registry for mounted catalog sources."""

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from eolab_app.catalog.filegeodatabase import (
    build_stac_items as build_file_geodatabase_stac_items,
    discover_file_geodatabases,
)
from eolab_app.catalog.geotiff import build_stac_item as build_geotiff_stac_item
from eolab_app.catalog.models import DatasetCandidate
from eolab_app.catalog.shapefile import (
    build_stac_item as build_shapefile_stac_item,
    discover_shapefile_datasets,
)


DatasetItem = dict[str, Any]


@dataclass(frozen=True)
class DatasetMatch:
    """One dataset recognized by a handler during directory discovery.

    Attributes:
        path: Primary file or container directory for the dataset.
        component_paths: Companion paths owned by the same logical dataset.
    """

    path: Path
    component_paths: tuple[Path, ...] = ()


@dataclass(frozen=True)
class HandlerDiscovery:
    """One handler's candidates and directory-pruning decisions.

    Attributes:
        matches: Logical datasets recognized in the current directory.
        pruned_directory_names: Child directory names claimed as datasets whose
            descendants must not be independently discovered.
    """

    matches: tuple[DatasetMatch, ...] = ()
    pruned_directory_names: frozenset[str] = frozenset()


DatasetDiscoverer = Callable[
    [Path, tuple[str, ...], tuple[str, ...]],
    HandlerDiscovery,
]
DatasetItemBuilder = Callable[
    [Path, DatasetCandidate],
    tuple[DatasetItem, ...],
]


@dataclass(frozen=True)
class DatasetHandler:
    """Typed discovery and metadata operations for one dataset format.

    Attributes:
        name: Stable registry key stored on discovered candidates.
        discover: Recognizes datasets in one already-listed directory.
        build_items: Extracts zero or more STAC Items from one candidate.
    """

    name: str
    discover: DatasetDiscoverer
    build_items: DatasetItemBuilder


@dataclass(frozen=True)
class DatasetHandlerRegistry:
    """Ordered, explicit set of mounted dataset handlers.

    Attributes:
        handlers: Handlers in deterministic discovery precedence order.
    """

    handlers: tuple[DatasetHandler, ...]

    def __post_init__(self) -> None:
        """Validate names used for candidate-to-handler dispatch.

        Raises:
            ValueError: If the registry is empty or contains a blank or
                duplicate handler name.
        """
        if not self.handlers:
            raise ValueError("Dataset handler registry cannot be empty")
        handler_names = [handler.name for handler in self.handlers]
        if any(not name for name in handler_names):
            raise ValueError("Dataset handler names cannot be blank")
        if len(set(handler_names)) != len(handler_names):
            raise ValueError("Dataset handler names must be unique")

    def discover_directory(
        self,
        directory_path: Path,
        directory_names: tuple[str, ...],
        file_names: tuple[str, ...],
    ) -> tuple[list[DatasetCandidate], frozenset[str]]:
        """Run every handler against one deterministic directory listing.

        Args:
            directory_path: Directory currently visited by the filesystem walk.
            directory_names: Sorted child directory names.
            file_names: Sorted child file names.

        Returns:
            Recognized candidates and child directory names to prune.

        Raises:
            ValueError: If handlers claim an unknown child directory or the
                same primary dataset path more than once.
        """
        candidates: list[DatasetCandidate] = []
        pruned_directory_names: set[str] = set()
        listed_directory_names = set(directory_names)
        candidate_paths: set[Path] = set()
        for handler in self.handlers:
            discovery = handler.discover(
                directory_path,
                directory_names,
                file_names,
            )
            unknown_pruned_names = (
                discovery.pruned_directory_names - listed_directory_names
            )
            if unknown_pruned_names:
                unknown_names = ", ".join(sorted(unknown_pruned_names))
                raise ValueError(
                    f"Handler {handler.name!r} pruned unlisted directories: "
                    f"{unknown_names}"
                )
            pruned_directory_names.update(discovery.pruned_directory_names)
            for match in discovery.matches:
                if match.path in candidate_paths:
                    raise ValueError(
                        f"Multiple dataset handlers claimed {match.path}"
                    )
                candidate_paths.add(match.path)
                candidates.append(DatasetCandidate(
                    path=match.path,
                    handler_name=handler.name,
                    component_paths=match.component_paths,
                ))
        return candidates, frozenset(pruned_directory_names)

    def build_items(
        self,
        source_root: Path,
        candidate: DatasetCandidate,
    ) -> tuple[DatasetItem, ...]:
        """Dispatch metadata extraction through the candidate's handler key.

        Args:
            source_root: Root directory mounted for scanning.
            candidate: Dataset previously recognized by this registry.

        Returns:
            Zero or more complete STAC Items for the source dataset.

        Raises:
            KeyError: If the candidate names a handler outside the registry.
            Exception: Propagates format-specific metadata failures.
        """
        for handler in self.handlers:
            if handler.name == candidate.handler_name:
                return handler.build_items(source_root, candidate)
        raise KeyError(f"Unknown dataset handler: {candidate.handler_name}")


def discover_geotiff_datasets(
    directory_path: Path,
    directory_names: tuple[str, ...],
    file_names: tuple[str, ...],
) -> HandlerDiscovery:
    """Recognize single-file GeoTIFF datasets in one directory.

    Args:
        directory_path: Directory containing the listed entries.
        directory_names: Sorted child directory names, unused by this handler.
        file_names: Sorted child file names.

    Returns:
        GeoTIFF file matches without directory pruning.
    """
    del directory_names
    return HandlerDiscovery(matches=tuple(
        DatasetMatch(directory_path / file_name)
        for file_name in file_names
        if Path(file_name).suffix.lower() in {".tif", ".tiff"}
    ))


def build_geotiff_items(
    source_root: Path,
    candidate: DatasetCandidate,
) -> tuple[DatasetItem, ...]:
    """Build the single Item represented by a mounted GeoTIFF.

    Args:
        source_root: Root directory mounted for scanning.
        candidate: GeoTIFF candidate selected during discovery.

    Returns:
        A one-Item tuple preserving the existing GeoTIFF representation.

    Raises:
        Exception: Propagates GeoTIFF metadata failures.
    """
    return (build_geotiff_stac_item(source_root, candidate.path),)


def discover_mounted_shapefiles(
    directory_path: Path,
    directory_names: tuple[str, ...],
    file_names: tuple[str, ...],
) -> HandlerDiscovery:
    """Recognize Shapefiles and group their same-directory components.

    Args:
        directory_path: Directory containing the listed entries.
        directory_names: Sorted child directory names, unused by this handler.
        file_names: Sorted child file names.

    Returns:
        One match per Shapefile primary with all recognized components.
    """
    del directory_names
    return HandlerDiscovery(matches=tuple(
        DatasetMatch(shapefile_path, component_paths)
        for shapefile_path, component_paths in discover_shapefile_datasets(
            directory_path,
            list(file_names),
        )
    ))


def build_shapefile_items(
    source_root: Path,
    candidate: DatasetCandidate,
) -> tuple[DatasetItem, ...]:
    """Build the single Item represented by a mounted Shapefile.

    Args:
        source_root: Root directory mounted for scanning.
        candidate: Shapefile primary and grouped companion paths.

    Returns:
        A one-Item tuple preserving the existing Shapefile representation.

    Raises:
        Exception: Propagates Shapefile metadata failures.
    """
    return (build_shapefile_stac_item(
        source_root,
        candidate.path,
        candidate.component_paths,
    ),)


def discover_mounted_file_geodatabases(
    directory_path: Path,
    directory_names: tuple[str, ...],
    file_names: tuple[str, ...],
) -> HandlerDiscovery:
    """Recognize File Geodatabase containers and prune their descendants.

    Args:
        directory_path: Directory containing the listed entries.
        directory_names: Sorted child directory names.
        file_names: Sorted child file names, unused by this handler.

    Returns:
        One match per `.gdb` container and matching pruning decisions.
    """
    del file_names
    geodatabase_paths = discover_file_geodatabases(
        directory_path,
        directory_names,
    )
    geodatabase_names = frozenset(
        geodatabase_path.name for geodatabase_path in geodatabase_paths
    )
    return HandlerDiscovery(
        matches=tuple(
            DatasetMatch(geodatabase_path)
            for geodatabase_path in geodatabase_paths
        ),
        pruned_directory_names=geodatabase_names,
    )


def build_file_geodatabase_items(
    source_root: Path,
    candidate: DatasetCandidate,
) -> tuple[DatasetItem, ...]:
    """Build one Item per readable spatial layer in a File Geodatabase.

    Args:
        source_root: Root directory mounted for scanning.
        candidate: File Geodatabase container selected during discovery.

    Returns:
        Zero or more spatial feature-class Items.

    Raises:
        Exception: Propagates geodatabase-level metadata failures and the first
            layer failure when no layer can produce an Item.
    """
    return build_file_geodatabase_stac_items(source_root, candidate.path)


def create_default_dataset_handler_registry() -> DatasetHandlerRegistry:
    """Create the explicit registry for currently supported mounted formats.

    Returns:
        Registry containing GeoTIFF, mounted Shapefile, and File Geodatabase
        handlers.
    """
    return DatasetHandlerRegistry(handlers=(
        DatasetHandler(
            name="geotiff",
            discover=discover_geotiff_datasets,
            build_items=build_geotiff_items,
        ),
        DatasetHandler(
            name="shapefile",
            discover=discover_mounted_shapefiles,
            build_items=build_shapefile_items,
        ),
        DatasetHandler(
            name="file-geodatabase",
            discover=discover_mounted_file_geodatabases,
            build_items=build_file_geodatabase_items,
        ),
    ))
