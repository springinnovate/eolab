"""Replay measured Habitat timings without running GDAL or the scientific model.

Run `python scripts/benchmark_habitat_eta.py` from an EOLab environment.
The fixture contains durations and counts from 24 Wisconsin-sized native runs
through verified file publication, using the 500 m Earth Engine grid, 128-pixel
prepared tiles, 800 Wisconsin Natural Area reference polygons rasterized for
the test, and synthetic predictor/response values. The first 16 runs supply
history for the final eight. Production reads the equivalent history from the
owner's completed runs. This replay introduces no holdout data into that history.
"""

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from statistics import median
from typing import Any

import numpy as np

from eolab_app.processing.habitat_runtime import estimate_habitat_completion


def replay_workload(run: dict[str, Any]) -> dict[str, Any]:
    """Reconstruct the area and band descriptors available at admission.

    Args:
        run: One anonymized fixture run with its original workload labels.

    Returns:
        Counts in the admission contract, with stable area labels for repeat use.
    """
    predictors, responses = (20, 18) if run["stack"] == "full" else (5, 2)
    return {
        "mode": "earthEngine",
        "predictors": predictors,
        "responses": responses,
        "folds": 5,
        "masks": 1 + int(run["outputMask"]),
        "tiles": run["tiles"],
        "tileCells": 128**2,
        "sourceArea": run["area"],
    }


def checkpoint(
    run: dict[str, Any], phases: list[str], name: str
) -> tuple[list[dict[str, Any]], datetime, float]:
    """Replay the work a status reader could see at a particular checkpoint.

    Args:
        run: Captured durations, stage totals and two measured within-stage offsets.
        phases: Native phase order, shared by all runs in this fixture.
        name: Admission, final alignment block, or the first half-finished prediction window count.

    Returns:
        Already observed stages, snapshot time and actual seconds left until ready.
        The last value is used only for scoring, after the forecast.
    """
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    now = start
    observed = []
    if name != "admission":
        current = (
            "preparing_rasters" if name == "aligned" else "Predicting raster windows"
        )
        for phase, seconds, total in zip(
            phases, run["seconds"], run["units"], strict=True
        ):
            first = now
            if phase == current:
                done, elapsed = (
                    (total, run["endAlignment"])
                    if name == "aligned"
                    else run["halfPrediction"]
                )
                now += timedelta(seconds=elapsed)
            else:
                now += timedelta(seconds=seconds)
                done = total
            observed.append(
                {
                    "phase": phase,
                    "startedAt": first.isoformat(),
                    "endedAt": None if phase == current else now.isoformat(),
                    "lastProgressAt": now.isoformat(),
                    "completed": done,
                    "total": total,
                }
            )
            if phase == current:
                break
    return observed, now, sum(run["seconds"]) - (now - start).total_seconds()


def report_holdout(fixture: Path) -> None:
    """Print time-range coverage, widths and absolute errors at three checkpoints.

    Args:
        fixture: Path to the recorded Wisconsin workloads, durations and progress counts.
    """
    samples = json.loads(fixture.read_text(encoding="utf-8"))
    phases = samples["phases"]
    training = [run for run in samples["runs"] if run["run"].startswith("train-")]
    holdout = [run for run in samples["runs"] if run["run"].startswith("hold-")]
    history = [
        {
            "work": replay_workload(run),
            "cells": run["grid"][0] * run["grid"][1],
            "stages": {
                phase: {"seconds": duration, "total": total, "position": position}
                for position, (phase, duration, total) in enumerate(
                    zip(phases, run["seconds"], run["units"], strict=True)
                )
            },
        }
        for run in reversed(training)
    ]
    print(
        "checkpoint  estimates  abs-error p50/p90 (s)   median width (s)   covered    historical median abs-error p50/p90 (s)"
    )
    for label in ("admission", "aligned", "prediction"):
        errors, widths, covered, baseline_errors = [], [], [], []
        for run in holdout:
            observed, now, actual = checkpoint(run, phases, label)
            summary = {"timingWork": replay_workload(run), "timingHistory": history}
            if observed:
                width, height = run["grid"]
                summary["grid"] = {"width": width, "height": height}
            estimate = estimate_habitat_completion(summary, observed, now)
            lower, upper = estimate["lowerSeconds"], estimate["upperSeconds"]
            if lower is None:
                continue
            baseline = median(
                checkpoint(other, phases, label)[2]
                for other in training
                if other["stack"] == run["stack"]
            )
            errors.append(abs((lower + upper) / 2 - actual))
            baseline_errors.append(abs(baseline - actual))
            widths.append(upper - lower)
            covered.append(lower <= actual <= upper)
        if errors:
            print(
                f"{label:<11} {len(errors)}/{len(holdout)}"
                f"        {median(errors):.2f} / {np.percentile(errors,90):.2f}"
                f"              {median(widths):.2f}             {sum(covered)}/{len(covered)}"
                f"                     {median(baseline_errors):.2f} / {np.percentile(baseline_errors,90):.2f}"
            )
        else:
            print(f"{label:<11} 0/{len(holdout)}")


if __name__ == "__main__":
    report_holdout(
        Path(__file__).resolve().parents[1]
        / "tests/fixtures/habitat-eta-wisconsin.json"
    )
