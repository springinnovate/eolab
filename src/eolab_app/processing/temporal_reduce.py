"""Calculate native-grid period statistics and valid-observation count rasters."""

from contextlib import ExitStack
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
import math
import mmap
from pathlib import Path
import time
from typing import Any, Iterator, Literal, cast

import numpy as np
from numpy.typing import NDArray
import rasterio
from rasterio.shutil import copy as copy_raster
from rasterio.windows import Window, transform as window_transform

from eolab_app.bounded_vector import PolygonRasterizer
from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing.aggregate_models import AggregateArea, RasterAggregateLimits
from eolab_app.processing.artifact_manifest import ProducedFile
from eolab_app.processing.artifacts import write_progress
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.raster_aggregate import get_raster_window_and_mask_source
from eolab_app.processing.raster_mask import temporary_polygon_mask
from eolab_app.processing.temporal_models import (
    TemporalMapArtifact,
    TemporalMapGrid,
    TemporalMapSpec,
    TemporalReduction,
)
from eolab_app.raster.source_contract import read_native_raster_window
from eolab_app.raster.temporal import ResolvedTemporalInterval, TemporalRasterDataset


def _tile_windows(grid: TemporalMapGrid) -> Iterator[Window]:
    """Yield native spatial blocks clipped to the selected crop.

    Args:
        grid: Native read dimensions and integral crop window.

    Yields:
        Integral source windows in increasing row and column order.
    """
    crop = Window(*grid.window)
    row_stop = math.ceil((crop.row_off + crop.height) / grid.tileHeight)
    column_stop = math.ceil((crop.col_off + crop.width) / grid.tileWidth)
    for row in range(int(crop.row_off) // grid.tileHeight, row_stop):
        for column in range(int(crop.col_off) // grid.tileWidth, column_stop):
            yield Window(
                column * grid.tileWidth,
                row * grid.tileHeight,
                grid.tileWidth,
                grid.tileHeight,
            ).intersection(crop)


def plan_temporal_map(
    interval: ResolvedTemporalInterval,
    area: AggregateArea,
    limits: RasterAggregateLimits,
) -> TemporalMapGrid:
    """Select an output crop and native read tiles without reading observation values.

    Args:
        interval: Authorized nonempty observations sharing their admitted native grid.
        area: Validated bounds, polygons, vector selection or whole-grid choice.
        limits: Existing Processing lifecycle and geometry settings.

    Returns:
        Native output grid, including the longitude view reused by every observation.

    Raises:
        ProcessingError: If the area cannot be projected or does not overlap.
        OSError: If source metadata cannot be read.
    """
    observation = interval.observations[0]
    with TemporalRasterDataset(observation) as dataset:
        window, polygons = get_raster_window_and_mask_source(dataset, area, limits)
        try:
            tile_height, tile_width = dataset.block_shapes[0]
            rotation, _ = ~observation.transform * (
                dataset.transform.c,
                dataset.transform.f,
            )
            rows = (
                math.ceil((window.row_off + window.height) / tile_height)
                - int(window.row_off) // tile_height
            )
            columns = (
                math.ceil((window.col_off + window.width) / tile_width)
                - int(window.col_off) // tile_width
            )
            return TemporalMapGrid(
                crs=dataset.crs.to_wkt(),
                transform=tuple(window_transform(window, dataset.transform))[:6],
                window=tuple(
                    int(value)
                    for value in (
                        window.col_off,
                        window.row_off,
                        window.width,
                        window.height,
                    )
                ),
                width=int(window.width),
                height=int(window.height),
                columnRotation=round(rotation),
                tileHeight=tile_height,
                tileWidth=tile_width,
                tileCount=rows * columns,
            )
        finally:
            if isinstance(polygons, PolygonRasterizer):
                polygons.close()


def _read_observations(
    interval: ResolvedTemporalInterval, window: Window, column_rotation: int
) -> Iterator[np.ma.MaskedArray]:
    """Read one native tile per observation with one shared longitude origin.

    Args:
        interval: Authorized observations in increasing label order.
        window: Integral native tile inside the planned longitude view.
        column_rotation: Source-column shift chosen when the area was planned.

    Yields:
        Native finite values with declared NoData cells masked.

    Raises:
        OSError: If native storage cannot be read.
        ValueError: If a source chunk is corrupt or escapes its archive.
    """
    for observation in interval.observations:
        with TemporalRasterDataset(observation) as dataset:
            dataset.prepare_column_view(column_rotation)
            yield read_native_raster_window(dataset, window)


def _reduce_ordered_values(
    interval: ResolvedTemporalInterval,
    window: Window,
    column_rotation: int,
    percentile: float,
    scratch: Path,
) -> tuple[NDArray[np.float64], NDArray[np.uint64]]:
    """Calculate exact linear percentiles using disk-backed observation rows.

    Args:
        interval: Authorized observations in label order.
        window: One native spatial tile.
        column_rotation: Planned source-column shift.
        percentile: Validated percentile between zero and one hundred.
        scratch: Attempt-owned file reused for this tile's temporary values.

    Returns:
        Two-dimensional percentile values and valid-observation counts.
        A cell with no valid observations has a NaN value and zero count.

    Raises:
        OSError: If source or scratch-file I/O fails.
        ValueError: If native decoding fails.
    """
    shape = (int(window.height), int(window.width))
    pixels = shape[0] * shape[1]
    observations = len(interval.observations)
    counts = np.zeros(pixels, dtype="uint64")
    result = np.full(pixels, np.nan, dtype="float64")
    size = pixels * observations * np.dtype("float64").itemsize
    try:
        with scratch.open("w+b") as stream:
            stream.truncate(size)
            with mmap.mmap(stream.fileno(), size) as storage:
                series = np.ndarray(
                    (pixels, observations), dtype="float64", buffer=storage
                )
                for index, values in enumerate(
                    _read_observations(interval, window, column_rotation)
                ):
                    valid = ~np.ma.getmaskarray(values)
                    series[:, index] = np.where(valid, values.data, np.nan).ravel()
                    counts += valid.ravel().astype("uint64")
                for pixel in range(pixels):
                    count = int(counts[pixel])
                    if count:
                        position = (count - 1) * percentile / 100
                        lower, upper = math.floor(position), math.ceil(position)
                        # NumPy orders NaNs after finite values. Partition works in
                        # place on this contiguous disk-backed row, not the cube.
                        series[pixel].partition((lower, upper))
                        low, high = series[pixel, lower], series[pixel, upper]
                        fraction = position - lower
                        result[pixel] = low * (1 - fraction) + high * fraction
                del series
    finally:
        scratch.unlink(missing_ok=True)
    return result.reshape(shape), counts.reshape(shape)


def _reduce_window(
    interval: ResolvedTemporalInterval,
    reduction: TemporalReduction,
    conversion_factor: float,
    window: Window,
    column_rotation: int,
    scratch: Path,
) -> tuple[NDArray[np.float64], NDArray[np.uint64]]:
    """Reduce one spatial tile while excluding each observation's missing cells.

    Args:
        interval: Authorized observations in increasing label order.
        reduction: Equal-weight statistic or integrated precipitation total.
        conversion_factor: Model-configured multiplier after rate times seconds;
            unused by instantaneous statistics.
        window: Integral native tile in the planned longitude view.
        column_rotation: Source-column shift shared by every observation.
        scratch: Attempt-owned temporary file for exact order statistics.

    Returns:
        Statistic values and valid counts, with NaN and zero for all-missing cells.

    Raises:
        OSError: If source or temporary-file I/O fails.
        ValueError: If native decoding fails.
        FloatingPointError: If the statistic overflows float64 arithmetic.
    """
    if reduction.reducer in {"median", "percentile"}:
        percentile = (
            50.0 if reduction.reducer == "median" else cast(float, reduction.percentile)
        )
        return _reduce_ordered_values(
            interval, window, column_rotation, percentile, scratch
        )
    shape = (int(window.height), int(window.width))
    counts = np.zeros(shape, dtype="uint64")
    result = np.zeros(shape, dtype="float64")
    variance_sum = (
        np.zeros(shape, dtype="float64") if reduction.reducer == "stdev" else None
    )
    for observation, values in zip(
        interval.observations, _read_observations(interval, window, column_rotation)
    ):
        valid = ~np.ma.getmaskarray(values)
        current = values.data[valid].astype("float64")
        previous_counts = counts[valid]
        counts[valid] += 1
        if reduction.reducer == "precipitation_total":
            seconds = (
                observation.interval_end - observation.interval_start
            ).total_seconds()
            result[valid] += current * seconds * conversion_factor
        elif reduction.reducer == "sum":
            result[valid] += current
        elif reduction.reducer in {"mean", "stdev"}:
            delta = current - result[valid]
            result[valid] += delta / counts[valid]
            if variance_sum is not None:
                variance_sum[valid] += delta * (current - result[valid])
        elif reduction.reducer == "min":
            result[valid] = np.where(
                previous_counts == 0, current, np.minimum(result[valid], current)
            )
        else:
            result[valid] = np.where(
                previous_counts == 0, current, np.maximum(result[valid], current)
            )
    present = counts > 0
    if variance_sum is not None:
        result[present] = np.sqrt(
            np.maximum(variance_sum[present], 0) / counts[present]
        )
    result[~present] = np.nan
    return result, counts


def _create_cog(
    stage: Path,
    destination: Path,
    grid: TemporalMapGrid,
    valid_pixels: int,
    unit: str,
) -> ProducedFile:
    """Convert a completed raster and verify its grid, validity mask and unit.

    Args:
        stage: Completed attempt-owned GeoTIFF to convert.
        destination: Ordinary COG result path in the same attempt.
        grid: Expected native output dimensions and georeferencing.
        valid_pixels: Number of cells that must remain valid after conversion.
        unit: Expected band unit.

    Returns:
        Completed file metadata and SHA-256 checksum for artifact publication.

    Raises:
        ProcessingError: If the generated file fails output-integrity checks.
        OSError: If conversion, verification or checksumming fails.
    """
    copy_raster(
        stage,
        destination,
        driver="COG",
        COMPRESS="DEFLATE",
        BLOCKSIZE=512,
        PREDICTOR="YES",
        OVERVIEW_RESAMPLING="NEAREST",
        NUM_THREADS="2",
        BIGTIFF="IF_SAFER",
    )
    with rasterio.open(destination) as result:
        if (
            result.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") != "COG"
            or result.width != grid.width
            or result.height != grid.height
            or result.count != 1
            or result.dtypes != ("float64",)
            or result.crs.to_wkt() != grid.crs
            or tuple(result.transform)[:6] != grid.transform
            or not math.isnan(result.nodata)
            or result.units != (unit,)
            or (max(result.shape) > 512 and not result.overviews(1))
        ):
            raise ProcessingError(
                "invalid_output", "The temporal result failed grid/COG validation.", 500
            )
        actual_valid = sum(
            int(np.count_nonzero(result.read_masks(1, window=window)))
            for _, window in result.block_windows(1)
        )
        if actual_valid != valid_pixels:
            raise ProcessingError(
                "invalid_output",
                "The temporal result failed validity-mask validation.",
                500,
            )
    with destination.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    stage.unlink()
    return ProducedFile(
        name="raster" if destination.stem == "result" else "count",
        storage_name=destination.name,
        filename=destination.name,
        media_type="image/tiff",
        size=destination.stat().st_size,
        sha256=digest,
    )


def create_temporal_map(
    interval: ResolvedTemporalInterval,
    spec: TemporalMapSpec,
    directory: Path,
    limits: RasterAggregateLimits,
) -> TemporalMapArtifact:
    """Write one period-statistic COG, its count COG and observation provenance.

    Args:
        interval: Authorized observations kept unchanged during this run.
        spec: Accepted native-grid plan and path-free source/area choices.
        directory: Private attempt directory owned and cleaned by Processing.
        limits: Existing Processing lifecycle and geometry settings.

    Returns:
        Primary statistic metadata, valid-cell count and the count-file inventory.
        All-missing areas still produce a valid result with zero count cells.

    Raises:
        ProcessingError: If numerical computation or output validation fails.
        OSError: If a native input or output cannot be read or written.
        ValueError: If native source decoding fails.
    """
    grid = spec.grid
    crop = Window(*grid.window)
    stage = directory / "statistic-stage.tif"
    count_stage = directory / "count-stage.tif"
    valid_pixels = count_pixels = 0
    last_progress = 0.0
    with (
        rasterio.Env(
            GDAL_CACHEMAX=64 * 1024**2,
            GDAL_NUM_THREADS="2",
            GDAL_TIFF_INTERNAL_MASK=True,
            CPL_TMPDIR=str(directory),
        ),
        ExitStack() as stack,
    ):
        source = stack.enter_context(TemporalRasterDataset(interval.observations[0]))
        source.prepare_column_view(grid.columnRotation)
        _, polygons = get_raster_window_and_mask_source(source, spec.area, limits)
        if isinstance(polygons, PolygonRasterizer):
            stack.callback(polygons.close)
        mask = stack.enter_context(
            temporary_polygon_mask(source, crop, polygons, directory, limits)
        )
        profile = dict(
            driver="GTiff",
            width=grid.width,
            height=grid.height,
            count=1,
            dtype="float64",
            crs=grid.crs,
            transform=window_transform(crop, source.transform),
            nodata=np.nan,
            tiled=True,
            blockxsize=512,
            blockysize=512,
            compress="DEFLATE",
            BIGTIFF="IF_SAFER",
        )
        with (
            rasterio.open(stage, "w", **profile) as statistic,
            rasterio.open(count_stage, "w", **profile) as count_raster,
        ):
            statistic.set_band_unit(1, spec.unit)
            count_raster.set_band_unit(1, "observations")
            statistic.update_tags(1, units=spec.unit, reducer=spec.reduction.reducer)
            count_raster.update_tags(1, units="observations")
            for index, window in enumerate(_tile_windows(grid), start=1):
                output_window = Window(
                    window.col_off - crop.col_off,
                    window.row_off - crop.row_off,
                    window.width,
                    window.height,
                )
                inside = (
                    mask.read(1, window=output_window) != 0
                    if mask is not None
                    else np.ones((int(window.height), int(window.width)), dtype=bool)
                )
                try:
                    with np.errstate(over="raise", invalid="raise"):
                        values, counts = _reduce_window(
                            interval,
                            spec.reduction,
                            spec.conversionFactor,
                            window,
                            grid.columnRotation,
                            directory / "ordered-values.bin",
                        )
                except FloatingPointError as error:
                    raise ProcessingError(
                        "numerical_error",
                        "The temporal statistic exceeds float64 arithmetic.",
                    ) from error
                valid = inside & (counts > 0)
                valid_pixels += int(np.count_nonzero(valid))
                count_pixels += int(np.count_nonzero(inside))
                statistic.write(
                    np.where(valid, values, np.nan), 1, window=output_window
                )
                statistic.write_mask(valid.astype("uint8") * 255, window=output_window)
                count_raster.write(
                    np.where(inside, counts.astype("float64"), np.nan),
                    1,
                    window=output_window,
                )
                count_raster.write_mask(
                    inside.astype("uint8") * 255, window=output_window
                )
                if time.monotonic() - last_progress > 0.5:
                    write_progress(directory, "reducing", index, grid.tileCount)
                    last_progress = time.monotonic()
        write_progress(directory, "creating_cog", grid.tileCount, grid.tileCount)
        result = _create_cog(
            stage, directory / "result.tif", grid, valid_pixels, spec.unit
        )
        count = _create_cog(
            count_stage, directory / "count.tif", grid, count_pixels, "observations"
        )
    artifact = TemporalMapArtifact(
        size=result.size,
        sha256=result.sha256,
        filename=result.filename,
        valid_pixels=valid_pixels,
        additional_outputs=(count,),
    )
    provenance = {
        **spec.model_dump(mode="json", by_alias=True),
        "observations": [
            {
                "time": item.time.isoformat(),
                "referenceTime": (
                    item.reference_time.isoformat() if item.reference_time else None
                ),
                "intervalStart": item.interval_start.isoformat(),
                "intervalEnd": item.interval_end.isoformat(),
            }
            for item in interval.observations
        ],
        "inputUnit": interval.unit,
        "availableDurationSeconds": sum(
            (item.interval_end - item.interval_start).total_seconds()
            for item in interval.observations
        ),
        "weighting": (
            "interval duration"
            if spec.reduction.reducer == "precipitation_total"
            else "equal observations"
        ),
        "allTouched": False,
        "standardDeviation": "population",
        "percentileMethod": "linear",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        **asdict(artifact),
    }
    (directory / "provenance.json").write_text(
        json.dumps(provenance, allow_nan=False), encoding="utf-8"
    )
    return artifact


def temporal_process_target(
    queue: ProcessResultWriter,
    operation: Literal["plan", "reduce"],
    arguments: tuple[Any, ...],
) -> None:
    """Run temporal planning or reduction under the existing native-process supervisor.

    Args:
        queue: Supervisor-owned single-result writer.
        operation: Metadata planning or raster reduction action.
        arguments: Picklable validated arguments for the selected operation.
    """
    try:
        value = (
            plan_temporal_map(*arguments)
            if operation == "plan"
            else create_temporal_map(*arguments)
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
                ("processing_failed", "The temporal map could not be calculated.", 500),
            )
        )
