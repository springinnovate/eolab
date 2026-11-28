"""Private attempt storage and publication of worker progress."""

import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from eolab_app.processing.artifacts import LocalJobArtifacts, write_progress


def test_prepare_does_not_scan_retained_outputs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Preparing a job ignores retained file totals and never walks storage.

    Args:
        tmp_path: Isolated private result volume.
        monkeypatch: Controlled free space and a forbidden directory traversal.
    """
    artifacts = LocalJobArtifacts(tmp_path)
    artifacts.initialize()
    for parent in ("attempts", "results"):
        retained = tmp_path / parent / ("a" * 32)
        retained.mkdir()
        (retained / "result.csv").write_bytes(b"x" * 20)

    def reject_scan(path: object) -> None:
        """Fail if preparation tries to enumerate the result volume.

        Args:
            path: Requested directory.

        Raises:
            AssertionError: Any directory enumeration is a regression.
        """
        raise AssertionError("Preparation must not scan retained outputs")

    monkeypatch.setattr("os.scandir", reject_scan)
    monkeypatch.setattr(
        "eolab_app.processing.artifacts.shutil.disk_usage",
        lambda path: SimpleNamespace(free=100),
    )
    assert artifacts.prepare("b" * 32).is_dir()


def test_prepare_does_not_reserve_physical_free_space(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Create the attempt without withholding filesystem space in advance.

    Args:
        tmp_path: Isolated private result volume.
        monkeypatch: Controlled disk free-space response.
    """
    artifacts = LocalJobArtifacts(tmp_path)
    artifacts.initialize()
    monkeypatch.setattr(
        "eolab_app.processing.artifacts.shutil.disk_usage",
        lambda path: SimpleNamespace(free=20),
    )
    assert artifacts.prepare("a" * 32).is_dir()


def test_prepare_does_not_query_free_space(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Attempt creation does not depend on a free-space query.

    Args:
        tmp_path: Isolated private result volume.
        monkeypatch: Simulated unavailable disk headroom.
    """
    artifacts = LocalJobArtifacts(tmp_path)
    artifacts.initialize()

    def unavailable(path: object) -> None:
        """Reject a free-space query as an unavailable filesystem would.

        Args:
            path: Requested volume.

        Raises:
            OSError: Filesystem headroom is unavailable.
        """
        raise OSError("free space unavailable")

    monkeypatch.setattr("eolab_app.processing.artifacts.shutil.disk_usage", unavailable)
    assert artifacts.prepare("a" * 32).is_dir()


def test_progress_replacement_after_reader_releases_snapshot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Expose the next complete snapshot after a reader blocks one replacement.

    Args:
        tmp_path: Isolated attempt storage.
        monkeypatch: Control when the reader releases the previous snapshot.
    """
    artifacts = LocalJobArtifacts(tmp_path)
    artifacts.initialize()
    attempt = "a" * 32
    directory = artifacts.prepare(attempt)
    write_progress(directory, "calculating", 1, 2)
    previous = artifacts.progress(attempt)
    destination = directory / "progress.json"
    replace = Path.replace

    def replace_while_reading(source: Path, target: Path) -> Path:
        """Hold the old snapshot open during the first replacement attempt.

        Args:
            source: Complete temporary snapshot.
            target: Published progress file.

        Returns:
            Destination of the successful replacement.

        Raises:
            PermissionError: Windows denies replacement while the reader is open.
        """
        if not reader.closed:
            try:
                assert artifacts.progress(attempt) == previous
                if os.name == "nt":
                    return replace(source, target)
                # POSIX permits replacing open files. Reproduce the Windows error.
                error = PermissionError("progress.json is open")
                error.winerror = 5
                raise error
            finally:
                reader.close()
        return replace(source, target)

    with destination.open() as reader:
        monkeypatch.setattr(Path, "replace", replace_while_reading)
        write_progress(directory, "calculating", 2, 2)
    assert artifacts.progress(attempt) == {
        "phase": "calculating",
        "completedBlocks": 2,
        "totalBlocks": 2,
    }


def test_persistent_progress_replacement_error_is_reported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Report a lasting access error and retain the previous complete snapshot.

    Args:
        tmp_path: Isolated attempt storage.
        monkeypatch: Keep the destination inaccessible on every replacement.
    """
    artifacts = LocalJobArtifacts(tmp_path)
    artifacts.initialize()
    attempt = "a" * 32
    directory = artifacts.prepare(attempt)
    write_progress(directory, "calculating", 1, 2)
    previous = artifacts.progress(attempt)
    error = PermissionError("progress.json is inaccessible")
    error.winerror = 5

    monkeypatch.setattr(Path, "replace", Mock(side_effect=error))
    with pytest.raises(PermissionError) as raised:
        write_progress(directory, "calculating", 2, 2)
    assert raised.value is error
    assert artifacts.progress(attempt) == previous
