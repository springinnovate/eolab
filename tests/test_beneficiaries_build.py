"""Verify source integrity at the original-model packaging boundary."""

import hashlib
import io
import json
from pathlib import Path
import runpy
import subprocess
import tarfile
from typing import Any

import pytest


def test_builder_preserves_source_bytes_and_rejects_changed_archive(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Packaging adds metadata without rewriting either original scientific source.

    Args:
        tmp_path: Local archive and wheel output directories.
        monkeypatch: Inspect build inputs without compiling the small fake extension.
    """
    revision = "a" * 40
    original = b"# original source\r\nVALUE = 42\r\n"
    extension = b"# original cython\n"
    archive = tmp_path / "source.tar.gz"
    with tarfile.open(archive, "w:gz") as bundle:
        for name, content in (
            ("workflow_runner.py", original),
            ("shortest_distances/src/shortest_distances.pyx", extension),
        ):
            item = tarfile.TarInfo(f"wwf_es_beneficiaries-{revision}/{name}")
            item.size = len(content)
            bundle.addfile(item, io.BytesIO(content))
    manifest = tmp_path / "source.json"
    manifest.write_text(
        json.dumps(
            {
                "revision": revision,
                "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
            }
        )
    )
    calls = []

    def inspect_build(
        command: list[str], **kwargs: Any
    ) -> subprocess.CompletedProcess[str]:
        """Inspect temporary source trees presented to pip wheel.

        Args:
            command: Original extension or runner wheel-build invocation.
            **kwargs: Checked subprocess settings supplied by the builder.

        Returns:
            A successful packaging subprocess result.
        """
        source = Path(command[-1])
        calls.append(source.name)
        if source.name == "shortest_distances":
            assert (source / "src/shortest_distances.pyx").read_bytes() == extension
        else:
            package = source / "wwf_es_beneficiaries"
            assert (package / "workflow_runner.py").read_bytes() == original
            assert (
                json.loads((package / "source.json").read_text())["runnerSha256"]
                == hashlib.sha256(original).hexdigest()
            )
        assert kwargs["check"] is True
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(subprocess, "run", inspect_build)
    build = runpy.run_path(
        str(Path(__file__).resolve().parents[1] / "deployment/build-beneficiaries.py")
    )["build_wheels"]
    build(manifest, tmp_path / "wheels", archive)
    assert calls == ["shortest_distances", "package"]
    archive.write_bytes(archive.read_bytes() + b"changed")
    with pytest.raises(ValueError, match="SHA-256"):
        build(manifest, tmp_path / "rejected", archive)
    assert len(calls) == 2
