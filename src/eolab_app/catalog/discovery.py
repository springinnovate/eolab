"""Deterministic filesystem discovery for mounted datasets."""

import os
from pathlib import Path

from eolab_app.catalog.handlers import DatasetBuildError, DatasetHandlerRegistry
from eolab_app.catalog.models import DatasetCandidate, ScanError


class FilesystemDatasetDiscovery:
    """Find supported datasets below configured scan directories."""

    def __init__(
        self,
        source_root: Path,
        source_paths: tuple[Path, ...],
        dataset_handlers: DatasetHandlerRegistry,
    ) -> None:
        """Configure filesystem discovery.

        Args:
            source_root: Root of the mounted scan source.
            source_paths: Directories below the mount to scan recursively.
            dataset_handlers: Explicit handlers used for recognition and
                container pruning.
        """
        self.source_root = source_root
        self.source_paths = source_paths
        self.dataset_handlers = dataset_handlers

    def discover(self) -> tuple[list[DatasetCandidate], list[ScanError]]:
        """Find datasets and reject conflicting declared Item identities.

        Returns:
            Prepared datasets in deterministic traversal order, together
            with traversal, admission, and duplicate-identity failures keyed
            by mount-relative path.

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
                sorted_directory_names = tuple(sorted(directory_names))
                sorted_file_names = tuple(sorted(file_names))
                directory_candidates, pruned_directory_names = (
                    self.dataset_handlers.discover_directory(
                        Path(directory_path),
                        sorted_directory_names,
                        sorted_file_names,
                    )
                )
                dataset_candidates.extend(directory_candidates)
                directory_names[:] = [
                    directory_name
                    for directory_name in sorted_directory_names
                    if directory_name not in pruned_directory_names
                ]
        dataset_candidates.sort(
            key=lambda candidate: candidate.path.relative_to(
                self.source_root
            ).as_posix()
        )
        prepared_candidates: list[DatasetCandidate] = []
        paths_by_item_key: dict[tuple[str, str], list[Path]] = {}
        for candidate in dataset_candidates:
            try:
                prepared = self.dataset_handlers.prepare_candidate(
                    self.source_root, candidate
                )
            except DatasetBuildError as error:
                errors.append(
                    {
                        "path": candidate.path.relative_to(self.source_root).as_posix(),
                        "error": str(error),
                    }
                )
                continue
            prepared_candidates.append(prepared)
            if prepared.item_key is not None:
                paths_by_item_key.setdefault(prepared.item_key, []).append(
                    prepared.path
                )
        duplicate_keys = {
            key for key, paths in paths_by_item_key.items() if len(paths) > 1
        }
        for item_key in sorted(duplicate_keys):
            for path in paths_by_item_key[item_key]:
                errors.append(
                    {
                        "path": path.relative_to(self.source_root).as_posix(),
                        "error": (
                            "Multiple datasets declare the same catalog Item: "
                            f"{'/'.join(item_key)}"
                        ),
                    }
                )
        return [
            candidate
            for candidate in prepared_candidates
            if candidate.item_key not in duplicate_keys
        ], errors
