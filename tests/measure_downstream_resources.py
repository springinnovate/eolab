"""Measure one reproducible downstream reference through the production native lane.

Run from the repository with its native development dependencies installed:
``python tests/measure_downstream_resources.py NEW_OUTPUT_DIRECTORY``.
The output directory must not exist. This is an explicit benchmark, not a
timing assertion in the normal test suite.
"""

import argparse
import asyncio
import json
from multiprocessing import active_children
from pathlib import Path
import time
from typing import Any

import psutil

from eolab_app.processing.downstream_calculation import (
    downstream_process_target,
    plan_downstream,
)
from eolab_app.processing.native_processes import create_native_process
from test_downstream_model import scaled_downstream_fixture


async def measure(
    directory: Path,
    width: int,
    height: int,
    buffer_metres: float,
    cutoff_metres: float | None,
) -> dict[str, Any]:
    """Measure wall time, child resident memory and scratch bytes for a sloping terrain.

    Args:
        directory: New isolated directory for sources, scratch and measurements.
        width: Native columns, within the installed routing-cell ceiling.
        height: Native rows, within the installed routing-cell ceiling.
        buffer_metres: Coverage buffer to include in this measurement.
        cutoff_metres: Optional distance from seeds to exercise exact distance work.

    Returns:
        Measured platform, dimensions, work result, elapsed time and resource peaks.

    Raises:
        ValueError: If requested dimensions exceed the benchmark's bounded fixture.
        FileExistsError: If the output directory already exists.
        ProcessingError: If preparation or native calculation rejects the case.
    """
    if width < 6 or height < 4 or width * height > 4_000_000:
        raise ValueError(
            "Choose 6 or more columns, 4 or more rows and at most four million cells"
        )
    directory.mkdir(parents=True, exist_ok=False)
    sources, request, limits = await asyncio.to_thread(
        scaled_downstream_fixture, directory / "sources", width, height
    )
    request = request.model_copy(
        update={"buffer_m": buffer_metres, "cutoff_m": cutoff_metres}
    )
    start = time.monotonic()
    plan = plan_downstream(sources, request, limits)
    preparation_seconds = time.monotonic() - start
    scratch = directory / "attempt"
    scratch.mkdir()
    native = create_native_process(limits)
    baseline_children = {child.pid for child in active_children()}
    start = time.monotonic()
    task = asyncio.create_task(
        native.run(
            downstream_process_target,
            ("calculate", (sources, plan, scratch, limits)),
            limits.runtime_seconds,
        )
    )
    rss = disk = descendants = 0
    descendant_names: set[str] = set()
    try:
        while not task.done():
            for child in active_children():
                if child.pid in baseline_children:
                    continue
                try:
                    process = psutil.Process(child.pid)
                    memory = process.memory_info()
                    rss = max(rss, memory.rss, getattr(memory, "peak_wset", 0))
                    children = process.children(recursive=True)
                    descendants = max(descendants, len(children))
                    descendant_names.update(child.name() for child in children)
                except psutil.NoSuchProcess:
                    pass
            sizes = []
            for path in scratch.rglob("*"):
                try:
                    if path.is_file():
                        sizes.append(path.stat().st_size)
                except FileNotFoundError:
                    pass
            disk = max(disk, sum(sizes))
            await asyncio.sleep(0.02)
        status, artifact = await task
        if status != "ok":
            raise RuntimeError(artifact)
        disk = max(
            disk,
            sum(path.stat().st_size for path in scratch.rglob("*") if path.is_file()),
        )
        report = {
            "platform": psutil.WINDOWS and "Windows" or "Linux",
            "width": width,
            "height": height,
            "bufferMetres": buffer_metres,
            "cutoffMetres": cutoff_metres,
            "preparationSeconds": preparation_seconds,
            "executionSecondsIncludingProcessStartup": time.monotonic() - start,
            "observedPeakResidentBytes": rss,
            "observedPeakScratchBytes": disk,
            "reservedScratchBytes": plan.reservedBytes,
            "nativeDescendants": descendants,
            "sum": artifact.rows[0]["value"],
            "descendantNames": sorted(descendant_names),
        }
        (directory / "measurements.json").write_text(
            json.dumps(report, indent=2), encoding="utf-8"
        )
        return report
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await native.close()


def main() -> None:
    """Parse the bounded benchmark dimensions and print the resulting measurements.

    Raises:
        RuntimeError: If the native operation cannot complete the reference case.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--width", type=int, default=1500)
    parser.add_argument("--height", type=int, default=1000)
    parser.add_argument("--buffer-metres", type=float, default=5000)
    parser.add_argument("--cutoff-metres", type=float)
    args = parser.parse_args()
    print(
        json.dumps(
            asyncio.run(
                measure(
                    args.directory,
                    args.width,
                    args.height,
                    args.buffer_metres,
                    args.cutoff_metres,
                )
            ),
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
