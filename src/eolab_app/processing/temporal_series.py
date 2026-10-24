"""Summarize one selected area separately for each available observation."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
import csv
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
from itertools import batched
from pathlib import Path
from threading import Lock
import time
from typing import Any, Literal

import numpy as np
import rasterio
from rasterio.windows import Window

from eolab_app.bounded_vector import PolygonRasterizer
from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing.aggregate_models import RasterAggregateLimits
from eolab_app.processing.artifacts import write_progress
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.raster_aggregate import get_raster_window_and_mask_source
from eolab_app.processing.raster_expression import Calculation, compile_expression
from eolab_app.processing.raster_mask import temporary_polygon_mask
from eolab_app.processing.statistics_csv import escape_spreadsheet_text
from eolab_app.processing.temporal_grid import (
    plan_temporal_grid,
    temporal_grid_windows,
)
from eolab_app.processing.temporal_series_models import (
    TemporalSeriesArtifact,
    TemporalSeriesSpec,
)
from eolab_app.raster.source_contract import (
    RASTER_VALIDITY_POLICY,
    read_native_raster_window,
)
from eolab_app.raster.temporal import (
    ResolvedTemporalInterval,
    TemporalObservation,
    TemporalRasterDataset,
)


def create_temporal_series(
    interval: ResolvedTemporalInterval,
    spec: TemporalSeriesSpec,
    directory: Path,
    limits: RasterAggregateLimits,
) -> TemporalSeriesArtifact:
    """Write one area statistic per observation to CSV, with its time support.

    Read two observations concurrently, retaining timestamp order in the CSV.
    Reuse one selected-area mask across the admitted common grid. Each row
    summarizes valid native cells with equal weights; observations are not
    combined, integrated or converted. Missing observations stay absent. An
    all-NoData observation retains its timestamp with an empty value, zero
    valid pixels and an explicit no_valid_data state for every statistic.

    Args:
        interval: Authorized nonempty observations kept unchanged during this run.
        spec: Accepted statistic, common native grid, area and output units.
        directory: Existing private attempt directory for results and progress.
        limits: Existing Processing lifecycle and geometry settings.

    Returns:
        Completed CSV metadata and row count. Provenance records source units,
        observation labels and intervals without source file locations.

    Raises:
        ProcessingError: If the selected area cannot be read or projected.
        OSError: If source, mask, CSV or provenance I/O fails.
        ValueError: If native decoding or result serialization fails.
        rasterio.errors.RasterioError: If a native source or mask cannot be read.
    """
    grid = spec.grid
    crop = Window(*grid.window)
    root = compile_expression(f"{spec.statistic}(a)", "a")
    result_path = directory / "result.csv"
    completed_tiles = 0
    total_tiles = grid.tileCount * len(interval.observations)
    last_progress = 0.0
    read_lock = Lock()
    with (
        rasterio.Env(GDAL_CACHEMAX=64 * 1024**2, GDAL_NUM_THREADS="2"),
        ExitStack() as resources,
        result_path.open("w", encoding="utf-8", newline="") as result,
    ):
        source = resources.enter_context(
            TemporalRasterDataset(interval.observations[0])
        )
        source.prepare_column_view(grid.columnRotation)
        _, polygons = get_raster_window_and_mask_source(source, spec.area, limits)
        if isinstance(polygons, PolygonRasterizer):
            resources.callback(polygons.close)
        mask = resources.enter_context(
            temporary_polygon_mask(source, crop, polygons, directory, limits)
        )
        if isinstance(polygons, PolygonRasterizer):
            polygons.close()
        writer = csv.writer(result)
        writer.writerow(
            (
                "time_utc",
                "interval_start_utc",
                "interval_end_utc",
                "variable",
                "statistic",
                "value",
                "unit",
                "valid_pixels",
                "state",
            )
        )
        variable = escape_spreadsheet_text(spec.source.variable)
        unit = escape_spreadsheet_text(spec.unit)
        write_progress(directory, "summarizing", 0, total_tiles)

        def summarize_observation(observation: TemporalObservation) -> dict[str, Any]:
            """Return one observation's area statistic using its own TIFF handle.

            Args:
                observation: Authorized timestamp and original TIFF metadata.

            Returns:
                Scalar value, validity state and valid-pixel count from Calculation.

            Raises:
                OSError: If source, mask or progress I/O fails.
                ValueError: If native decoding fails.
                rasterio.errors.RasterioError: If a source or mask cannot be read.
            """
            nonlocal completed_tiles, last_progress
            calculation = Calculation(root)
            with (
                rasterio.Env(GDAL_NUM_THREADS="2"),
                TemporalRasterDataset(observation) as dataset,
            ):
                dataset.prepare_column_view(grid.columnRotation)
                for window in temporal_grid_windows(grid):
                    values = read_native_raster_window(dataset, window)
                    valid = ~np.ma.getmaskarray(values)
                    if mask is not None:
                        mask_window = Window(
                            window.col_off - crop.col_off,
                            window.row_off - crop.row_off,
                            window.width,
                            window.height,
                        )
                        with read_lock:
                            valid &= mask.read(1, window=mask_window) != 0
                    calculation.process_tile(values.data.astype(np.float64), valid)
                    with read_lock:
                        completed_tiles += 1
                        if time.monotonic() - last_progress > 0.5:
                            write_progress(
                                directory, "summarizing", completed_tiles, total_tiles
                            )
                            last_progress = time.monotonic()
            return calculation.result()

        with ThreadPoolExecutor(max_workers=2) as readers:
            for observations in batched(interval.observations, 2):
                for observation, row in zip(
                    observations, readers.map(summarize_observation, observations)
                ):
                    writer.writerow(
                        (
                            observation.time.isoformat(),
                            observation.interval_start.isoformat(),
                            observation.interval_end.isoformat(),
                            variable,
                            spec.statistic,
                            row["value"],
                            unit,
                            row["aggregates"][0]["validPixels"],
                            row["state"],
                        )
                    )
        write_progress(directory, "summarizing", completed_tiles, total_tiles)
    with result_path.open("rb") as result:
        digest = hashlib.file_digest(result, "sha256").hexdigest()
    artifact = TemporalSeriesArtifact(
        size=result_path.stat().st_size,
        sha256=digest,
        filename="area-time-series.csv",
        row_count=len(interval.observations),
    )
    provenance = {
        **spec.model_dump(mode="json", by_alias=True),
        "observations": [
            {
                "time": observation.time.isoformat(),
                "referenceTime": (
                    observation.reference_time.isoformat()
                    if observation.reference_time is not None
                    else None
                ),
                "intervalStart": observation.interval_start.isoformat(),
                "intervalEnd": observation.interval_end.isoformat(),
            }
            for observation in interval.observations
        ],
        "inputUnit": interval.unit,
        "timeSupport": interval.time_support,
        "weighting": "equal_valid_pixel",
        "temporalAggregation": "none",
        "sourceValidity": RASTER_VALIDITY_POLICY,
        "allTouched": False,
        "standardDeviation": "population",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        **asdict(artifact),
    }
    (directory / "provenance.json").write_text(
        json.dumps(provenance, allow_nan=False), encoding="utf-8"
    )
    return artifact


def temporal_series_process_target(
    queue: ProcessResultWriter,
    operation: Literal["plan", "series"],
    arguments: tuple[Any, ...],
) -> None:
    """Run area-series planning or calculation in the existing native supervisor.

    Args:
        queue: Supervisor-owned single-result channel.
        operation: Common grid planning or per-observation area summarization.
        arguments: Validated arguments for the selected operation.
    """
    try:
        value = (
            plan_temporal_grid(*arguments)
            if operation == "plan"
            else create_temporal_series(*arguments)
        )
        queue.put(("ok", value))
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
            (
                "error",
                (
                    "processing_failed",
                    "The area time series could not be calculated.",
                    500,
                ),
            )
        )
