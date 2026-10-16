"""Measure private-raster verification through the real analysis and lease scopes.

Run from the repository with its Python environment and ``PYTHONPATH=src``::

    python scripts/benchmark_private_raster_verification.py --output data/report.json

Synthetic tiled float32 rasters exercise first, repeated and concurrent requests.
The operating-system cache is warm: creating and publishing the files reads them.
This is a local mechanism benchmark, not a production latency measurement. Only
the persistent authority is replaced by an in-memory owner/lease implementation;
checksum verification, subprocess supervision and numerical readers are real.
"""

from __future__ import annotations

import argparse
import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
import hashlib
import json
from pathlib import Path
import platform
import statistics
import subprocess
import time
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import numpy as np
import rasterio
from rasterio.transform import from_bounds
from rasterio.windows import Window

from eolab_app import source_files
from eolab_app.execution.bounded_process import run_bounded_process
from eolab_app.raster.models import AuthorizedRaster, CatalogRasterRequest
from eolab_app.raster.source_access import RasterSourceAccess
from eolab_app.raster.source_models import (
    RasterPairSourceRequest,
    RasterStatisticsSourceRequest,
    RunArtifactReference,
)
from eolab_app.raster.statistics_service import RasterStatisticsService
from eolab_app.source_files import LeasedSourceFiles, SourceFileError

_SHA256 = hashlib.sha256
_OWNER = "benchmark-owner"
_RUN = "a" * 32


class CountingHash:
    """Count bytes consumed by the original SHA-256 implementation."""

    def __init__(self) -> None:
        """Start an empty original hash and byte counter."""
        self.digest = _SHA256()
        self.byte_count = 0

    def update(self, data: bytes) -> None:
        """Hash and count one real file block.

        Args:
            data: Bytes read by the production verifier.
        """
        self.byte_count += len(data)
        self.digest.update(data)

    def hexdigest(self) -> str:
        """Return the original digest used by the production integrity check.

        Returns:
            Lowercase hexadecimal SHA-256 digest.
        """
        return self.digest.hexdigest()


def measured_verification(writer: Any, path: Path, size: int, sha256: str) -> None:
    """Run the production verifier and return its result plus child measurements.

    Args:
        writer: Original supervised process result writer.
        path: Authorized original raster.
        size: Published file size.
        sha256: Published checksum, compared by the unchanged production verifier.
    """
    checksum = CountingHash()
    results: list[Any] = []
    start = time.perf_counter()
    with patch.object(source_files.hashlib, "sha256", return_value=checksum):
        source_files.verify_source_file(
            SimpleNamespace(put=results.append), path, size, sha256
        )
    writer.put((results[0], checksum.byte_count, time.perf_counter() - start))


@dataclass(frozen=True)
class FileLease:
    """A synthetic published raster and its independently acquired retention token."""

    path: Path
    size: int
    sha256: str
    lease_id: str = ""
    media_type: str = "image/tiff"


class FileAuthority:
    """Authorize benchmark-owned files and track separate leases for each caller."""

    def __init__(self, sources: dict[str, FileLease]) -> None:
        """Retain published source metadata without timing database operations.

        Args:
            sources: Opaque file IDs mapped to completed synthetic rasters.
        """
        self.sources = sources
        self.leases: set[str] = set()
        self.sequence = 0
        self.check_count = 0

    async def check(self, owner: str, run: str, file: str) -> tuple[int, str, str]:
        """Check current ownership and return immutable publication metadata.

        Args:
            owner: Requesting owner.
            run: Opaque run ID.
            file: Opaque file ID.

        Returns:
            Published byte count, checksum and media type.

        Raises:
            SourceFileError: If any identity is unauthorized.
        """
        self.check_count += 1
        if owner != _OWNER or run != _RUN or file not in self.sources:
            raise SourceFileError("Unavailable benchmark file", 404)
        source = self.sources[file]
        return source.size, source.sha256, source.media_type

    async def acquire(self, owner: str, run: str, file: str) -> FileLease:
        """Authorize a caller and acquire a new lease.

        Args:
            owner: Requesting owner.
            run: Opaque run ID.
            file: Opaque file ID.

        Returns:
            Source with a distinct live lease token.

        Raises:
            SourceFileError: If ownership fails.
        """
        await self.check(owner, run, file)
        self.sequence += 1
        token = str(self.sequence)
        self.leases.add(token)
        return replace(self.sources[file], lease_id=token)

    async def release(self, lease: str) -> bool:
        """Release completed native work's retention token.

        Args:
            lease: Previously acquired token.

        Returns:
            True after successful removal.
        """
        self.leases.remove(lease)
        return True

    async def renew(self, lease: str) -> bool:
        """Report whether a caller still owns a live lease.

        Args:
            lease: Previously acquired token.

        Returns:
            Whether the token is still retained.
        """
        return lease in self.leases

    async def authorize(self, request: CatalogRasterRequest) -> AuthorizedRaster:
        """Reject unexpected catalog access in a private-file-only benchmark.

        Args:
            request: Unexpected catalog identity.

        Raises:
            RuntimeError: Always, because this benchmark uses private sources.
        """
        raise RuntimeError("The private-raster benchmark must not access the catalog")


