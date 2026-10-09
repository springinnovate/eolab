"""Real-file publication, confinement, accounting and cancellation boundaries."""

import asyncio
from dataclasses import asdict
import hashlib
import json
import os
from pathlib import Path
from threading import Event
from typing import Any
from unittest.mock import Mock

import pytest
from pydantic import ValidationError

from eolab_app.processing.artifact_manifest import (
    FileDeclaration,
    read_artifact_manifest,
)
from eolab_app.processing.artifacts import LocalJobArtifacts
from eolab_app.processing.models import Artifact, ProcessingError, ProcessingLimits
from eolab_app.processing.worker import ProcessingWorker

ATTEMPT = "a" * 32


def workspace(
    tmp_path: Path,
) -> tuple[LocalJobArtifacts, Path, tuple[FileDeclaration, ...]]:
    """Create real result, intermediate, provenance and disposable scratch files.

    Args:
        tmp_path: Isolated storage root.

    Returns:
        Storage adapter, private attempt directory and approved file declarations.
    """
    storage = LocalJobArtifacts(tmp_path)
    storage.initialize()
    path = storage.prepare(ATTEMPT, 100_000, ProcessingLimits(free_space_floor=0))
    declarations = []
    for name, role, data in (
        ("result", "result", b"a,b\n1,2\n"),
        ("coverage", "intermediate", b"coverage data"),
        ("provenance", "provenance", b'{"version":1}'),
    ):
        filename = name + ".json" if name == "provenance" else name + ".csv"
        (path / filename).write_bytes(data)
        declarations.append(
            FileDeclaration(
                name=name,
                label=name.title(),
                role=role,
                storage_name=filename,
                filename=filename,
                media_type="application/json" if name == "provenance" else "text/csv",
                size=len(data),
                sha256=hashlib.sha256(data).hexdigest(),
            )
        )
    (path / "scratch.bin").write_bytes(b"temporary")
    (path / "progress.json").write_text('{"phase":"writing_results"}')
    return storage, path, tuple(declarations)


def test_publish_only_declared_files_and_account_inventory(tmp_path: Path) -> None:
    """Retain all approved files, discard scratch and charge the exact disk footprint.

    Args:
        tmp_path: Real private artifact volume.
    """
    storage, path, declarations = workspace(tmp_path)
    manifest = storage.publish(ATTEMPT, 100_000, declarations, Event())
    published = tmp_path / "results" / ATTEMPT
    assert not path.exists()
    assert {file.name for file in published.iterdir()} == {
        item.storage_name for item in declarations
    } | {"manifest.json"}
    assert manifest.total_bytes == sum(
        file.stat().st_size for file in published.iterdir()
    )
    assert len({file.id for file in manifest.files}) == 3
    assert read_artifact_manifest(json.loads(json.dumps(asdict(manifest)))) == manifest
    for file in manifest.files:
        data = storage.artifact_path(ATTEMPT, file.storage_name).read_bytes()
        assert (
            len(data) == file.size and hashlib.sha256(data).hexdigest() == file.sha256
        )
    storage.remove_orphans(set(), -1)
    assert not published.exists()


