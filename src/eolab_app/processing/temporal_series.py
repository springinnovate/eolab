"""Summarize one selected area separately for each available observation."""

from collections.abc import Iterator
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from contextlib import ExitStack
import csv
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
from itertools import islice
from pathlib import Path
from threading import Lock
import time
from typing import Any, Literal

import numpy as np
import rasterio
from rasterio.windows import Window

from eolab_app.bounded_vector import PolygonRasterizer
from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing.aggregate_models import (
    AggregateArea,
    NamedCalculation,
    PixelPoint,
    RasterAggregateLimits,
)
from eolab_app.processing.artifacts import write_progress
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.raster_aggregate import (
    AREA_TILE_SIDE,
    TILE_SIDE,
    RasterAreaTools,
    accumulate_raster_tile,
    pixel_sample_window,
    prepare_raster_area_tools,
    read_raster_pixel_value,
)
from eolab_app.processing.raster_expression import (
    FUNCTIONS,
    Calculation,
    compile_expression,
    walk,
)
from eolab_app.processing.raster_mask import temporary_polygon_mask
from eolab_app.processing.statistics_csv import escape_spreadsheet_text
from eolab_app.processing.temporal_grid import (
    TemporalReadGrid,
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


def calculate_temporal_observations(
    interval: ResolvedTemporalInterval,
    area: AggregateArea,
    grid: TemporalReadGrid,
    calculations: tuple[NamedCalculation, ...],
    pixel_point: PixelPoint | None,
    directory: Path,
    limits: RasterAggregateLimits,
) -> Iterator[tuple[TemporalObservation, list[dict[str, Any]]]]:
    """Evaluate the same named formulas independently on each observation.

    Two readers start the next observation as soon as either finishes. Scalar
    results wait for earlier timestamps before being yielded in order.
    The selected-area mask and hectare calculator are prepared once and shared;
    their native reads are serialized. Point-only formulas read one cell per
    observation without preparing area geometry. Each observation retains the
    scalar engine's decimal strings, units, states and aggregate coverage.

    Args:
        interval: Authorized nonempty observations unchanged during the calculation.
        area: Validated selected area, ignored by point-only formulas.
        grid: Common native grid produced for these formulas and area.
        calculations: Validated named formulas using the raster alias a.
        pixel_point: WGS84 point supplied when a formula uses pixelValue.
        directory: Private attempt directory for the temporary mask and progress.
        limits: Existing Processing lifecycle and geometry settings.

    Yields:
        Observation metadata and ordered named scalar results. Missing dates
        remain absent; present NoData observations retain their result states.

    Raises:
        ProcessingError: If the area or hectare calculation fails.
        OSError: If source, mask or progress I/O fails.
        ValueError: If native decoding fails.
        rasterio.errors.RasterioError: If a source or mask cannot be read.
    """
    roots = [compile_expression(item.expression, "a") for item in calculations]
    functions = {
        node.op for root in roots for node in walk(root) if node.op in FUNCTIONS
    }
    pixel_only = functions == {"pixelValue"}
    crop = Window(*grid.window)
    completed_tiles = 0
    last_progress = 0.0
    read_lock = Lock()
    with (
        rasterio.Env(GDAL_CACHEMAX=64 * 1024**2, GDAL_NUM_THREADS="2"),
        ExitStack() as resources,
    ):
        source = resources.enter_context(
            TemporalRasterDataset(interval.observations[0])
        )
        source.prepare_column_view(grid.columnRotation)
        pixel_window = (
            pixel_sample_window(source, pixel_point)
            if "pixelValue" in functions
            else None
        )
        tools = (
            RasterAreaTools(crop, (), None)
            if pixel_only
            else prepare_raster_area_tools(
                source, area, limits, measure_hectares="areaha" in functions
            )
        )
        polygons = tools.selected_polygons
        if isinstance(polygons, PolygonRasterizer):
            resources.callback(polygons.close)
        mask = resources.enter_context(
            temporary_polygon_mask(source, crop, polygons, directory, limits)
        )
        if isinstance(polygons, PolygonRasterizer):
            polygons.close()
        hectares_calculator = tools.pixel_area_calculator
        tile_side = (
            AREA_TILE_SIDE
            if hectares_calculator is not None and not hectares_calculator.rectilinear
            else TILE_SIDE
        )
        point_reads = int(pixel_window is not None and bool(pixel_window.width))
        total_tiles = ((0 if pixel_only else grid.tileCount) + point_reads) * len(
            interval.observations
        )
        write_progress(directory, "summarizing", 0, total_tiles)

        def record_read() -> None:
            """Count a completed native read and periodically publish run progress."""
            nonlocal completed_tiles, last_progress
            with read_lock:
                completed_tiles += 1
                if time.monotonic() - last_progress > 0.5:
                    write_progress(
                        directory, "summarizing", completed_tiles, total_tiles
                    )
                    last_progress = time.monotonic()

        def summarize_observation(
            observation: TemporalObservation,
        ) -> list[dict[str, Any]]:
            """Return named formula results using one observation's own TIFF handle.

            Args:
                observation: Authorized timestamp and original TIFF metadata.

            Returns:
                Ordered named scalar results including raw values and coverage.

            Raises:
                ProcessingError: If the hectare calculation fails.
                OSError: If source, mask or progress I/O fails.
                ValueError: If native decoding fails.
                rasterio.errors.RasterioError: If a source or mask cannot be read.
            """
            with (
                rasterio.Env(GDAL_NUM_THREADS="2"),
                TemporalRasterDataset(observation) as dataset,
            ):
                dataset.prepare_column_view(grid.columnRotation)
                pixel_value = (
                    read_raster_pixel_value(dataset, pixel_window)
                    if pixel_window is not None
                    else None
                )
                if point_reads:
                    record_read()
                accumulators = [Calculation(root, pixel_value) for root in roots]
                for window in () if pixel_only else temporal_grid_windows(grid):
                    values = read_native_raster_window(dataset, window)
                    selection = None
                    if mask is not None:
                        mask_window = Window(
                            window.col_off - crop.col_off,
                            window.row_off - crop.row_off,
                            window.width,
                            window.height,
                        )
                        with read_lock:
                            selection = mask.read(1, window=mask_window).view(np.bool_)
                    for row in range(0, int(window.height), tile_side):
                        for column in range(0, int(window.width), tile_side):
                            local = Window(
                                column,
                                row,
                                min(tile_side, window.width - column),
                                min(tile_side, window.height - row),
                            )
                            tile = Window(
                                window.col_off + column,
                                window.row_off + row,
                                local.width,
                                local.height,
                            )
                            hectares = None
                            if hectares_calculator is not None:
                                with read_lock:
                                    hectares = hectares_calculator.calculate_hectares(
                                        tile
                                    )
                            accumulate_raster_tile(
                                accumulators,
                                values[local.toslices()],
                                (
                                    selection[local.toslices()]
                                    if selection is not None
                                    else None
                                ),
                                hectares,
                            )
                    record_read()
            return [
                {"label": item.label, "expression": item.expression, **result.result()}
                for item, result in zip(calculations, accumulators, strict=True)
            ]

        reader_count = 2
        with ThreadPoolExecutor(max_workers=reader_count) as readers:
            observations = iter(enumerate(interval.observations))
            pending = {
                readers.submit(summarize_observation, observation): index
                for index, observation in islice(observations, reader_count)
            }
            completed: dict[int, list[dict[str, Any]]] = {}
            next_result = 0
            while pending:
                finished, _ = wait(pending, return_when=FIRST_COMPLETED)
                for future in finished:
                    completed[pending.pop(future)] = future.result()
                for index, observation in islice(observations, len(finished)):
                    future = readers.submit(summarize_observation, observation)
                    pending[future] = index
                while next_result in completed:
                    yield interval.observations[next_result], completed.pop(next_result)
                    next_result += 1
        write_progress(directory, "summarizing", completed_tiles, total_tiles)


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
    result_path = directory / "result.csv"
    with result_path.open("w", encoding="utf-8", newline="") as result:
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
        calculations = (
            NamedCalculation(label=spec.statistic, expression=f"{spec.statistic}(a)"),
        )
        for observation, rows in calculate_temporal_observations(
            interval, spec.area, spec.grid, calculations, None, directory, limits
        ):
            row = rows[0]
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