def write_source(path: Path, dimension: int, offset: int) -> FileLease:
    """Write an uncompressed tiled float32 raster and establish its publication hash.

    Args:
        path: Benchmark-owned output path.
        dimension: Width and height, divisible by 256.
        offset: Distinguishes the two paired raster sources.

    Returns:
        Completed source metadata; publication hashing is outside measurements.
    """
    tile = np.arange(256 * 256, dtype="float32").reshape(256, 256) + offset
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=dimension,
        height=dimension,
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=from_bounds(-10, -10, 10, 10, dimension, dimension),
        tiled=True,
        blockxsize=256,
        blockysize=256,
        compress="none",
    ) as dataset:
        for row in range(0, dimension, 256):
            for col in range(0, dimension, 256):
                dataset.write(tile, 1, window=Window(col, row, 256, 256))
    with path.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
    return FileLease(path, path.stat().st_size, checksum)


async def measure(
    invoke: Callable[[], Awaitable[Any]], authority: FileAuthority, callers: int
) -> dict[str, int | float]:
    """Measure a request group while retaining the real supervised verifier.

    Args:
        invoke: One original metadata or statistics operation.
        authority: Owner and lease authority whose checks are counted.
        callers: Simultaneous callers, limited to two by the real source contract.

    Returns:
        Wall time, actual hash counts/bytes, summed child and supervisor durations,
        and per-request authorization checks. Concurrent durations may overlap.

    Raises:
        RuntimeError: If any request leaks a lease.
    """
    hashes: list[tuple[int, float, float]] = []

    async def supervise(
        target: Callable[..., None], arguments: tuple[Any, ...], timeout: float | None
    ) -> Any:
        """Instrument only verification; preserve its original supervisor.

        Args:
            target: Production native process target.
            arguments: Original authorized target arguments.
            timeout: Original process deadline in seconds.

        Returns:
            Unmodified production result.
        """
        if target is not source_files.verify_source_file:
            return await run_bounded_process(target, arguments, timeout)
        start = time.perf_counter()
        result, byte_count, child_seconds = await run_bounded_process(
            measured_verification, arguments, timeout
        )
        hashes.append((byte_count, child_seconds, time.perf_counter() - start))
        return result

    checks_before = authority.check_count
    start = time.perf_counter()
    with patch.object(source_files, "run_bounded_process", supervise):
        await asyncio.gather(*(invoke() for _ in range(callers)))
    elapsed = time.perf_counter() - start
    if authority.leases:
        raise RuntimeError("Benchmark operation leaked a source lease")
    return {
        "callers": callers,
        "elapsed_seconds": elapsed,
        "hash_calls": len(hashes),
        "hash_bytes": sum(entry[0] for entry in hashes),
        "verification_child_seconds_sum": sum(entry[1] for entry in hashes),
        "verification_supervised_seconds_sum": sum(entry[2] for entry in hashes),
        "authorization_checks": authority.check_count - checks_before,
    }


