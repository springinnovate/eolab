"""Verify per-observation area summaries from real TIFFs and their CSV results."""

import csv
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
from queue import SimpleQueue
from threading import Barrier, Event, Lock

import numpy as np
import pytest
import rasterio
from affine import Affine
from rasterio.crs import CRS
from rasterio.windows import Window

from eolab_app.processing.aggregate_models import AggregateArea, RasterAggregateLimits
from eolab_app.processing.polygon_areas import PolygonSummaryInput
from eolab_app.processing.temporal_grid import plan_temporal_grid
from eolab_app.processing.temporal_series import (
    create_temporal_series,
    temporal_series_process_target,
)
from eolab_app.processing.temporal_series_models import (
    AreaStatistic,
    TemporalSeriesArtifact,
    TemporalSeriesSpec,
)
from eolab_app.raster.source_models import TemporalIntervalSelection
from eolab_app.raster.source_contract import read_native_raster_window
from eolab_app.raster.temporal import (
    ResolvedTemporalInterval,
    TemporalObservation,
    TemporalRasterDataset,
)
from tests.test_temporal_reductions import _write_observation, interval


def calculate_series(
    source: ResolvedTemporalInterval,
    statistic: AreaStatistic,
    area: AggregateArea,
    directory: Path,
) -> tuple[TemporalSeriesSpec, TemporalSeriesArtifact, list[dict[str, str]]]:
    """Calculate a real native series and read its exported CSV.

    Args:
        source: Published TIFF observations and their original units.
        statistic: Spatial statistic applied independently to each observation.
        area: Selected area shared by all dates.
        directory: New private attempt directory.

    Returns:
        Accepted plan, completed artifact and exported rows.
    """
    directory.mkdir()
    limits = RasterAggregateLimits()
    spec = TemporalSeriesSpec(
        source=TemporalIntervalSelection(
            collectionId="eolab-temporal-datasets",
            itemId="weather",
            variable="temperature",
            startTime=source.observations[0].interval_start,
            endTime=source.observations[-1].time + timedelta(hours=1),
        ),
        statistic=statistic,
        area=area,
        grid=plan_temporal_grid(source, area, limits),
        unit="cells" if statistic == "count" else source.unit,
        timeSupport=source.time_support,
        observationCount=len(source.observations),
        firstObservation=source.observations[0].time,
        lastObservation=source.observations[-1].time,
    )
    artifact = create_temporal_series(source, spec, directory, limits)
    with (directory / "result.csv").open(encoding="utf-8", newline="") as stream:
        rows = list(csv.DictReader(stream))
    return spec, artifact, rows


@pytest.mark.parametrize("statistic", ["count", "sum", "mean", "min", "max", "stdev"])
def test_series_matches_each_observations_valid_cells(
    interval: ResolvedTemporalInterval, tmp_path: Path, statistic: AreaStatistic
) -> None:
    """Export each available date independently, preserving gaps and scalar values.

    Args:
        interval: Gapped TIFF observations containing NoData and nonfinite values.
        tmp_path: Isolated result root.
        statistic: Each supported statistic from the shared scalar engine.
    """
    directory = tmp_path / "result"
    spec, artifact, rows = calculate_series(
        interval, statistic, AggregateArea(kind="wholeRaster"), directory
    )
    valid = ([1, 2, 3, 5], [3, 4, 2, 7], [5, 6, 8, 4, 11, 9])
    expected = {
        "count": [4, 4, 6],
        "sum": [11, 16, 43],
        "mean": [2.75, 4, 43 / 6],
        "min": [1, 2, 4],
        "max": [5, 7, 11],
        "stdev": [float(np.std(values)) for values in valid],
    }[statistic]
    assert [float(row["value"]) for row in rows] == pytest.approx(expected)
    assert [row["valid_pixels"] for row in rows] == ["4", "4", "6"]
    assert [row["time_utc"] for row in rows] == [
        observation.time.isoformat() for observation in interval.observations
    ]
    assert all(row["state"] == "ok" and row["unit"] == spec.unit for row in rows)
    if statistic == "count":
        assert [row["value"] for row in rows] == ["4", "4", "6"]
    assert artifact.row_count == 3
    assert artifact.size == (directory / "result.csv").stat().st_size
    assert (
        artifact.sha256
        == hashlib.sha256((directory / "result.csv").read_bytes()).hexdigest()
    )
    provenance_text = (directory / "provenance.json").read_text()
    provenance = json.loads(provenance_text)
    assert all(
        observation.path.name not in provenance_text
        for observation in interval.observations
    )
    assert provenance["inputUnit"] == "K"
    assert provenance["weighting"] == "equal_valid_pixel"
    assert provenance["temporalAggregation"] == "none"
    assert len(provenance["observations"]) == len(rows)


