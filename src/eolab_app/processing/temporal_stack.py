"""Write Raster stack formula results over a temporal dataset to an owned CSV."""

import csv
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from typing import Any, Literal

import rasterio

from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing.aggregate_models import RasterAggregateLimits
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.statistics_csv import escape_spreadsheet_text
from eolab_app.processing.temporal_grid import plan_temporal_calculation_grid
from eolab_app.processing.temporal_series import calculate_temporal_observations
from eolab_app.processing.temporal_series_models import TemporalSeriesArtifact
from eolab_app.processing.temporal_stack_models import TemporalStackSpec
from eolab_app.raster.source_contract import RASTER_VALIDITY_POLICY
from eolab_app.raster.temporal import ResolvedTemporalInterval


def create_temporal_stack(
    interval: ResolvedTemporalInterval,
    spec: TemporalStackSpec,
    directory: Path,
    limits: RasterAggregateLimits,
) -> TemporalSeriesArtifact:
    """Write one named-formula result per observation using the temporal reader.

    Values retain Calculation's exact decimal strings and result states. Each
    row includes its reduction coverage because a custom formula may combine
    a clicked pixel with an area statistic having a different valid-cell count.
    Formula units follow the ordinary scalar engine; input units are recorded
    separately and are not assigned to arbitrary expressions.

    Args:
        interval: Authorized observations held unchanged throughout the run.
        spec: Captured formulas, point, area and common native grid.
        directory: Existing private attempt directory.
        limits: Existing Processing geometry and numerical settings.

    Returns:
        CSV file identity and the number of calculation rows written.

    Raises:
        ProcessingError: If an area cannot be read or projected.
        OSError: If a source or result file cannot be read or written.
        ValueError: If native decoding or JSON serialization fails.
        rasterio.errors.RasterioError: If native raster or mask reads fail.
    """
    path = directory / "result.csv"
    with path.open("w", encoding="utf-8", newline="") as result:
        writer = csv.writer(result)
        writer.writerow(
            (
                "time_utc",
                "interval_start_utc",
                "interval_end_utc",
                "variable",
                "calculation",
                "expression",
                "value",
                "value_type",
                "unit",
                "state",
                "aggregates",
            )
        )
        for observation, rows in calculate_temporal_observations(
            interval,
            spec.area,
            spec.grid,
            spec.metrics.calculations,
            spec.metrics.pixelPoint,
            directory,
            limits,
        ):
            for row in rows:
                writer.writerow(
                    (
                        observation.time.isoformat(),
                        observation.interval_start.isoformat(),
                        observation.interval_end.isoformat(),
                        escape_spreadsheet_text(spec.source.variable),
                        escape_spreadsheet_text(row["label"]),
                        escape_spreadsheet_text(row["expression"]),
                        row["value"],
                        row["valueType"],
                        row["unit"],
                        row["state"],
                        json.dumps(row["aggregates"], allow_nan=False),
                    )
                )
    with path.open("rb") as result:
        digest = hashlib.file_digest(result, "sha256").hexdigest()
    artifact = TemporalSeriesArtifact(
        size=path.stat().st_size,
        sha256=digest,
        filename="temporal-raster-stack.csv",
        row_count=len(interval.observations) * len(spec.metrics.calculations),
    )
    provenance = {
        **spec.model_dump(mode="json"),
        "observations": [
            {
                "time": observation.time.isoformat(),
                "referenceTime": (
                    observation.reference_time.isoformat()
                    if observation.reference_time
                    else None
                ),
                "intervalStart": observation.interval_start.isoformat(),
                "intervalEnd": observation.interval_end.isoformat(),
            }
            for observation in interval.observations
        ],
        "temporalAggregation": "none",
        "sourceValidity": RASTER_VALIDITY_POLICY,
        "numericInclusion": "cell_center",
        "areaInclusion": "fractional_cell_intersection",
        "pixelValue": "cell_containing_selected_point",
        "standardDeviation": "population",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        **asdict(artifact),
    }
    (directory / "provenance.json").write_text(
        json.dumps(provenance, allow_nan=False), encoding="utf-8"
    )
    return artifact


def temporal_stack_process_target(
    queue: ProcessResultWriter,
    operation: Literal["plan", "stack"],
    arguments: tuple[Any, ...],
) -> None:
    """Run temporal formula planning or CSV writing in the native supervisor.

    Args:
        queue: Supervisor-owned result channel.
        operation: Native grid planning or execution of the captured formulas.
        arguments: Validated arguments supplied by the operation adapter.
    """
    try:
        function = (
            plan_temporal_calculation_grid
            if operation == "plan"
            else create_temporal_stack
        )
        queue.put(("ok", function(*arguments)))
    except ProcessingError as error:
        queue.put(("error", (error.code, error.detail, error.status)))
    except (OSError, ValueError, rasterio.errors.RasterioError):
        queue.put(
            (
                "error",
                (
                    "temporal_read_failed",
                    "The temporal input or result file could not be read or written.",
                    409,
                ),
            )
        )
    except Exception:
        queue.put(
            ("error", ("processing_failed", "The temporal calculation failed.", 500))
        )
