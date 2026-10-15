"""Private attempt creation without storage scans or free-space admission."""

from pathlib import Path
from types import SimpleNamespace

import pytest

from eolab_app.processing.artifacts import LocalJobArtifacts


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
