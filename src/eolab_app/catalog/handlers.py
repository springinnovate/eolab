"""Explicit dataset-handler registry for mounted catalog sources."""

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from eolab_app.catalog.filegeodatabase import (
    build_stac_items as build_file_geodatabase_stac_items,
    discover_file_geodatabases,
)
from eolab_app.catalog.geopackage import (
    build_stac_items as build_geopackage_stac_items,
    discover_geopackage_files,
)
from eolab_app.catalog.geojson import (
    build_stac_item as build_geojson_stac_item,
    discover_geojson_datasets,
)
from eolab_app.catalog.geotiff import build_stac_item as build_geotiff_stac_item
from eolab_app.catalog.models import DatasetCandidate
from eolab_app.catalog.shapefile import (
    build_stac_item as build_shapefile_stac_item,
    discover_shapefile_datasets,
)
from eolab_app.catalog.temporal import (
    build_temporal_items,
    prepare_temporal_candidate,
)
from eolab_app.catalog.zipped_shapefile import (
    build_stac_items as build_zipped_shapefile_stac_items,
)


DatasetItem = dict[str, Any]


class DatasetBuildError(RuntimeError):
    """Report a format-owned metadata failure at the registry boundary."""


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
        owns_directory: Whether this handler owns the whole current directory,
            including its sibling files and all descendants.
    """

    matches: tuple[DatasetMatch, ...] = ()
    pruned_directory_names: frozenset[str] = frozenset()
    owns_directory: bool = False


DatasetDiscoverer = Callable[
    [Path, tuple[str, ...], tuple[str, ...]],
    HandlerDiscovery,
]
DatasetItemBuilder = Callable[
    [Path, DatasetCandidate],
    tuple[DatasetItem, ...],
]
DatasetCandidatePreparer = Callable[
    [Path, DatasetCandidate],
    DatasetCandidate,
]


@dataclass(frozen=True)
class DatasetHandler:
    """Typed discovery and metadata operations for one dataset format.

    Attributes:
        name: Stable registry key stored on discovered candidates.
        discover: Recognizes datasets in one already-listed directory.
        build_items: Extracts zero or more STAC Items from one candidate.
        prepare_candidate: Optional descriptor reader that declares the Item
            identity before metadata workers and catalog writes.
    """

    name: str
    discover: DatasetDiscoverer
    build_items: DatasetItemBuilder
    prepare_candidate: DatasetCandidatePreparer | None = None


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
        """Recognize datasets, allowing an owning handler to claim a directory.

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
            if discovery.owns_directory:
                return [
                    DatasetCandidate(
                        path=match.path,
                        handler_name=handler.name,
                        component_paths=match.component_paths,
                    )
                    for match in discovery.matches
                ], frozenset(directory_names)
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

    def prepare_candidate(
        self,
        source_root: Path,
        candidate: DatasetCandidate,
    ) -> DatasetCandidate:
        """Read a dataset's declared Item identity and metadata before catalog writes.

        Args:
            source_root: Root directory mounted for scanning.
            candidate: Dataset recognized by this registry.

        Returns:
            Prepared candidate, or the original when no preparation is needed.

        Raises:
            KeyError: If the candidate names an unknown handler.
            DatasetBuildError: If the source admission metadata cannot be read.
        """
        for handler in self.handlers:
            if handler.name == candidate.handler_name:
                if handler.prepare_candidate is None:
                    return candidate
                try:
                    return handler.prepare_candidate(source_root, candidate)
                except Exception as error:
                    raise DatasetBuildError(str(error)) from error
        raise KeyError(f"Unknown dataset handler: {candidate.handler_name}")

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
            DatasetBuildError: If the selected handler cannot read metadata.
        """
        for handler in self.handlers:
            if handler.name == candidate.handler_name:
                try:
                    return handler.build_items(source_root, candidate)
                except Exception as error:
                    raise DatasetBuildError(str(error)) from error
        raise KeyError(f"Unknown dataset handler: {candidate.handler_name}")


def discover_temporal_datasets(
    directory_path: Path,
    directory_names: tuple[str, ...],
    file_names: tuple[str, ...],
) -> HandlerDiscovery:
    """Claim a dataset descriptor and everything beneath its directory.

    Args:
        directory_path: Directory containing the listed entries.
        directory_names: Sorted child directories, owned with the descriptor.
        file_names: Sorted child file names.

    Returns:
        One descriptor match when ``dataset.yaml`` exists, without reading it.
        Malformed descriptors retain ownership and fail during preparation.
    """
    del directory_names
    if "dataset.yaml" not in file_names:
        return HandlerDiscovery()
    return HandlerDiscovery(
        matches=(DatasetMatch(directory_path / "dataset.yaml"),),
        owns_directory=True,
    )


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


def discover_mounted_geopackages(
    directory_path: Path,
    directory_names: tuple[str, ...],
    file_names: tuple[str, ...],
) -> HandlerDiscovery:
    """Recognize single-file GeoPackage containers in one directory.

    Args:
        directory_path: Directory containing the listed entries.
        directory_names: Sorted child directory names, unused by this handler.
        file_names: Sorted child file names.

    Returns:
        One match per case-insensitive `.gpkg` file without directory pruning.
    """
    del directory_names
    return HandlerDiscovery(matches=tuple(
        DatasetMatch(geopackage_path)
        for geopackage_path in discover_geopackage_files(
            directory_path,
            file_names,
        )
    ))


def build_geopackage_items(
    source_root: Path,
    candidate: DatasetCandidate,
) -> tuple[DatasetItem, ...]:
    """Build one Item per spatial vector layer in a GeoPackage.

    Args:
        source_root: Root directory mounted for scanning.
        candidate: GeoPackage container selected during discovery.

    Returns:
        Zero or more Items representing catalogable spatial vector layers.

    Raises:
        Exception: Propagates container-level GeoPackage metadata failures.
    """
    return build_geopackage_stac_items(source_root, candidate.path)


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


def discover_zipped_shapefiles(
    directory_path: Path,
    directory_names: tuple[str, ...],
    file_names: tuple[str, ...],
) -> HandlerDiscovery:
    """Recognize ZIP archives as Shapefile container datasets.

    Args:
        directory_path: Directory containing the listed entries.
        directory_names: Sorted child directory names, unused by this handler.
        file_names: Sorted child file names.

    Returns:
        ZIP file matches without directory pruning.
    """
    del directory_names
    return HandlerDiscovery(matches=tuple(
        DatasetMatch(directory_path / file_name)
        for file_name in file_names
        if Path(file_name).suffix.lower() == ".zip"
    ))


def build_zipped_shapefile_items(
    source_root: Path,
    candidate: DatasetCandidate,
) -> tuple[DatasetItem, ...]:
    """Build Items represented by Shapefiles inside one mounted ZIP.

    Args:
        source_root: Root directory mounted for scanning.
        candidate: ZIP container selected during discovery.

    Returns:
        Zero or more Items, one for each valid internal Shapefile.

    Raises:
        Exception: Propagates ZIP validation and metadata failures.
    """
    return build_zipped_shapefile_stac_items(source_root, candidate.path)


def discover_geojson_feature_collections(
    directory_path: Path,
    directory_names: tuple[str, ...],
    file_names: tuple[str, ...],
) -> HandlerDiscovery:
    """Recognize GeoJSON FeatureCollection candidates in one directory.

    Args:
        directory_path: Directory containing the listed entries.
        directory_names: Sorted child directory names, unused by this handler.
        file_names: Sorted child file names.

    Returns:
        GeoJSON file matches without directory pruning.
    """
    del directory_names
    return HandlerDiscovery(matches=tuple(
        DatasetMatch(geojson_path)
        for geojson_path in discover_geojson_datasets(
            directory_path,
            file_names,
        )
    ))


def build_geojson_items(
    source_root: Path,
    candidate: DatasetCandidate,
) -> tuple[DatasetItem, ...]:
    """Build the single Item represented by a GeoJSON FeatureCollection.

    Args:
        source_root: Root directory mounted for scanning.
        candidate: GeoJSON candidate selected during discovery.

    Returns:
        A one-Item tuple containing streamed GeoJSON metadata.

    Raises:
        Exception: Propagates GeoJSON parsing and metadata failures.
    """
    return (build_geojson_stac_item(source_root, candidate.path),)


def create_default_dataset_handler_registry() -> DatasetHandlerRegistry:
    """Create the explicit registry for supported mounted formats.

    Returns:
        Registry containing temporal datasets, GeoTIFF, GeoPackage, mounted
        Shapefile, ZIP/Shapefile, GeoJSON, and File Geodatabase handlers.
    """
    return DatasetHandlerRegistry(handlers=(
        DatasetHandler(
            name="era5-ncar-zarr",
            discover=discover_temporal_datasets,
            build_items=build_temporal_items,
            prepare_candidate=prepare_temporal_candidate,
        ),
        DatasetHandler(
            name="geotiff",
            discover=discover_geotiff_datasets,
            build_items=build_geotiff_items,
        ),
        DatasetHandler(
            name="geopackage",
            discover=discover_mounted_geopackages,
            build_items=build_geopackage_items,
        ),
        DatasetHandler(
            name="shapefile",
            discover=discover_mounted_shapefiles,
            build_items=build_shapefile_items,
        ),
        DatasetHandler(
            name="zipped-shapefile",
            discover=discover_zipped_shapefiles,
            build_items=build_zipped_shapefile_items,
        ),
        DatasetHandler(
            name="geojson",
            discover=discover_geojson_feature_collections,
            build_items=build_geojson_items,
        ),
        DatasetHandler(
            name="file-geodatabase",
            discover=discover_mounted_file_geodatabases,
            build_items=build_file_geodatabase_items,
        ),
    ))
