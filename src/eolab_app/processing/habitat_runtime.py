"""Forecast time to verified Habitat outputs from comparable completed runs."""

from datetime import datetime
import hashlib
from math import ceil, floor, log2
from typing import Any

from eolab_app.processing.habitat_earth_engine import HabitatCacheCoverage
from eolab_app.processing.habitat_models import HabitatEarthEngineStack, HabitatRequest
from eolab_app.processing.model_yaml import encode_canonical_json

FIT = "Fitting response models"
PREDICT = "Predicting raster windows"


def describe_habitat_workload(
    request: HabitatRequest, coverage: HabitatCacheCoverage | None
) -> dict[str, Any]:
    """Count selected inputs and previously inspected tiles for a comparable-run forecast.

    Args:
        request: Admitted model selection and scientific settings.
        coverage: The existing admission check's current tile counts for prepared inputs.
            Manual inputs acquire their grid size during ordinary worker preparation.

    Returns:
        Private numerical work descriptors and an opaque identifier for repeat use
        of the same input area. Reference and output-mask changes do not change that
        identifier. No raster or polygon is opened to estimate work.
    """
    stack = request.stack
    if isinstance(stack, HabitatEarthEngineStack):
        predictors, responses, tile_cells = stack.selected_grid_work()
        input_key = ["earthEngine", stack.year]
    else:
        predictors, responses = len(stack.predictors), len(stack.responses)
        # Manual whole-raster grids follow the first predictor. With an explicit
        # area the fixed calculation grid survives predictor and response edits.
        input_key = (
            stack.predictors[0].source.model_dump(mode="json")
            if request.wholeRaster
            else "manual"
        )
        tile_cells = None
    area = (
        request.catalogSelection
        or request.polygonArea
        or request.selectedBounds
        or request.samplingBox
    )
    source_area = hashlib.sha256(
        encode_canonical_json(
            [input_key, area.model_dump(mode="json") if area else "wholeRaster"]
        )
    ).hexdigest()
    return {
        "mode": "earthEngine" if coverage is not None else "manual",
        "predictors": predictors,
        "responses": responses,
        "folds": request.settings.fold_count,
        "masks": int(request.references.kind == "raster")
        + int(request.habitat_mask is not None),
        "tiles": None if coverage is None else coverage.cached_tiles,
        "tileCells": tile_cells,
        "sourceArea": source_area,
    }


def _covered_cells(work: dict[str, Any], grid_cells: int | None) -> int | None:
    """Approximate occupied work from admitted coverage and the calculated grid.

    Args:
        work: Selected inputs and optional admission tile count.
        grid_cells: Size of the raster bounding box, once known.

    Returns:
        A positive cell count on the model grid, or None before a manual grid is known.
    """
    if work["tiles"] is None:
        return grid_cells
    tile_cells = work["tiles"] * work["tileCells"]
    return min(grid_cells, tile_cells) if grid_cells else tile_cells


def _stage_work(
    phase: str,
    work: dict[str, Any],
    cells: int,
    occupied: int,
    fitted_responses: float,
) -> float:
    """Estimate stage work using counts available before that stage has started.

    Args:
        phase: Stage from the observed Habitat workflow.
        work: Input counts and scientific settings captured at admission.
        cells: Cells in the rectangular output grid, estimated from tiles until known.
        occupied: Approximate cells covered by available inputs.
        fitted_responses: Response count from screening, or a comparable run's acceptance rate.

    Returns:
        Relative work in consistent units for comparisons of this same stage.
    """
    predictors, responses = work["predictors"], work["responses"]
    if phase == "opening_habitat_inputs":
        return occupied * (predictors + responses)
    if phase == "preparing_rasters":
        return cells * (predictors + responses + work["masks"])
    if phase in (
        "Selecting sample pixels",
        "Reading sample values",
        "Preparing model samples",
    ):
        return occupied * (predictors + responses)
    if phase == FIT:
        return fitted_responses * (work["folds"] + 1) * predictors
    if phase == PREDICT:
        return occupied * (predictors + fitted_responses)
    if phase in ("finalizing_habitat_outputs", "publishing_outputs"):
        return cells * (1 + 3 * fitted_responses)
    return 1.0


