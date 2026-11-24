"""Build the pinned PyFlwDir wheel with DEM precision preserved in its flood queue."""

import argparse
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

from wheel.cli.unpack import unpack

UPSTREAM = "0.6.0"
VERSION = f"{UPSTREAM}+eolab.1"


def build_precision_wheel(output: Path) -> None:
    """Write a versioned PyFlwDir wheel with a dtype-specialized flood queue.

    The original flood algorithm, cell tie-breaking and Float32 queue stay
    intact. Wide DEMs use Float64 priorities throughout depression filling.
    The wheel retains the upstream license and records the local build version.

    Args:
        output: Directory in which to place the installable wheel.

    Raises:
        subprocess.CalledProcessError: If the locked download or wheel build fails.
        ValueError: If the upstream source differs from the reviewed patch.
        OSError: If the temporary package or output cannot be written.
    """
    requirements = Path(__file__).with_name("application-pyflwdir-requirements.txt")
    with TemporaryDirectory() as temporary:
        work = Path(temporary)
        subprocess.run(
            [
                sys.executable,
                "-m",
                "pip",
                "download",
                "--no-deps",
                "--only-binary=:all:",
                "--require-hashes",
                "-r",
                str(requirements),
                "-d",
                str(work),
            ],
            check=True,
        )
        unpack(str(work / f"pyflwdir-{UPSTREAM}-py3-none-any.whl"), str(work))
        root = work / f"pyflwdir-{UPSTREAM}"
        metadata = root / f"pyflwdir-{UPSTREAM}.dist-info"
        changes = {
            "pyflwdir/dem.py": (
                (
                    "    connectivity: int = 8,\n",
                    "    connectivity: int = 8,\n    queue_dtype: type = np.float32,\n",
                    1,
                ),
                (
                    "        Number of neighboring cells to consider.\n",
                    "        Number of neighboring cells to consider.\n"
                    "    queue_dtype : type, optional\n"
                    "        Floating-point precision for elevation priorities in the flood queue.\n",
                    1,
                ),
                ("np.float32(elevtn[0, 0])", "queue_dtype(elevtn[0, 0])", 1),
                ("np.float32(elevtn[r, c])", "queue_dtype(elevtn[r, c])", 1),
                ("np.float32(z1)", "queue_dtype(z1)", 2),
                ("                z1 += dz", "                z1 = z0", 1),
            ),
            "pyflwdir/pyflwdir.py": (
                (
                    "        data, nodata=nodata, max_depth=max_depth, outlets=outlets\n",
                    "        data, nodata=nodata, max_depth=max_depth, outlets=outlets,\n"
                    "        queue_dtype=np.result_type(data.dtype, np.float32).type,\n",
                    1,
                ),
            ),
            "pyflwdir/__init__.py": (
                (f'__version__ = "{UPSTREAM}"', f'__version__ = "{VERSION}"', 1),
            ),
            f"{metadata.name}/METADATA": (
                (f"\nVersion: {UPSTREAM}\n", f"\nVersion: {VERSION}\n", 1),
            ),
        }
        for filename, replacements in changes.items():
            path = root / filename
            source = path.read_text(encoding="utf-8")
            for original, replacement, count in replacements:
                if source.count(original) != count:
                    raise ValueError(
                        f"Unexpected upstream text in {path.name}: {original!r}"
                    )
                source = source.replace(original, replacement)
            path.write_text(source, encoding="utf-8", newline="\n")
        metadata.rename(root / f"pyflwdir-{VERSION}.dist-info")
        output.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                sys.executable,
                "-m",
                "wheel",
                "pack",
                str(root),
                "--dest-dir",
                str(output),
            ],
            env={**os.environ, "SOURCE_DATE_EPOCH": "315532800"},
            check=True,
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="Directory for the versioned wheel")
    build_precision_wheel(parser.parse_args().output)
