"""Confined private artifact storage, atomic publication, and free-space checks."""

import json
import hashlib
import os
from pathlib import Path
import re
import shutil
import stat
from threading import Event
import time
from typing import Any
from uuid import uuid4
from pydantic import TypeAdapter, ValidationError

from eolab_app.processing.artifact_manifest import (
    ArtifactManifest,
    FileDeclaration,
    PublishedFile,
    MAX_ARTIFACT_FILES,
    encode_manifest_files,
    FileName,
)

from eolab_app.processing.models import ProcessingError, ProcessingLimits


def write_progress(
    directory: Path, phase: str, complete: int, total: int, *, unit: str = "blocks"
) -> None:
    """Atomically expose bounded native-kernel progress to its supervisor.

    Args:
        directory: Confined private attempt directory.
        phase: Operation-owned named phase.
        complete: Processed native block count.
        total: Admitted native block count.
        unit: Work unit for this stage; existing raster operations count blocks.
    """
    temporary = directory / "progress.tmp"
    temporary.write_text(
        json.dumps(
            {"phase": phase, "completedBlocks": complete, "totalBlocks": total}
            if unit == "blocks"
            else {"phase": phase, "completed": complete, "total": total, "unit": unit}
        )
    )
    temporary.replace(directory / "progress.json")


