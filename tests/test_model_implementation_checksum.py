"""Keep API/worker revision checks sensitive to every backend package."""

from pathlib import Path

import pytest

from eolab_app.processing import model_runs


@pytest.mark.parametrize("package", ["eolab_app", "eolab_jobs"])
def test_implementation_checksum_includes_backend_packages(
    package: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Detect a source change confined to either installed backend package.

    Args:
        package: Backend package whose implementation changes between revisions.
        tmp_path: Isolated stand-in for installed package resources.
        monkeypatch: Fixture redirecting resource discovery to those packages.
    """
    for name in ("eolab_app", "eolab_jobs"):
        directory = tmp_path / name
        directory.mkdir()
        (directory / "models.py").write_text("original implementation\n")
    monkeypatch.setattr(model_runs, "files", lambda name: tmp_path / name)

    original = model_runs.compute_implementation_checksum.__wrapped__()
    (tmp_path / package / "models.py").write_text("changed implementation\n")
    changed = model_runs.compute_implementation_checksum.__wrapped__()

    assert changed != original
