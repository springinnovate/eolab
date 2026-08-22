"""Test deterministic mounted-dataset discovery."""

from pathlib import Path

from eolab_app.catalog.discovery import FilesystemDatasetDiscovery
from eolab_app.catalog.handlers import (
    DatasetHandler,
    DatasetHandlerRegistry,
    DatasetMatch,
    HandlerDiscovery,
    create_default_dataset_handler_registry,
)
from eolab_app.catalog.models import DatasetCandidate


def discover_container_directories(
    directory_path: Path,
    directory_names: tuple[str, ...],
    file_names: tuple[str, ...],
) -> HandlerDiscovery:
    """Recognize test container directories and prune their descendants.

    Args:
        directory_path: Directory containing the listed entries.
        directory_names: Sorted child directory names.
        file_names: Sorted child file names, unused by this handler.

    Returns:
        Container matches and the same names as pruning decisions.
    """
    del file_names
    container_names = frozenset(
        name for name in directory_names if name.lower().endswith(".container")
    )
    return HandlerDiscovery(
        matches=tuple(
            DatasetMatch(directory_path / name)
            for name in container_names
        ),
        pruned_directory_names=container_names,
    )


def build_no_test_items(
    source_root: Path,
    candidate: DatasetCandidate,
) -> tuple[dict[str, object], ...]:
    """Provide the unused metadata half of a discovery-only test handler.

    Args:
        source_root: Root directory mounted for scanning.
        candidate: Discovered test candidate.

    Returns:
        An empty Item tuple.
    """
    del source_root, candidate
    return ()


def test_discovery_is_recursive_deterministic_and_multi_directory(
    tmp_path: Path,
) -> None:
    """Return supported files in one mount-relative order.

    Args:
        tmp_path: Isolated mounted source root.
    """
    first = tmp_path / "z-source"
    second = tmp_path / "a-source"
    nested = first / "nested"
    nested.mkdir(parents=True)
    second.mkdir()
    (first / "b.tif").touch()
    (nested / "a.TIFF").touch()
    (second / "c.tif").touch()
    (second / "ignored.txt").touch()

    candidates, errors = FilesystemDatasetDiscovery(
        tmp_path,
        (first, second),
        create_default_dataset_handler_registry(),
    ).discover()

    assert errors == []
    relative_paths = [
        candidate.path.relative_to(tmp_path).as_posix()
        for candidate in candidates
    ]
    assert relative_paths == [
        "a-source/c.tif",
        "z-source/b.tif",
        "z-source/nested/a.TIFF",
    ]


def test_discovery_prunes_handler_owned_container_directories(
    tmp_path: Path,
) -> None:
    """Catalog one container without separately finding its internal files.

    Args:
        tmp_path: Isolated mounted source root.
    """
    container = tmp_path / "z-data.container"
    nested = container / "nested"
    nested.mkdir(parents=True)
    (container / "hidden.tif").touch()
    (nested / "also-hidden.shp").touch()
    (tmp_path / "visible.tif").touch()
    registry = DatasetHandlerRegistry(handlers=(
        DatasetHandler(
            name="container",
            discover=discover_container_directories,
            build_items=build_no_test_items,
        ),
        *create_default_dataset_handler_registry().handlers,
    ))

    candidates, errors = FilesystemDatasetDiscovery(
        tmp_path,
        (tmp_path,),
        registry,
    ).discover()

    assert errors == []
    assert [
        (
            candidate.path.relative_to(tmp_path).as_posix(),
            candidate.handler_name,
        )
        for candidate in candidates
    ] == [
        ("visible.tif", "geotiff"),
        ("z-data.container", "container"),
    ]