class LocalJobArtifacts:
    """Store processing attempts on one persistent volume outside mounted inputs."""

    def __init__(self, root: Path, forbidden_roots: tuple[Path, ...] = ()) -> None:
        """Validate separation before any file operation.

        Args:
            root: Absolute processing-owned volume root.
            forbidden_roots: Source/application roots that must never contain it.

        Raises:
            ValueError: If the volume overlaps another owner's filesystem root.
        """
        if not root.is_absolute():
            raise ValueError("Processing storage must be an absolute path")
        self.root = root.resolve()
        for forbidden in forbidden_roots:
            other = forbidden.resolve()
            if self.root.is_relative_to(other) or other.is_relative_to(self.root):
                raise ValueError(
                    "Processing storage must be separate from source and application roots"
                )

    def initialize(self) -> None:
        """Initialize private directories in the writable worker container.

        Raises:
            OSError: If the configured volume is not writable.
        """
        self.root.mkdir(parents=True, exist_ok=True)
        for name in ("attempts", "results"):
            (self.root / name).mkdir(exist_ok=True)

    def _directory(self, attempt: str, published: bool) -> Path:
        """Resolve a strict internal attempt ID and prove path confinement.

        Args:
            attempt: Worker-generated 32-character hexadecimal attempt ID.
            published: Select finished results rather than private attempts.

        Returns:
            Confined path without following an existing symlink out of storage.

        Raises:
            ValueError: If an ID or resolved path escapes the owned volume.
        """
        if not re.fullmatch(r"[a-f0-9]{32}", attempt):
            raise ValueError("Invalid internal job attempt ID")
        parent = self.root / ("results" if published else "attempts")
        candidate = parent / attempt
        linked = any(
            path.is_symlink()
            or (
                path.exists() and getattr(path.lstat(), "st_file_attributes", 0) & 0x400
            )
            for path in (candidate, parent)
        )
        if (
            candidate.resolve().parent != parent
            or parent.resolve().parent != self.root
            or linked
        ):
            raise ValueError("Job path escapes its owned storage")
        return candidate

    def prepare(self, attempt: str, reservation: int, limits: ProcessingLimits) -> Path:
        """Check physical free space and create one unique private attempt.

        Retained outputs are not traversed or totaled. The caller has already
        admitted this job's reservation through the job store.

        Args:
            attempt: Fenced worker attempt ID.
            reservation: Admitted worst-case scratch/output byte reservation.
            limits: Settings whose free_space_floor is the minimum number of bytes
                that must remain free after allowing for this job's reservation.

        Returns:
            Empty attempt directory.

        Raises:
            ProcessingError: If physical disk headroom is insufficient.
            ValueError: If the attempt ID or resolved path is not confined.
            OSError: If free space cannot be read or the directory cannot be created.
        """
        if shutil.disk_usage(self.root).free < reservation + limits.free_space_floor:
            raise ProcessingError(
                "storage_full",
                "There is not enough temporary storage for this job.",
                429,
            )
        path = self._directory(attempt, False)
        path.mkdir(exist_ok=False)
        return path

    def publish(
        self,
        attempt: str,
        reservation: int,
        declarations: tuple[FileDeclaration, ...],
        cancelled: Event,
    ) -> ArtifactManifest:
        """Verify declared files, remove scratch, and atomically publish an inventory.

        Only flat regular files with one hard link are allowed in a closed attempt.
        Links, junctions and nested directories are rejected, including in scratch.
        Hashing checks cancellation between 1 MiB reads; callers must await this
        method's exit before permitting cleanup. No download is authorized here.

        Args:
            attempt: Fenced attempt whose native operation completed successfully.
            reservation: Admitted scratch/output ceiling, checked before publish.
            declarations: Complete files approved by the owning application.
            cancelled: Signal set when the worker loses its attempt or deadline.

        Returns:
            Immutable file inventory and exact retained bytes, including manifest.json.

        Raises:
            ProcessingError: If files are missing, unsafe, changed, over budget,
                undeclared metadata is invalid, or publication was cancelled.
            OSError: If atomic publication fails.
        """
        path = self._directory(attempt, False)
        if not 1 <= len(declarations) <= MAX_ARTIFACT_FILES:
            raise ProcessingError("invalid_artifact", "Invalid result file count.", 500)
        names = [item.storage_name.casefold() for item in declarations]
        if len(set(names)) != len(names) or any(
            name in {"manifest.json", "progress.json", "progress.tmp"} for name in names
        ):
            raise ProcessingError(
                "invalid_artifact", "Result file names conflict.", 500
            )
        children = {}
        total = 0
        for child in path.iterdir():
            if len(children) >= 128:
                raise ProcessingError(
                    "invalid_artifact", "Too many workspace files.", 500
                )
            info = self._regular_file(child)
            if child.name.casefold() == "manifest.json" or child.name.casefold() in {
                name.casefold() for name in children
            }:
                raise ProcessingError(
                    "invalid_artifact", "Workspace file names conflict.", 500
                )
            children[child.name] = info
            total += info.st_size
        if total > reservation:
            raise ProcessingError(
                "output_too_large",
                "The completed result exceeds its storage reservation.",
                413,
            )
        files = []
        for declaration in declarations:
            self._check_cancelled(cancelled)
            if declaration.storage_name not in children:
                raise ProcessingError(
                    "invalid_artifact", "A declared result file is missing.", 500
                )
            source = path / declaration.storage_name
            before = children[source.name]
            digest = hashlib.sha256()
            with source.open("rb") as stream:
                while block := stream.read(1024 * 1024):
                    self._check_cancelled(cancelled)
                    digest.update(block)
            after = self._regular_file(source)
            if (
                (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                or (declaration.size is not None and after.st_size != declaration.size)
                or (
                    declaration.sha256 is not None
                    and digest.hexdigest() != declaration.sha256
                )
            ):
                raise ProcessingError(
                    "invalid_artifact", "A completed result file changed.", 500
                )
            files.append(
                PublishedFile(
                    id=uuid4().hex,
                    name=declaration.name,
                    label=declaration.label,
                    role=declaration.role,
                    storage_name=declaration.storage_name,
                    filename=declaration.filename,
                    media_type=declaration.media_type,
                    size=after.st_size,
                    sha256=digest.hexdigest(),
                )
            )
        entries = tuple(files)
        inventory = encode_manifest_files(entries)
        retained_bytes = sum(item.size for item in entries) + len(inventory)
        manifest = ArtifactManifest(files=entries, total_bytes=retained_bytes)
        if total + len(inventory) > reservation:
            raise ProcessingError(
                "output_too_large",
                "The completed files exceed their storage reservation.",
                413,
            )
        self._check_cancelled(cancelled)
        (path / "manifest.json").write_bytes(inventory)
        for name in children:
            if name.casefold() not in names:
                (path / name).unlink()
        self._check_cancelled(cancelled)
        path.replace(self._directory(attempt, True))
        return manifest

    @staticmethod
    def _check_cancelled(cancelled: Event) -> None:
        """Stop file publication when the attempt loses its lease or deadline.

        Args:
            cancelled: Cooperative signal owned by the worker.

        Raises:
            ProcessingError: If cancellation has been requested.
        """
        if cancelled.is_set():
            raise ProcessingError(
                "job_cancelled", "Result publication was cancelled.", 409
            )

    @staticmethod
    def _regular_file(path: Path) -> os.stat_result:
        """Inspect a single private file without accepting links or directories.

        Args:
            path: Confined candidate file path.

        Returns:
            File stat values used to check size and detect replacement.

        Raises:
            ProcessingError: If the candidate is not a single-link regular file.
            OSError: If the file cannot be inspected.
        """
        info = path.lstat()
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or getattr(info, "st_file_attributes", 0) & 0x400
        ):
            raise ProcessingError(
                "invalid_artifact",
                "Result folders must contain only regular files.",
                500,
            )
        return info

    def artifact_path(self, attempt: str, storage_name: str) -> Path:
        """Locate one manifest file after its owning operation authorizes access.

        Downloads and calculations retain files separately. Interactive reads
        may race cleanup and receive the ordinary unavailable-file error.

        Args:
            attempt: Published attempt ID from the owned job.
            storage_name: Private basename read from its validated manifest.

        Returns:
            Existing confined regular file.

        Raises:
            ProcessingError: If the name is unsafe or the file is unavailable.
        """

        try:
            TypeAdapter(FileName).validate_python(storage_name)
        except ValidationError as error:
            raise ProcessingError(
                "invalid_artifact", "Invalid result file name.", 500
            ) from error
        path = self._directory(attempt, True) / storage_name
        try:
            self._regular_file(path)
        except OSError as error:
            raise ProcessingError(
                "result_missing",
                "This result file is no longer available. Run the model again.",
                410,
            ) from error
        return path

    def result_path(
        self, attempt: str, provenance: bool = False, result_name: str = "result.tif"
    ) -> Path:
        """Locate a finished file after the caller verifies owner and transfer lease.

        Args:
            attempt: Job-owned published attempt ID.
            provenance: Select the immutable provenance JSON instead of GeoTIFF.
            result_name: Server-owned artifact name; defaults for legacy clips.

        Returns:
            Confined, existing artifact path.

        Raises:
            ProcessingError: If the immutable artifact is absent or not a file.
        """
        if not re.fullmatch(r"result\.[a-z0-9]{1,8}", result_name):
            raise ProcessingError(
                "invalid_artifact", "Invalid processing result descriptor.", 500
            )
        return self.artifact_path(
            attempt, "provenance.json" if provenance else result_name
        )

    def progress(self, attempt: str) -> dict[str, Any]:
        """Read only bounded progress fields from the private child output.

        Args:
            attempt: Current fenced execution ID.

        Returns:
            Latest complete phase/progress record, or an empty mapping.
        """
        try:
            path = self._directory(attempt, False) / "progress.json"
            if path.stat().st_size > 1024:
                return {}
            return json.loads(path.read_text())
        except (OSError, ValueError):
            return {}

    def remove(self, attempt: str) -> None:
        """Remove only one verified attempt after native and transfer leases end.

        Args:
            attempt: Terminal job's strict internal attempt ID.

        Raises:
            OSError: If cleanup failed; the caller must retain its reservation.
        """
        for published in (False, True):
            directory = self._directory(attempt, published)
            if directory.exists():
                shutil.rmtree(directory)

    def remove_orphans(self, retained: set[str], minimum_age_seconds: float) -> None:
        """Reap abandoned attempts only after their maximum possible runtime.

        Args:
            retained: IDs that still own database reservations or transfer leases.
            minimum_age_seconds: Conservative hard-deadline plus exit grace.
        """
        for parent in ("attempts", "results"):
            for path in (self.root / parent).iterdir():
                if (
                    path.name not in retained
                    and re.fullmatch(r"[a-f0-9]{32}", path.name)
                    and path.is_dir()
                    and time.time() - path.stat().st_mtime > minimum_age_seconds
                ):
                    self.remove(path.name)
