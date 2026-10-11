"""Build installable wheels containing the unchanged pinned beneficiaries source."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
from urllib.request import urlopen


def build_wheels(manifest: Path, output: Path, archive: Path | None = None) -> None:
    """Verify an upstream archive and package its original runner and extension.

    Only packaging metadata is added. The scientific source files are copied
    byte for byte, and their revision and checksums accompany the installed code.

    Args:
        manifest: Reviewed repository revision, archive URL and SHA-256.
        output: Directory receiving the two dependency wheels.
        archive: Optional previously downloaded archive for offline builds.

    Raises:
        ValueError: If the downloaded source does not match the reviewed hash.
        OSError: If source or output files cannot be accessed.
        subprocess.CalledProcessError: If either wheel cannot be built.
    """
    source = json.loads(manifest.read_text(encoding="utf-8"))
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="beneficiaries-build-") as temporary:
        directory = Path(temporary)
        downloaded = directory / "source.tar.gz"
        if archive is None:
            with urlopen(source["url"], timeout=120) as response:
                downloaded.write_bytes(response.read())
        else:
            shutil.copyfile(archive, downloaded)
        if hashlib.sha256(downloaded.read_bytes()).hexdigest() != source["sha256"]:
            raise ValueError(
                "Beneficiaries source archive does not match its pinned SHA-256"
            )
        with tarfile.open(downloaded) as bundle:
            bundle.extractall(directory, filter="data")
        original = directory / ("wwf_es_beneficiaries-" + source["revision"])
        package_root = directory / "package"
        package = package_root / "wwf_es_beneficiaries"
        package.mkdir(parents=True)
        (package / "__init__.py").write_text(
            '"""Unmodified WWF ecosystem beneficiaries calculation source."""\n',
            encoding="utf-8",
        )
        shutil.copyfile(original / "workflow_runner.py", package / "workflow_runner.py")
        source["runnerSha256"] = hashlib.sha256(
            (package / "workflow_runner.py").read_bytes()
        ).hexdigest()
        (package / "source.json").write_text(
            json.dumps(source, sort_keys=True), encoding="utf-8"
        )
        (package_root / "pyproject.toml").write_text(
            '[build-system]\nrequires = ["setuptools", "wheel"]\n'
            'build-backend = "setuptools.build_meta"\n'
            '[project]\nname = "wwf-es-beneficiaries"\n'
            f'version = "0.0.0+g{source["revision"][:12]}"\n'
            'requires-python = ">=3.11"\n'
            'dependencies = ["ecoshard", "geopandas", "pandas", "pyogrio", '
            '"tqdm", "psutil", "rasterio", "shapely", "pyproj", "numpy", '
            '"PyYAML", "shortest-distances"]\n'
            '[tool.setuptools.package-data]\nwwf_es_beneficiaries = ["source.json"]\n',
            encoding="utf-8",
        )
        for candidate in (original / "shortest_distances", package_root):
            subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "pip",
                    "wheel",
                    "--no-deps",
                    "--no-build-isolation",
                    "--wheel-dir",
                    str(output),
                    str(candidate),
                ],
                check=True,
                env={
                    **os.environ,
                    "SETUPTOOLS_SCM_PRETEND_VERSION_FOR_SHORTEST_DISTANCES": "0.0.0+g"
                    + source["revision"][:12],
                },
            )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--archive", type=Path)
    arguments = parser.parse_args()
    build_wheels(arguments.manifest, arguments.output, arguments.archive)
