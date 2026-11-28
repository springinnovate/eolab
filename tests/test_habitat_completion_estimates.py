"""Check whole-run forecasts using the same stage snapshots as model status."""

from datetime import datetime, timedelta, timezone

from typing import Any

import pytest

from eolab_app.processing.habitat_runtime import estimate_habitat_completion
from eolab_app.processing.model_runs import compact_model_timings
from eolab_app.processing.model_run_contracts import ModelJobResponse
from eolab_app.processing.model_runs import serialize_model_job
from test_model_progress import model_row


def completed_alignment() -> dict[str, Any]:
    """Build an active alignment and three completed analogs for a deterministic forecast.

    Returns:
        An owned Habitat row with measured alignment, fitting, prediction and publication.
    """
    row = model_row("habitat.condition.v1", {})
    now = datetime.now(timezone.utc)
    start = now - timedelta(seconds=20)
    work = {
        "mode": "earthEngine",
        "predictors": 5,
        "responses": 2,
        "folds": 5,
        "masks": 1,
        "tiles": 4,
        "tileCells": 16384,
        "sourceArea": "a",
    }
    row["summary"].update(
        timingWork=work,
        grid={"width": 256, "height": 256},
        timingHistory=[
            {
                "work": work,
                "cells": 65536,
                "stages": {
                    "preparing_rasters": {"seconds": 20, "total": 8},
                    "Fitting response models": {"seconds": 10, "total": 12},
                    "Predicting raster windows": {"seconds": 28, "total": 4},
                    "publishing_outputs": {"seconds": 8, "total": 1},
                },
            }
            for _ in range(3)
        ],
    )
    row["progress"] = {
        "phase": "preparing_rasters",
        "completedBlocks": 8,
        "totalBlocks": 8,
        "stages": [
            {
                "phase": "preparing_rasters",
                "startedAt": start.isoformat(),
                "lastProgressAt": now.isoformat(),
                "endedAt": None,
                "completed": 8,
                "total": 8,
                "unit": "blocks",
            }
        ],
    }
    return row


def test_completed_alignment_still_forecasts_fitting_prediction_and_publication() -> (
    None
):
    """Show a whole-run range when the final alignment block has been counted."""
    row = completed_alignment()
    response = ModelJobResponse.model_validate(serialize_model_job(row)).model_dump()
    estimate = response["completionEstimate"]
    assert 0 < estimate["lowerSeconds"] <= 46 <= estimate["upperSeconds"]


@pytest.mark.parametrize(
    "status", ["cancelling", "cancelled", "failed", "interrupted", "expired", "deleted"]
)
def test_terminal_or_stopping_runs_end_the_forecast(status: str) -> None:
    """End the forecast as soon as a run no longer promises results.

    Args:
        status: Owned stopping or terminal status.
    """
    row = completed_alignment()
    row["status"] = status
    assert serialize_model_job(row)["completionEstimate"] is None


def test_sparse_history_queue_and_stalled_publication() -> None:
    """Only forecast comparable work; silent heartbeats cannot invent publication progress."""
    row = completed_alignment()
    summary = row["summary"]
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    unknown = {"lowerSeconds": None, "upperSeconds": None}
    assert (
        estimate_habitat_completion({**summary, "timingHistory": []}, [], now)
        == unknown
    )
    assert (
        estimate_habitat_completion(
            {**summary, "timingHistory": summary["timingHistory"][:2]}, [], now
        )
        == unknown
    )
    larger = {**summary["timingWork"], "responses": 25}
    assert (
        estimate_habitat_completion({**summary, "timingWork": larger}, [], now)
        == unknown
    )
    row["status"] = "queued"
    row["progress"] = {}
    assert serialize_model_job(row)["completionEstimate"]["upperSeconds"] >= 66
    stages = [
        {
            "phase": phase,
            "startedAt": now.isoformat(),
            "lastProgressAt": now.isoformat(),
            "endedAt": now.isoformat(),
        }
        for phase in summary["timingHistory"][0]["stages"]
    ]
    stages[-1].update(endedAt=None, completed=0, total=1)
    soon = estimate_habitat_completion(summary, stages, now + timedelta(seconds=2))
    assert soon["lowerSeconds"] <= 6 <= soon["upperSeconds"]
    first = estimate_habitat_completion(summary, stages, now)
    assert soon["upperSeconds"] == first["upperSeconds"]
    assert (
        estimate_habitat_completion(summary, stages, now + timedelta(seconds=60))
        == unknown
    )
    # A final counted file still awaits verification and the authoritative ready transition.
    stages[-1]["completed"] = 1
    assert (
        estimate_habitat_completion(summary, stages, now + timedelta(seconds=60))
        == unknown
    )


def test_screened_responses_and_observed_prediction_windows_change_the_forecast() -> (
    None
):
    """Use the actual fit and window totals, including work still due after the last fit."""
    row = completed_alignment()
    summary = row["summary"]
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    before = now - timedelta(seconds=10)
    alignment = {
        **row["progress"]["stages"][0],
        "startedAt": before.isoformat(),
        "lastProgressAt": before.isoformat(),
        "endedAt": before.isoformat(),
    }
    fit = {
        "phase": "Fitting response models",
        "startedAt": before.isoformat(),
        "lastProgressAt": now.isoformat(),
        "endedAt": None,
        "completed": 12,
        "total": 12,
    }
    both = estimate_habitat_completion(summary, [alignment, fit], now)
    one = estimate_habitat_completion(
        summary, [alignment, {**fit, "completed": 6, "total": 6}], now
    )
    assert both["lowerSeconds"] <= 36 <= both["upperSeconds"]
    assert 0 < one["upperSeconds"] < both["upperSeconds"]
    fit["endedAt"] = now.isoformat()
    prediction = {
        "phase": "Predicting raster windows",
        "startedAt": now.isoformat(),
        "lastProgressAt": now.isoformat(),
        "endedAt": None,
        "completed": 0,
        "total": 9,
    }
    compact = estimate_habitat_completion(summary, [alignment, fit, prediction], now)
    fragmented = estimate_habitat_completion(
        summary, [alignment, fit, {**prediction, "total": 27}], now
    )
    assert fragmented["lowerSeconds"] > compact["upperSeconds"]


def test_partial_training_records_never_supply_time_to_ready() -> None:
    """Exclude incomplete timing records and samples without observed publication."""
    row = completed_alignment()
    raw = {
        "work": row["summary"]["timingWork"],
        "grid": row["summary"]["grid"],
        "stages": row["progress"]["stages"],
    }
    assert compact_model_timings([raw, {**raw, "stages": []}]) == []
    samples = row["summary"]["timingHistory"]
    for sample in samples:
        del sample["stages"]["publishing_outputs"]
    assert serialize_model_job(row)["completionEstimate"] == {
        "lowerSeconds": None,
        "upperSeconds": None,
    }