def _remaining_seconds(
    sample: dict[str, Any],
    work: dict[str, Any],
    cells: int,
    occupied: int,
    observed: dict[str, dict[str, Any]],
    now: datetime,
) -> tuple[float, float, bool]:
    """Project one historical timeline onto the current inputs and observed work.

    Args:
        sample: One completed run's counts and sealed stage durations.
        work: Requested workload for the current run.
        cells: Current grid size, estimated from coverage until preparation finishes.
        occupied: Approximate count of cells covered by available inputs.
        observed: Current attempt's ordered stages keyed by phase.
        now: Status snapshot time for elapsed work in the active stage.

    Returns:
        Earliest and latest projected seconds through verified publication, and
        whether the active stage has outlasted this sample without new work.
    """
    old = sample["work"]
    previous = sample["stages"]
    # A run using only vector masks can skip raster alignment. JSONB does not
    # retain map order, so use the historical producer's chronological position.
    current_position = (
        previous[next(reversed(observed))]["position"] if observed else -1
    )
    old_units = previous.get(FIT, {}).get("total")
    old_fits = old_units / (old["folds"] + 1) if old_units else old["responses"]
    current_units = observed.get(FIT, {}).get("total")
    fits = (
        current_units / (work["folds"] + 1)
        if current_units
        else old_fits * work["responses"] / old["responses"]
    )
    old_occupied = _covered_cells(old, sample["cells"])
    remaining = 0.0
    unobserved_seconds = 0.0
    overdue = False
    for phase, historical in previous.items():
        stage = observed.get(phase)
        if historical["position"] < current_position or (
            stage and stage["endedAt"] is not None
        ):
            continue
        scale = _stage_work(phase, work, cells, occupied, fits) / _stage_work(
            phase,
            old,
            sample["cells"],
            old_occupied,
            old_fits,
        )
        seconds = historical["seconds"] * scale
        if stage:
            start = datetime.fromisoformat(stage["startedAt"])
            last = datetime.fromisoformat(stage["lastProgressAt"])
            elapsed = max(0.0, (now - start).total_seconds())
            measured = max(0.0, (last - start).total_seconds())
            done, total = stage.get("completed"), stage.get("total")
            # Files have different sizes. Keep the grid/response cost of hashing
            # the diagnostic stack even after the small primary file is verified.
            if phase != "publishing_outputs" and total and historical["total"]:
                factor = work["predictors"] / old["predictors"] if phase == FIT else 1.0
                if phase == PREDICT:
                    factor = (work["predictors"] + fits) / (
                        old["predictors"] + old_fits
                    )
                seconds = historical["seconds"] * total / historical["total"] * factor
            if phase != "publishing_outputs" and total and done and measured > 0:
                # Blend toward measured throughput as the stage supplies real work.
                fraction = done / total
                observed_total = measured / fraction
                weight = min(1.0, fraction * 2)
                seconds = (1 - weight) * seconds + weight * observed_total
            # Never turn a lease renewal into a unit of completed work. A stalled
            # stage can outlive the analogs; suppress its stale range in that case.
            overdue = elapsed > max(seconds * 1.5, measured + 2)
            elapsed_remaining = max(0.0, seconds - elapsed)
            if total and done is not None and done < total:
                # The upper bound takes credit through the latest measured unit.
                # A late poll alone cannot confirm that another window finished.
                unobserved_seconds = max(0.0, seconds - measured) - elapsed_remaining
            seconds = elapsed_remaining
        remaining += seconds
    return remaining, remaining + unobserved_seconds, overdue


def estimate_habitat_completion(
    summary: dict[str, Any],
    stages: list[dict[str, Any]],
    now: datetime,
) -> dict[str, int | None]:
    """Estimate remaining calculation and publication time from this owner's completed runs.

    Args:
        summary: Persisted workload, grid when available, and a small history captured
            once at admission. Queue latency is excluded from the historical durations.
        stages: Ordered actual-work snapshots for this attempt. Empty while queued.
        now: Current server time. Heartbeats never supply measured processing rates.

    Returns:
        Lower and upper remaining seconds, both absent when the workload lacks
        comparable observations or the current stage has outlasted those observations.
    """
    unsure = {"lowerSeconds": None, "upperSeconds": None}
    work = summary["timingWork"]
    grid = summary.get("grid")
    cells = grid["width"] * grid["height"] if grid else None
    occupied = _covered_cells(work, cells)
    history = summary.get("timingHistory", [])
    observed = {stage["phase"]: stage for stage in stages}
    comparable = []
    seen_areas: set[str] = set()
    current_repeat = any(h["work"]["sourceArea"] == work["sourceArea"] for h in history)
    # Eligible samples are returned newest first. Track repeats chronologically
    # as a locality hint, without assuming storage is still in the OS page cache.
    for sample in reversed(history):
        old = sample["work"]
        repeat = old["sourceArea"] in seen_areas
        seen_areas.add(old["sourceArea"])
        if (
            old["mode"] != work["mode"]
            or "publishing_outputs" not in sample["stages"]
            or not observed.keys() <= sample["stages"].keys()
        ):
            continue
        same_area = old["sourceArea"] == work["sourceArea"]
        if occupied is None and not same_area:
            continue
        target_occupied = occupied or sample["cells"]
        target_cells = cells or (sample["cells"] if same_area else target_occupied)
        ratios = (
            work["predictors"] / old["predictors"],
            work["responses"] / old["responses"],
            target_occupied / _covered_cells(old, sample["cells"]),
            target_cells / sample["cells"],
        )
        distance = sum(abs(log2(ratio)) for ratio in ratios)
        if any(ratio < 0.25 or ratio > 4 for ratio in ratios):
            continue
        proximity = distance + 0.5 * (current_repeat != repeat) + 0.25 * (not same_area)
        lower, upper, overdue = _remaining_seconds(
            sample, work, target_cells, target_occupied, observed, now
        )
        comparable.append((proximity, lower, upper, overdue))
    if len(comparable) < 3:
        return unsure
    # Use the nearest workload cohort. Bounded samples make status reads independent
    # of the total retained job count. Preserve spread across warm and cold storage.
    comparable.sort(key=lambda item: item[0])
    near = [row for row in comparable[:12] if row[0] <= comparable[2][0] + 0.25]
    upper = max(row[2] for row in near)
    if all(row[3] for row in near) or upper <= 0:
        return unsure
    lower = min(row[1] for row in near)
    return {
        "lowerSeconds": max(0, floor(lower * 0.8)),
        "upperSeconds": max(1, ceil(upper * 1.25)),
    }
