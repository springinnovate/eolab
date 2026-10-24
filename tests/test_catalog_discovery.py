"""Test deterministic mounted-dataset discovery."""

from dataclasses import replace
from pathlib import Path

import pytest

from eolab_app.catalog.discovery import FilesystemDatasetDiscovery
from eolab_app.catalog.handlers import (
    DatasetHandler,
    DatasetHandlerRegistry,
    DatasetMatch,
    HandlerDiscovery,
    create_default_dataset_handler_registry,
    discover_temporal_datasets,
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


def prepare_declared_item(
    source_root: Path,
    candidate: DatasetCandidate,
) -> DatasetCandidate:
    """Read a test descriptor whose entire text is its declared Item ID.

    Args:
        source_root: Mounted source root, unused by this test preparation.
        candidate: Descriptor recognized during directory discovery.

    Returns:
        Candidate carrying the declared identity and parsed text.

    Raises:
        ValueError: If the test descriptor is empty.
    """
    del source_root
    item_id = candidate.path.read_text(encoding="utf-8").strip()
    if not item_id:
        raise ValueError("The dataset descriptor is empty")
    return replace(
        candidate,
        item_key=("test-temporal", item_id),
        metadata=item_id,
    )


def declared_item_registry() -> DatasetHandlerRegistry:
    """Return a test descriptor handler followed by ordinary file handlers.

    Returns:
        Registry using production descriptor ownership with a small test parser.
    """
    return DatasetHandlerRegistry(
        handlers=(
            DatasetHandler(
                name="test-declared-item",
                discover=discover_temporal_datasets,
                build_items=build_no_test_items,
                prepare_candidate=prepare_declared_item,
            ),
            *create_default_dataset_handler_registry().handlers,
        )
    )


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


def test_descriptor_owns_siblings_and_descendants_when_admission_fails(
    tmp_path: Path,
) -> None:
    """Keep a broken descriptor's files out of ordinary format discovery.

    Args:
        tmp_path: Isolated mounted source root.
    """
    archive = tmp_path / "archive"
    nested = archive / "2000" / "01"
    nested.mkdir(parents=True)
    (archive / "dataset.yaml").write_text("", encoding="utf-8")
    (archive / "sibling.tif").touch()
    (archive / "sibling.gpkg").touch()
    (nested / "hidden.tif").touch()
    (tmp_path / "visible.tif").touch()

    candidates, errors = FilesystemDatasetDiscovery(
        tmp_path, (tmp_path,), declared_item_registry()
    ).discover()

    assert [candidate.path for candidate in candidates] == [tmp_path / "visible.tif"]
    assert errors == [
        {
            "path": "archive/dataset.yaml",
            "error": "The dataset descriptor is empty",
        }
    ]


@pytest.mark.parametrize("missing_catalog", [False, True])
def test_discovery_rejects_all_duplicate_ids_before_returning_candidates(
    tmp_path: Path,
    missing_catalog: bool,
) -> None:
    """Reject conflicting roots while preserving a unique prepared candidate.

    Args:
        tmp_path: Isolated mounted source root.
        missing_catalog: Whether the first duplicate lacks its SQLite source.
    """
    roots = tuple(tmp_path / name for name in ("one", "two", "unique"))
    for root, item_id in zip(
        roots, ("duplicate", "duplicate", "separate"), strict=True
    ):
        root.mkdir()
        (root / "dataset.yaml").write_text(
            f"id: {item_id}\ntitle: Weather\n"
            "source:\n  format: temporal_cog\n  catalog: catalog.sqlite\n",
            encoding="utf-8",
        )
        if root != roots[0] or not missing_catalog:
            (root / "catalog.sqlite").touch()

    candidates, errors = FilesystemDatasetDiscovery(
        tmp_path, roots, create_default_dataset_handler_registry()
    ).discover()

    assert len(candidates) == 1
    assert candidates[0].path == roots[2] / "dataset.yaml"
    assert candidates[0].item_key == ("eolab-temporal-datasets", "separate")
    assert errors == [
        {
            "path": f"{name}/dataset.yaml",
            "error": (
                "Multiple datasets declare the same catalog Item: "
                "eolab-temporal-datasets/duplicate"
            ),
        }
        for name in ("one", "two")
    ]
