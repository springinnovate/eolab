"""Deterministic filesystem discovery for mounted datasets."""

import os
from pathlib import Path

from eolab_app.catalog.models import DatasetCandidate, ScanError
from eolab_app.catalog.shapefile import discover_shapefile_datasets


SINGLE_FILE_DATASET_EXTENSIONS = frozenset({".tif", ".tiff"})


class FilesystemDatasetDiscovery:
    """Find supported datasets below configured scan directories."""

    def __init__(self, source_root: Path, source_paths: tuple[Path, ...]) -> None:
        """Configure filesystem discovery.

        Args:
            source_root: Root of the mounted scan source.
            source_paths: Directories below the mount to scan recursively.
        """
        self.source_root = source_root
        self.source_paths = source_paths

    def discover(self) -> tuple[list[DatasetCandidate], list[ScanError]]:
        """Find datasets without stopping on unreadable directories.

        Returns:
            Supported datasets in deterministic traversal order, together
            with directory-walk failures keyed by mount-relative path.

        Raises:
            ValueError: If an unreadable directory reported by ``os.walk`` is
                outside the configured source root.
        """
        dataset_candidates: list[DatasetCandidate] = []
        errors: list[ScanError] = []

        def record_walk_error(error: OSError) -> None:
            """Record one directory traversal error without ending discovery.

            Args:
                error: Filesystem error supplied by ``os.walk``.

            Raises:
                ValueError: If the reported path is outside the source root.
            """
            error_path = Path(error.filename).relative_to(
                self.source_root
            ).as_posix()
            errors.append({"path": error_path, "error": str(error)})

        for source_path in self.source_paths:
            for directory_path, directory_names, file_names in os.walk(
                source_path,
                onerror=record_walk_error,
            ):
                directory_names.sort()
                for file_name in sorted(file_names):
                    if (
                        Path(file_name).suffix.lower()
                        in SINGLE_FILE_DATASET_EXTENSIONS
                    ):
                        dataset_candidates.append(
                            DatasetCandidate(Path(directory_path) / file_name)
                        )
                dataset_candidates.extend(
                    DatasetCandidate(shapefile_path, component_paths)
                    for shapefile_path, component_paths
                    in discover_shapefile_datasets(
                        Path(directory_path),
                        file_names,
                    )
                )
        dataset_candidates.sort(
            key=lambda candidate: candidate.path.relative_to(
                self.source_root
            ).as_posix()
        )
        return dataset_candidates, errors
