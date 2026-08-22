"""Test deterministic mounted-dataset discovery."""

from pathlib import Path

from eolab_app.catalog.discovery import FilesystemDatasetDiscovery


def test_discovery_is_recursive_deterministic_and_multi_directory(
    tmp_path: Path,
) -> None:
    """Return supported files in one mount-relative order."""
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
