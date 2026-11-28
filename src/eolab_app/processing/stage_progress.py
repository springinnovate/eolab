"""Capture actual stage transitions and work counts independently of lease renewals."""

from datetime import datetime, timezone
from pathlib import Path
from time import monotonic
from typing import Any

from eolab_app.processing.artifacts import write_progress_snapshot


def stage_start(phase: str, at: datetime | None = None) -> dict[str, Any]:
    """Start an unmeasured stage at its producer's clock.

    Args:
        phase: Operation-owned identifier.
        at: Actual event time, such as the database's worker claim.

    Returns:
        A stage record whose most recent work is its start.
    """
    timestamp = (
        (at or datetime.now(timezone.utc))
        .astimezone(timezone.utc)
        .isoformat(timespec="microseconds")
    )
    return {
        "phase": phase,
        "startedAt": timestamp,
        "lastProgressAt": timestamp,
        "endedAt": None,
    }


def stage_snapshot(stages: list[dict[str, Any]]) -> dict[str, Any]:
    """Expose the latest stage and the ordered observations through the ordinary job snapshot.

    Args:
        stages: Nonempty stage records in execution order.

    Returns:
        Existing current-phase fields with the additional timing history.
    """
    current = stages[-1]
    return {
        "stages": stages,
        **{
            key: current[key]
            for key in ("phase", "completed", "total", "unit")
            if key in current
        },
    }


def merge_stage_progress(
    previous: dict[str, Any], reported: dict[str, Any]
) -> dict[str, Any]:
    """Retain short stages and ignore older snapshots arriving after publication starts.

    Args:
        previous: Fenced attempt's last durable progress.
        reported: Producer's timestamped stage or cumulative native stage history.

    Returns:
        Latest work observations in start order, with earlier stages closed at the next event.
    """
    records = {
        (stage["startedAt"], stage["phase"]): stage.copy()
        for stage in previous.get("stages", ())
    }
    for stage in reported["stages"]:
        key = (stage["startedAt"], stage["phase"])
        saved = records.get(key)
        if saved is None or (stage["lastProgressAt"], stage.get("completed", -1)) >= (
            saved["lastProgressAt"], saved.get("completed", -1)
        ):
            records[key] = {
                **(saved or {}), **stage,
                "endedAt": stage.get("endedAt") or (saved and saved.get("endedAt")),
            }
    ordered = [records[key] for key in sorted(records)]
    for earlier, later in zip(ordered, ordered[1:]):
        earlier["endedAt"] = later["startedAt"]
    return stage_snapshot(ordered)


def close_stage_progress(
    progress: dict[str, Any], stopped_at: datetime
) -> dict[str, Any]:
    """Record when the active stage stopped and preserve the time of its last measured unit.

    Args:
        progress: Full, ordered attempt history.
        stopped_at: Actual verification or terminal acknowledgement time.

    Returns:
        A snapshot with the final stage closed for subsequent history reads.
    """
    final = progress["stages"][-1]
    end = stopped_at.astimezone(timezone.utc).isoformat(timespec="microseconds")
    return stage_snapshot([*progress["stages"][:-1], {**final, "endedAt": end}])


class NativeStageProgress:
    """Write bounded, cumulative stage records for one sequential native calculation."""

    def __init__(self, directory: Path) -> None:
        """Bind the writer to its confined attempt directory.

        Args:
            directory: Existing private attempt workspace.
        """
        self.directory = directory
        self.stages: list[dict[str, Any]] = []
        self.last_write = 0.0

    def report(
        self,
        phase: str,
        completed: int | None = None,
        total: int | None = None,
        unit: str | None = None,
    ) -> None:
        """Record a transition or work measurement, coalescing intermediate disk writes.

        Times are recorded at the callback, including the final block in a short stage.
        Repeated counts leave the last work timestamp unchanged.

        Args:
            phase: Identifier from the native operation.
            completed: Units actually finished, when measured.
            total: Total units in this stage when known.
            unit: User-readable unit for these counts.

        Raises:
            OSError: If a complete progress snapshot cannot be written.
        """
        changed = not self.stages or self.stages[-1]["phase"] != phase
        if changed:
            stage = stage_start(phase)
            if self.stages:
                self.stages[-1]["endedAt"] = stage["startedAt"]
            self.stages.append(stage)
        else:
            stage = self.stages[-1]
            if (stage.get("completed"), stage.get("total")) == (completed, total):
                return
        if completed is not None:
            if completed and completed != stage.get("completed"):
                stage["lastProgressAt"] = datetime.now(timezone.utc).isoformat(
                    timespec="microseconds"
                )
            stage.update(completed=completed, total=total, unit=unit)
        now = monotonic()
        if changed or completed == total or now - self.last_write >= 0.5:
            write_progress_snapshot(
                self.directory / "stage-progress.json", stage_snapshot(self.stages)
            )
            self.last_write = now