@pytest.mark.parametrize(
    "invalid",
    [
        "missing",
        "checksum",
        "size",
        "duplicate",
        "case",
        "nested",
        "inventory",
        "hardlink",
        "symlink",
        "overflow",
        "cancelled",
        "count",
    ],
)
def test_invalid_publication_exposes_no_manifest(tmp_path: Path, invalid: str) -> None:
    """Reject unsafe or incomplete workspaces before any published directory exists.

    Args:
        tmp_path: Isolated artifact volume.
        invalid: Distinct file, resource or cancellation boundary violation.
    """
    storage, path, declarations = workspace(tmp_path)
    cancelled = Event()
    reservation = 100_000
    if invalid == "missing":
        (path / "coverage.csv").unlink()
    elif invalid in {"checksum", "size"}:
        (path / "coverage.csv").write_bytes(
            b"changed data!" if invalid == "checksum" else b"changed"
        )
    elif invalid == "duplicate":
        declarations += (declarations[0],)
    elif invalid == "case":
        from dataclasses import replace

        declarations += (
            replace(declarations[0], name="other", storage_name="RESULT.CSV"),
        )
    elif invalid == "nested":
        (path / "nested").mkdir()
        (path / "nested" / "file").write_bytes(b"private")
    elif invalid == "inventory":
        (path / "manifest.json").write_bytes(b"untrusted")
    elif invalid in {"hardlink", "symlink"}:
        outside = tmp_path / "outside.csv"
        outside.write_bytes(b"outside")
        try:
            if invalid == "symlink":
                (path / "link.csv").symlink_to(outside)
            else:
                os.link(outside, path / "link.csv")
        except OSError:
            pytest.skip("OS does not allow creating this link")
    elif invalid == "overflow":
        reservation = sum(file.stat().st_size for file in path.iterdir())
    elif invalid == "cancelled":
        cancelled.set()
    elif invalid == "count":
        for index in range(130):
            (path / f"scratch{index}").touch()
    with pytest.raises((ProcessingError, ValidationError)):
        storage.publish(ATTEMPT, reservation, declarations, cancelled)
    assert not (tmp_path / "results" / ATTEMPT).exists()
    if invalid in {"hardlink", "symlink"}:
        assert (tmp_path / "outside.csv").read_bytes() == b"outside"


@pytest.mark.parametrize(
    "name",
    [
        "../result.csv",
        "C:/source.tif",
        "result.csv.",
        "CON.csv",
        "nul",
        "a/b.csv",
        "a\\b.csv",
    ],
)
def test_manifest_rejects_unsafe_names(name: str) -> None:
    """Reject traversal and platform aliases at the file declaration boundary.

    Args:
        name: Unsafe private or download filename.
    """
    with pytest.raises(ValidationError):
        FileDeclaration(
            name="result",
            label="Result",
            role="result",
            storage_name=name,
            filename="result.csv",
            media_type="text/csv",
        )


def test_persisted_manifest_cannot_understate_bytes(tmp_path: Path) -> None:
    """Reject corrupt persisted accounting instead of understating disk retention.

    Args:
        tmp_path: Real artifact fixture root.
    """
    storage, _, declarations = workspace(tmp_path)
    manifest = asdict(storage.publish(ATTEMPT, 100_000, declarations, Event()))
    manifest["total_bytes"] -= 1
    with pytest.raises(ValidationError):
        read_artifact_manifest(manifest)


def test_worker_waits_for_publication_after_repeated_cancellation() -> None:
    """Do not permit cleanup while an interrupted publication thread still writes."""
    started, release, exited = Event(), Event(), Event()

    def publish(
        attempt: str,
        reservation: int,
        declarations: tuple[FileDeclaration, ...],
        cancelled: Event,
    ) -> Any:
        """Keep a file operation alive until the test permits its exit.

        Args:
            attempt: Fenced fixture ID.
            reservation: Admitted bytes.
            declarations: Worker-approved files.
            cancelled: Signal proving the worker requests cooperative stop.

        Raises:
            ProcessingError: After cancellation and explicit test release.
        """
        started.set()
        assert release.wait(5)
        assert cancelled.is_set()
        exited.set()
        raise ProcessingError("job_cancelled", "Cancelled", 409)

    async def exercise() -> None:
        """Cancel twice while the publication thread is still inside its file operation."""
        worker = object.__new__(ProcessingWorker)
        worker.artifacts = Mock(publish=publish)
        artifact = Artifact(1, "a" * 64, "result.tif", media_type="image/tiff")
        task = asyncio.create_task(
            worker._publish_result(
                {
                    "spec": {"operation": "raster.clip.v1"},
                    "attempt_id": ATTEMPT,
                    "reserved_bytes": 100_000,
                },
                artifact,
            )
        )
        try:
            assert await asyncio.to_thread(started.wait, 5)
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done() and not exited.is_set()
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert exited.is_set()

    asyncio.run(exercise())