async def benchmark(
    directory: Path, sizes: list[int], repetitions: int
) -> list[dict[str, Any]]:
    """Measure cold result caches, warm caches and concurrent private requests.

    Args:
        directory: Directory reserved for generated benchmark TIFFs.
        sizes: Approximate pixel payload sizes in MiB; one, 64 and 256 by default.
        repetitions: Independent repetitions with fresh service/result caches.

    Returns:
        Raw samples and per-field medians for each operation and cache state.

    Raises:
        ValueError: If sizes do not describe positive square tiled rasters.
    """
    rows: list[dict[str, Any]] = []
    for size in sizes:
        if size <= 0:
            raise ValueError("Raster sizes must be positive")
        dimension = int((size * 1024**2 / 4) ** 0.5)
        if dimension % 256 or dimension * dimension * 4 != size * 1024**2:
            raise ValueError(
                "Sizes must describe square float32 rasters tiled in 256-pixel blocks"
            )
        sources = {
            char
            * 32: write_source(directory / f"{size}mib-{char}.tif", dimension, index)
            for index, char in enumerate(("b", "c"))
        }
        references = [
            RunArtifactReference(kind="runArtifact", jobId=_RUN, artifactId=file)
            for file in sources
        ]
        for operation in ("statistics", "paired_statistics", "metadata"):
            samples: dict[str, list[dict[str, int | float]]] = {}
            for _ in range(repetitions):
                authority = FileAuthority(sources)
                files = LeasedSourceFiles(
                    authority.acquire,
                    authority.release,
                    authority.check,
                    authority.renew,
                )
                access = RasterSourceAccess(authority, files)
                service = RasterStatisticsService(
                    access, read_concurrency=2, cache_entries=16
                )

                async def invoke() -> Any:
                    """Call one complete public service operation with owned source IDs.

                    Returns:
                        Real metadata or numerical statistics response.
                    """
                    if operation == "metadata":
                        return await access.describe(references[0], _OWNER)
                    if operation == "statistics":
                        return await service.get(
                            RasterStatisticsSourceRequest(source=references[0]), _OWNER
                        )
                    return await service.get_paired(
                        RasterPairSourceRequest(
                            xRaster=references[0], yRaster=references[1]
                        ),
                        _OWNER,
                    )

                for state, callers in (
                    ("first", 1),
                    ("repeated", 1),
                    ("concurrent_warm", 2),
                    ("concurrent_cold", 2),
                ):
                    if state == "concurrent_cold":
                        service = RasterStatisticsService(
                            access, read_concurrency=2, cache_entries=16
                        )
                    result = await measure(invoke, authority, callers)
                    samples.setdefault(state, []).append(result)
            for state, values in samples.items():
                row = {
                    "payload_mib_per_file": size,
                    "file_bytes": [source.size for source in sources.values()],
                    "operation": operation,
                    "state": state,
                    "result_cache": (
                        "none"
                        if operation == "metadata"
                        else (
                            "cold" if state in {"first", "concurrent_cold"} else "warm"
                        )
                    ),
                    "samples": values,
                    "median": {
                        key: statistics.median(value[key] for value in values)
                        for key in values[0]
                    },
                }
                rows.append(row)
                print(
                    json.dumps(
                        {key: value for key, value in row.items() if key != "samples"}
                    ),
                    flush=True,
                )
    return rows


def main() -> None:
    """Parse benchmark options, run real reads and save reproducible JSON evidence.

    Raises:
        ValueError: If repeat counts or raster sizes are invalid.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--sizes-mib", type=int, nargs="+", default=[1, 64, 256])
    parser.add_argument("--repetitions", type=int, default=3)
    options = parser.parse_args()
    if options.repetitions < 1:
        raise ValueError("Repetitions must be positive")
    options.output.parent.mkdir(parents=True, exist_ok=True)
    directory = options.output.parent / "synthetic-rasters"
    directory.mkdir(exist_ok=True)
    report = {
        "commit": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], text=True
        ).strip(),
        "tracked_changes": subprocess.check_output(
            ["git", "status", "--short", "--untracked-files=no"], text=True
        ).strip(),
        "platform": platform.platform(),
        "python": platform.python_version(),
        "rasterio": rasterio.__version__,
        "gdal": rasterio.__gdal_version__,
        "numpy": np.__version__,
        "conditions": "Synthetic uncompressed tiled float32; warm OS cache; local disk; in-memory authority; real checksum, process supervision and numerical readers. No production latency inference.",
        "repetitions": options.repetitions,
        "rows": asyncio.run(
            benchmark(directory, options.sizes_mib, options.repetitions)
        ),
    }
    options.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