def test_series_combines_multiple_native_tiles(
    interval: ResolvedTemporalInterval, tmp_path: Path
) -> None:
    """Accumulate one statistic across all native tiles of a selected observation.

    Args:
        interval: Time metadata for the new regional observation.
        tmp_path: Isolated TIFF and result root.
    """
    values = np.arange(1, 41, dtype="float32").reshape(2, 20)
    transform = Affine(0.5, 0, 10, 0, -0.5, 12)
    observation = replace(
        interval.observations[0],
        path=_write_observation(tmp_path / "wide.tif", values, transform, None),
        transform=transform,
        nodata=None,
    )
    source = replace(interval, observations=(observation,))
    spec, _, rows = calculate_series(
        source, "stdev", AggregateArea(kind="wholeRaster"), tmp_path / "result"
    )
    assert spec.grid.tileCount == 2
    assert rows[0]["valid_pixels"] == "40"
    assert float(rows[0]["value"]) == pytest.approx(float(np.std(values)))


def test_series_reads_two_observations_concurrently_and_writes_in_time_order(
    interval: ResolvedTemporalInterval,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Overlap real TIFF reads while retaining ordered values and complete progress.

    Args:
        interval: Three observations, including an odd final batch.
        tmp_path: Isolated result root.
        monkeypatch: Coordinate the first two native reads without timing assertions.
    """
    first, second, third = (item.path for item in interval.observations)
    together = Barrier(2, timeout=5)
    second_finished = Event()
    lock = Lock()
    active = peak = 0
    finished: list[Path] = []
    datasets: list[TemporalRasterDataset] = []

    def read_out_of_order(
        dataset: TemporalRasterDataset, window: Window
    ) -> np.ma.MaskedArray:
        """Read real pixels, making the second timestamp finish before the first.

        Args:
            dataset: Observation handle owned by the calling read thread.
            window: The calculation's spatial crop.

        Returns:
            Native values and validity from the original reader.
        """
        nonlocal active, peak
        path = Path(dataset.name)
        with lock:
            datasets.append(dataset)
            active += 1
            peak = max(peak, active)
        try:
            if path in (first, second):
                together.wait()
            if path == first:
                assert second_finished.wait(5)
            values = read_native_raster_window(dataset, window)
            with lock:
                finished.append(path)
            if path == second:
                second_finished.set()
            return values
        finally:
            with lock:
                active -= 1

    monkeypatch.setattr(
        "eolab_app.processing.temporal_series.read_native_raster_window",
        read_out_of_order,
    )
    directory = tmp_path / "result"
    _, _, rows = calculate_series(
        interval, "mean", AggregateArea(kind="wholeRaster"), directory
    )
    assert peak == 2 and active == 0
    assert finished == [second, first, third]
    assert all(dataset.native_dataset.closed for dataset in datasets)
    assert [float(row["value"]) for row in rows] == pytest.approx([2.75, 4, 43 / 6])
    assert [row["time_utc"] for row in rows] == [
        item.time.isoformat() for item in interval.observations
    ]
    assert json.loads((directory / "progress.json").read_text()) == {
        "phase": "summarizing",
        "completedBlocks": 3,
        "totalBlocks": 3,
    }


@pytest.mark.parametrize("statistic", ["count", "mean"])
def test_series_retains_all_nodata_rows_and_embedded_validity(
    interval: ResolvedTemporalInterval, tmp_path: Path, statistic: AreaStatistic
) -> None:
    """Keep null rows for present empty observations and honor native TIFF masks.

    Args:
        interval: Published observations modified before calculation begins.
        tmp_path: Isolated output directory.
        statistic: Count and a numeric statistic share the scalar empty-data state.
    """
    with rasterio.open(interval.observations[1].path, "r+") as raster:
        raster.write(np.full(raster.shape, -9999, dtype="float32"), 1)
    with rasterio.Env(GDAL_TIFF_INTERNAL_MASK=True):
        with rasterio.open(interval.observations[2].path, "r+") as raster:
            mask = np.zeros(raster.shape, dtype="uint8")
            mask[0, 3] = 255
            raster.write_mask(mask)
    _, _, rows = calculate_series(
        interval, statistic, AggregateArea(kind="wholeRaster"), tmp_path / "result"
    )
    assert len(rows) == 3
    assert rows[1]["value"] == ""
    assert rows[1]["valid_pixels"] == "0"
    assert rows[1]["state"] == "no_valid_data"
    assert float(rows[2]["value"]) == (1 if statistic == "count" else 8)
    assert rows[2]["valid_pixels"] == "1"


def test_series_uses_cell_centres_and_cleans_its_shared_polygon_mask(
    interval: ResolvedTemporalInterval, tmp_path: Path
) -> None:
    """Apply the same exact polygon to each date and remove its attempt-owned mask.

    Args:
        interval: Native TIFF observations on the same regional grid.
        tmp_path: Isolated output root.
    """
    polygons = PolygonSummaryInput(
        polygons=(
            {
                "type": "Polygon",
                "coordinates": [
                    [(11.1, 10.1), (12.8, 10.1), (11.1, 11.8), (11.1, 10.1)]
                ],
            },
        )
    )
    area = AggregateArea(
        kind="polygons",
        bounds=polygons.bounds(),
        geometryHash=polygons.geometry_hash(),
        geometries=tuple(item.model_dump() for item in polygons.polygons),
    )
    directory = tmp_path / "result"
    _, _, rows = calculate_series(interval, "sum", area, directory)
    assert [row["value"] for row in rows] == ["", "2.0", "4.0"]
    assert [row["valid_pixels"] for row in rows] == ["0", "1", "1"]
    assert not (directory / "polygon-mask.tif").exists()


@pytest.mark.parametrize("support", ["mean_rate", "accumulation"])
def test_series_preserves_interval_support_without_temporal_integration(
    interval: ResolvedTemporalInterval, tmp_path: Path, support: str
) -> None:
    """Summarize stored interval measurements without scaling or splitting them.

    Args:
        interval: Values reused as rates or accumulations on their declared intervals.
        tmp_path: Isolated output root.
        support: An interval-based source interpretation.
    """
    source = replace(
        interval,
        observations=tuple(
            replace(
                observation,
                interval_start=observation.time - timedelta(minutes=90),
                interval_end=observation.time,
            )
            for observation in interval.observations
        ),
        unit="kg m**-2 s**-1" if support == "mean_rate" else "J m**-2",
        time_support=support,
    )
    _, _, rows = calculate_series(
        source, "mean", AggregateArea(kind="wholeRaster"), tmp_path / "result"
    )
    assert [float(row["value"]) for row in rows] == pytest.approx([2.75, 4, 43 / 6])
    assert all(row["unit"] == source.unit for row in rows)
    assert [row["interval_start_utc"] for row in rows] == [
        observation.interval_start.isoformat() for observation in source.observations
    ]
    assert [row["interval_end_utc"] for row in rows] == [
        observation.interval_end.isoformat() for observation in source.observations
    ]


def test_series_preserves_cyclic_cells_across_dates(tmp_path: Path) -> None:
    """Select the same native edge cell in each global observation.

    Args:
        tmp_path: Isolated source and result directory.
    """
    transform = Affine(11.25, 0, -180, 0, -45, 67.5)
    start = datetime(2000, 1, 1, tzinfo=timezone.utc)
    observations = tuple(
        TemporalObservation(
            path=_write_observation(
                tmp_path / "archive" / f"global-{index}.tif",
                np.broadcast_to(np.arange(32) + index * 10, (3, 32)).astype("float32"),
                transform,
                None,
            ),
            time=start + timedelta(hours=index),
            reference_time=None,
            interval_start=start + timedelta(hours=index),
            interval_end=start + timedelta(hours=index),
            transform=transform,
            crs=CRS.from_epsg(4326),
            nodata=None,
            cyclic_x=True,
        )
        for index in range(3)
    )
    source = ResolvedTemporalInterval(observations, "K", "instantaneous")
    spec, _, rows = calculate_series(
        source,
        "mean",
        AggregateArea(kind="bounds", bounds=(-179, -10, -170, 10)),
        tmp_path / "result",
    )
    assert spec.grid.columnRotation != 0
    assert [float(row["value"]) for row in rows] == [0, 10, 20]
    assert [row["valid_pixels"] for row in rows] == ["1", "1", "1"]


def test_unreadable_observation_returns_native_failure_without_artifact(
    interval: ResolvedTemporalInterval, tmp_path: Path
) -> None:
    """Fail the whole attempt if a selected TIFF cannot be opened.

    Args:
        interval: TIFF observations whose second file is removed before the attempt.
        tmp_path: Isolated private output root.
    """
    spec, _, _ = calculate_series(
        interval,
        "mean",
        AggregateArea(kind="bounds", bounds=(10, 10, 14, 12)),
        tmp_path / "complete",
    )
    interval.observations[1].path.unlink()
    directory = tmp_path / "failed"
    directory.mkdir()
    queue: SimpleQueue[tuple[object, ...]] = SimpleQueue()
    temporal_series_process_target(
        queue, "series", (interval, spec, directory, RasterAggregateLimits())
    )
    assert queue.get() == (
        "error",
        (
            "temporal_read_failed",
            "The temporal input or result file could not be read or written.",
            409,
        ),
    )
    assert not (directory / "provenance.json").exists()
    assert not (directory / "polygon-mask.tif").exists()
