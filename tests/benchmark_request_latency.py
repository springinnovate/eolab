"""Measure bounded-process overhead separately from native raster work.

Run with --scratch pointing to a disposable workspace directory. No database,
HTTP, worker queue, browser polling, or production source is involved. Repeats
start fresh children unless --warm is selected. OS caches are not flushed.
There are no timing thresholds.
"""

import argparse
import asyncio
from contextlib import AsyncExitStack
from dataclasses import asdict
import json
from pathlib import Path
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import numpy as np
import rasterio
from rasterio.transform import from_origin

from eolab_app.execution.reusable_process import ReusableProcess, run_process
from eolab_app.processing.aggregate_models import (
    AggregateArea,
    AggregateSpec,
    NamedCalculation,
    RasterAggregateLimits,
)
from eolab_app.processing.raster_aggregate import aggregate_process_target
from eolab_app.raster.models import CatalogRasterRequest
from eolab_app.raster.source_identity import RasterSourceIdentity


def timed_target(writer, operation, arguments):
    """Time the real dispatch inside a fresh supervised child.

    Args:
        writer: Supervisor's one-result channel.
        operation: Existing plan or calculate action.
        arguments: Operation's native inputs.
    """
    started = time.perf_counter()

    class TimedWriter:
        """Attach duration without modifying the real dispatch or result."""

        def put(self, value):
            """Send one measured result to the parent.

            Args:
                value: Existing status and payload tuple.
            """
            writer.put((value, time.perf_counter() - started))

    aggregate_process_target(TimedWriter(), operation, arguments)


async def measure(operation, arguments, timeout, lane=None):
    """Measure parent wall time and child operation time independently.

    Args:
        operation: Existing native dispatch action.
        arguments: Dispatch arguments.
        timeout: Existing operation deadline in seconds.
        lane: Optional reusable process for this role.

    Returns:
        Successful native payload and timing measurements.
    """
    started = time.perf_counter()
    outcome = await run_process(timed_target, (operation, arguments), timeout, lane)
    (status, value), child = outcome.value
    elapsed = time.perf_counter() - started
    if status != "ok":
        raise RuntimeError(value)
    return value, {
        "roundTripSeconds": elapsed,
        "childOperationSeconds": child,
        "outsideOperationSeconds": elapsed - child,
        "process": asdict(outcome.timing) if outcome.timing else None,
    }


async def benchmark(scratch, repeats, warm=False):
    """Create one synthetic raster and measure real plan/calculate children.

    Args:
        scratch: Explicit root for unique disposable fixtures.
        repeats: Number of sequential planning/execution pairs.
        warm: Whether each role retains its own process between requests.
    """
    root = scratch.resolve()
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="latency-364-", dir=root) as temporary:
        directory = Path(temporary).resolve()
        assert directory.is_relative_to(root) and directory != root
        path = directory / "synthetic.tif"
        with rasterio.open(
            path,
            "w",
            driver="GTiff",
            width=256,
            height=256,
            count=1,
            dtype="uint16",
            crs="EPSG:4326",
            transform=from_origin(-80, 0, 0.01, 0.01),
            tiled=True,
            blockxsize=256,
            blockysize=256,
            compress="deflate",
        ) as dataset:
            dataset.write(np.full((256, 256), 7, dtype="uint16"), 1)
        signature = tuple(RasterSourceIdentity.read(path).to_catalog())
        area = AggregateArea(kind="wholeRaster")
        calculations = (NamedCalculation(label="Mean", expression="mean(a)"),)
        limits = RasterAggregateLimits()
        async with AsyncExitStack() as lifecycle:
            planner = executor = None
            if warm:
                planner, executor = ReusableProcess((timed_target,)), ReusableProcess(
                    (timed_target,)
                )
                for lane in (planner, executor):
                    lifecycle.push_async_callback(lane.close)
                    lane.warm()
            await repeat_measurements(
                directory,
                path,
                signature,
                area,
                calculations,
                limits,
                repeats,
                planner,
                executor,
            )


async def repeat_measurements(
    directory, path, signature, area, calculations, limits, repeats, planner, executor
):
    """Measure sequential operations while their source and process lanes exist.

    Args:
        directory: Confined output parent.
        path: Synthetic source raster.
        signature: Source identity shared by both modes.
        area: Requested calculation area.
        calculations: Requested expression set.
        limits: Unchanged operation limits.
        repeats: Number of samples.
        planner: Optional prestarted planning lane.
        executor: Optional prestarted execution lane.
    """
    for repeat in range(repeats):
        grid, planning = await measure(
            "plan",
            (path, signature, area, calculations, "a", limits, None),
            limits.plan_timeout_seconds,
            planner,
        )
        spec = AggregateSpec(
            sources={
                "a": CatalogRasterRequest(
                    collectionId="eolab-mounted-geotiffs",
                    itemId="geotiff-" + "0" * 24,
                )
            },
            sourceSignature=signature,
            area=area,
            calculations=calculations,
            grid=grid,
        )
        output = directory / str(repeat)
        output.mkdir()
        artifact, execution = await measure(
            "calculate", (path, spec, output, limits), limits.runtime_seconds, executor
        )
        assert float(artifact.rows[0]["value"]) == 7
        print(
            json.dumps(
                {
                    "platform": sys.platform,
                    "mode": "warm" if planner else "one-shot",
                    "pass": repeat + 1,
                    "sourcePixels": 65536,
                    "plan": planning,
                    "execution": execution,
                    "kernelSeconds": artifact.performance["kernelSeconds"],
                }
            ),
            flush=True,
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scratch", type=Path, required=True)
    parser.add_argument("--repeats", type=int, default=3, choices=range(1, 6))
    parser.add_argument("--warm", action="store_true")
    args = parser.parse_args()
    asyncio.run(benchmark(args.scratch, args.repeats, args.warm))
