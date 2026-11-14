"""Deterministic filesystem discovery for mounted datasets."""

import os
from pathlib import Path

from eolab_app.catalog.handlers import DatasetBuildError, DatasetHandlerRegistry
from eolab_app.catalog.models import DatasetCandidate, DescriptorSource, ScanError
from eolab_app.catalog.descriptor_contract import (
    DESCRIPTOR_SUFFIX,
    NONSPATIAL_COLLECTION_ID,
)
from eolab_app.catalog.descriptors import (
    DESCRIPTOR_HANDLER_NAME,
    DescriptorDataset,
    DescriptorAdmissionError,
    PreparedDescriptor,
    prepare_descriptor,
    source_path_from_relative,
)


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

    def discover(
        self,
        retained_sources: tuple[DescriptorSource, ...] = (),
    ) -> tuple[list[DatasetCandidate], list[ScanError]]:
        """Find datasets and reject conflicting declared Item identities.

        Args:
            retained_sources: Previously admitted descriptor claims, including
                sources outside this scan and claims needed after invalid edits.

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
            error_path = Path(error.filename).relative_to(self.source_root).as_posix()
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
        dataset_candidates = self._prepare_sidecars(
            dataset_candidates, retained_sources, errors
        )
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

    def _prepare_sidecars(
        self,
        candidates: list[DatasetCandidate],
        retained_sources: tuple[DescriptorSource, ...],
        errors: list[ScanError],
    ) -> list[DatasetCandidate]:
        """Resolve descriptor ownership before allowing ordinary payload reads.

        Args:
            candidates: Complete deterministic filesystem recognition results.
            retained_sources: Previous private ownership records.
            errors: Discovery failures extended with descriptor admission errors.

        Returns:
            Prepared descriptor groups and unclaimed ordinary datasets.
        """
        sidecars = [
            candidate
            for candidate in candidates
            if candidate.handler_name == DESCRIPTOR_HANDLER_NAME
        ]
        ordinary = [
            candidate
            for candidate in candidates
            if candidate.handler_name != DESCRIPTOR_HANDLER_NAME
        ]
        known: dict[Path, list[DescriptorSource]] = {}
        for source in retained_sources:
            path = source_path_from_relative(self.source_root, source.relative_path)
            known.setdefault(path, []).append(source)
        recognized = {candidate.path.resolve() for candidate in sidecars}
        claimed: set[Path] = set()
        failed_claims: set[Path] = set()
        prepared: list[PreparedDescriptor] = []
        active_known = set(known) & recognized

        def record_error(path: Path, error: Exception | str) -> None:
            """Record a mount-relative authoring failure for the scan report.

            Args:
                path: Descriptor that could not be admitted.
                error: Captured failure or explicit conflict explanation.
            """
            errors.append(
                {
                    "path": path.relative_to(self.source_root).as_posix(),
                    "error": str(error),
                }
            )

        def retain_claims(path: Path) -> None:
            """Protect a failed/unscanned descriptor's last admitted associations.

            Args:
                path: Canonical descriptor path retained from the catalog.
            """
            for source in known.get(path, []):
                for relative_path in source.claimed_paths:
                    location = source_path_from_relative(
                        self.source_root, relative_path
                    )
                    claimed.add(location)
                    failed_claims.add(location)

        for path in known.keys() - recognized:
            in_scope = any(
                path.is_relative_to(scope.resolve()) for scope in self.source_paths
            )
            if not in_scope:
                active_known.add(path)
                retain_claims(path)
                continue
            try:
                path.stat()
            except FileNotFoundError:
                # Restore native metadata even when an old descriptor referenced
                # a primary outside the currently enumerated directories.
                for source in known[path]:
                    if source.kind == "nonspatial":
                        continue
                    try:
                        primary = source_path_from_relative(
                            self.source_root, source.primary_relative_path
                        )
                        entries = tuple(primary.parent.iterdir())
                        matches, _ = self.dataset_handlers.discover_directory(
                            primary.parent,
                            tuple(
                                sorted(
                                    entry.name for entry in entries if entry.is_dir()
                                )
                            ),
                            tuple(
                                sorted(
                                    entry.name for entry in entries if entry.is_file()
                                )
                            ),
                        )
                        existing_paths = {
                            candidate.path.resolve() for candidate in ordinary
                        }
                        ordinary.extend(
                            candidate
                            for candidate in matches
                            if candidate.path.resolve() == primary
                            and primary not in existing_paths
                        )
                    except OSError as error:
                        record_error(path, error)
                        retain_claims(path)
                continue
            except OSError as error:
                record_error(path, error)
            active_known.add(path)
            retain_claims(path)
        for candidate in sidecars:
            path = candidate.path.resolve()
            # A recognizable filename protects its same-file source even when a
            # brand-new malformed descriptor has no retained catalog ownership.
            fallback = path.with_name(path.name[: -len(DESCRIPTOR_SUFFIX)])
            try:
                descriptor = prepare_descriptor(self.source_root, candidate.path)
                prepared.append(descriptor)
                claimed.update(descriptor.locations.values())
            except Exception as error:
                if isinstance(error, DescriptorAdmissionError):
                    claimed.update(error.claimed_paths)
                    failed_claims.update(error.claimed_paths)
                detail = str(error)
                if path not in known and not isinstance(
                    error, DescriptorAdmissionError
                ):
                    detail += "; only the same-name source can be protected until descriptor associations are readable"
                record_error(candidate.path, detail)
                claimed.add(fallback)
                failed_claims.add(fallback)
                retain_claims(path)
        rejected: set[Path] = set()
        by_id: dict[str, list[PreparedDescriptor]] = {}
        by_primary: dict[Path | str, list[PreparedDescriptor]] = {}
        for descriptor in prepared:
            by_id.setdefault(descriptor.declaration.id, []).append(descriptor)
            primary = descriptor.primary_path
            if primary is None:
                primary = descriptor.declaration.assets[
                    descriptor.declaration.primary_asset
                ].href
            by_primary.setdefault(primary, []).append(descriptor)
        for identifier, declarations in by_id.items():
            declared_paths = {descriptor.path.resolve() for descriptor in declarations}
            other_owners = [
                path
                for path in active_known - declared_paths
                if any(source.descriptor_id == identifier for source in known[path])
            ]
            if len(declarations) > 1 or other_owners:
                for descriptor in declarations:
                    rejected.add(descriptor.path)
                    record_error(
                        descriptor.path,
                        f"Multiple descriptors declare dataset ID {identifier!r}",
                    )
        for primary, declarations in by_primary.items():
            for index, descriptor in enumerate(declarations):
                for other in declarations[index + 1 :]:
                    if (
                        descriptor.selected_layer is None
                        or other.selected_layer is None
                        or descriptor.selected_layer == other.selected_layer
                        or descriptor.declaration.source != other.declaration.source
                        and descriptor.declaration.source is not None
                        and other.declaration.source is not None
                        and descriptor.declaration.source.format
                        != other.declaration.source.format
                    ):
                        for conflict in (descriptor, other):
                            rejected.add(conflict.path)
                            record_error(
                                conflict.path,
                                "Multiple descriptors claim the same primary source/layer",
                            )
            for descriptor in prepared:
                if descriptor in declarations:
                    continue
                support = set(descriptor.locations.values()) - {descriptor.primary_path}
                if primary in support:
                    for conflict in (*declarations, descriptor):
                        rejected.add(conflict.path)
                        record_error(
                            conflict.path,
                            "A supporting Asset is also declared as another Item's primary source",
                        )
        # Prior unreadable or out-of-scope declarations still own their sources.
        # Shared supporting files are allowed; primary/support transitions require
        # all affected descriptors to participate in a successful scan.
        retained_owners = active_known - {
            descriptor.path.resolve() for descriptor in prepared
        }
        for descriptor in prepared:
            primary = descriptor.primary_path
            support = set(descriptor.locations.values()) - {primary}
            for retained_path in retained_owners:
                for owner in known[retained_path]:
                    prior_primary = (
                        source_path_from_relative(
                            self.source_root, owner.primary_relative_path
                        )
                        if owner.primary_relative_path is not None
                        else None
                    )
                    prior_support = {
                        source_path_from_relative(self.source_root, path)
                        for path in owner.claimed_paths
                    } - {prior_primary}
                    if (
                        (primary is not None and primary == prior_primary)
                        or prior_primary in support
                        or primary in prior_support
                    ):
                        rejected.add(descriptor.path)
                        record_error(
                            descriptor.path,
                            "Source ownership conflicts with an unreadable or unscanned descriptor; scan and correct all affected descriptors together",
                        )
                        break
        output: list[DatasetCandidate] = []
        for primary, declarations in by_primary.items():
            if (
                any(descriptor.path in rejected for descriptor in declarations)
                or primary in failed_claims
            ):
                for descriptor in declarations:
                    retain_claims(descriptor.path.resolve())
                continue
            first = declarations[0]
            source_candidate = None
            builder = None
            try:
                if first.declaration.kind != "nonspatial":
                    source_format = first.declaration.source.format
                    source_candidate = next(
                        (
                            candidate
                            for candidate in ordinary
                            if candidate.path.resolve() == primary
                            and candidate.handler_name == source_format
                        ),
                        None,
                    )
                    if source_candidate is None:
                        directory = primary.parent
                        entries = tuple(directory.iterdir())
                        matches, _ = self.dataset_handlers.discover_directory(
                            directory,
                            tuple(
                                sorted(
                                    entry.name for entry in entries if entry.is_dir()
                                )
                            ),
                            tuple(
                                sorted(
                                    entry.name for entry in entries if entry.is_file()
                                )
                            ),
                        )
                        source_candidate = next(
                            (
                                candidate
                                for candidate in matches
                                if candidate.path.resolve() == primary
                                and candidate.handler_name == source_format
                            ),
                            None,
                        )
                    if source_candidate is None:
                        raise ValueError(
                            "Primary source is not recognized by its declared existing format handler"
                        )
                    builder = self.dataset_handlers.get_builder(source_format)
                output.append(
                    DatasetCandidate(
                        path=first.path,
                        handler_name=DESCRIPTOR_HANDLER_NAME,
                        item_key=(
                            (NONSPATIAL_COLLECTION_ID, first.declaration.id)
                            if first.declaration.kind == "nonspatial"
                            else None
                        ),
                        metadata=DescriptorDataset(
                            tuple(declarations), source_candidate, builder
                        ),
                    )
                )
            except Exception as error:
                for descriptor in declarations:
                    record_error(descriptor.path, error)
                    retain_claims(descriptor.path.resolve())
        output.extend(
            candidate
            for candidate in ordinary
            if candidate.handler_name == "temporal-cog"
            or candidate.path.resolve() not in claimed
        )
        return output
