"""Exercise operator preparation with real GeoTIFFs and the temporal Catalog reader."""

import asyncio
from contextlib import closing
import json
import math
from pathlib import Path
import sqlite3
import subprocess
import sys

import numpy
import pytest
import rasterio
from rasterio.transform import from_origin
import yaml

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "prepare_temporal_stack.py"


def run_cli(*args: str | Path, answers: str = "") -> subprocess.CompletedProcess[str]:
    """Run the actual operator commands with scripted interactive answers.

    Args:
        *args: CLI subcommand and paths or options.
        answers: Newline-delimited responses for draft mode.

    Returns:
        Exit status and the operator's output and diagnostics.
    """
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        input=answers,
        text=True,
        capture_output=True,
        check=False,
    )


def write_frame(
    path: Path, value: int, *, origin: float = 0, acquisition: str = ""
) -> None:
    """Write a single-band observation with known cells, grid and acquisition metadata.

    Args:
        path: New GeoTIFF location.
        value: Valid cell value for identifying each frame.
        origin: Western edge for testing shifted grids.
        acquisition: Optional value of the observation date tag.
    """
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        count=1,
        width=2,
        height=1,
        crs="EPSG:4326",
        transform=from_origin(origin, 1, 1, 1),
        dtype="int16",
        nodata=-1,
    ) as src:
        src.write(numpy.array([[value, -1]], dtype="int16"), 1)
        src.update_tags(TIFFTAG_DATETIME="2020:01:01 00:00:00")
        if acquisition:
            src.update_tags(ACQUISITION_DATE=acquisition)


def annual_manifest(root: Path) -> Path:
    """Draft a gapped annual series and complete its variable metadata as an operator.

    Args:
        root: Empty archive directory.

    Returns:
        Reviewed manifest for two annual totals.
    """
    write_frame(root / "rain_2022.tif", 22)
    write_frame(root / "rain_2024.tif", 24, acquisition="2024")
    result = run_cli("draft", root, answers="y\ntotal\ncalendar_year\n")
    assert result.returncode == 0, result.stderr
    manifest = root / "stack.yaml"
    stack = yaml.safe_load(manifest.read_text())
    assert [row["time"] for row in stack["observations"]] == ["2022", "2024"]
    stack["id"] = "rainfall"
    stack["variable"].update(id="rain", title="Rainfall", units="mm")
    manifest.write_text(yaml.safe_dump(stack))
    return manifest


def test_build_and_select_annual_archive(tmp_path: Path) -> None:
    """Read the original 2024 pixels through both exact and annual interval selections.

    Args:
        tmp_path: Empty source mount for the generated archive.
    """
    from eolab_app.raster.source_models import (
        TemporalIntervalSelection,
        TemporalRasterSelection,
        TemporalTimeQuery,
    )
    from eolab_app.raster.temporal_source import (
        get_temporal_observations,
        get_temporal_time_choices,
    )
    from tests.test_catalog_temporal import create_scanner, scan

    root = tmp_path / "annual"
    root.mkdir()
    manifest = annual_manifest(root)
    stack = yaml.safe_load(manifest.read_text())
    write_frame(root / "rain_2025.tif", 25)
    # A decimal-resolution window ending at 180 can round its east edge upward.
    for path in root.glob("*.tif"):
        with rasterio.open(path, "r+") as src:
            src.transform = from_origin(-180 + 3596 * 0.1, 1, 0.2, 1)
    # Operators may enter a different spelling on case-insensitive filesystems.
    (root / "frames").mkdir()
    stack["observations"][1]["file"] = (
        "RAIN_2024.TIF"
        if (root / "RAIN_2024.TIF").exists()
        else "frames/../rain_2024.tif"
    )
    stack["observations"].append({"file": "rain_2025.tif", "time": "2025"})
    manifest.write_text(yaml.safe_dump(stack))
    assert run_cli("build", manifest, "--check").returncode == 0
    assert not (root / "catalog.sqlite").exists()
    built = run_cli("build", manifest)
    assert built.returncode == 0, built.stderr
    with closing(sqlite3.connect(root / "catalog.sqlite")) as db:
        assert ("rain_2024.tif",) in list(db.execute("SELECT path FROM observations"))
        plan = db.execute(
            "EXPLAIN QUERY PLAN SELECT path FROM observations WHERE variable=? "
            "AND interval_start < ? AND interval_end > ? ORDER BY valid_time",
            ("rain", 1735689600, 1704067200),
        )
        assert any(
            "valid_time>?" in detail or "interval_end>?" in detail
            for *_, detail in plan
        )
    assert run_cli("build", manifest).returncode == 1
    manager, writer = create_scanner(tmp_path)
    assert asyncio.run(scan(manager))["errors"] == []
    ((key, item),) = writer.write_session.items.items()
    assert item["properties"]["eolab:time_labels"] == "calendar_year"
    assert item["bbox"] == pytest.approx([179.6, 0, 180, 1])
    ref = dict(collectionId=key[0], itemId=key[1], variable="rain")
    dates = get_temporal_time_choices(
        item, TemporalTimeQuery(**ref, month="2024-12"), tmp_path
    )
    assert dates.months == ("2022-12", "2024-12", "2025-12")
    assert dates.times == ("2025-01-01T00:00:00.000Z",)
    for selection in (
        TemporalRasterSelection(**ref, time=dates.times[0]),
        TemporalIntervalSelection(
            **ref, startTime="2024-01-01T00:00:00Z", endTime="2025-01-01T00:00:00Z"
        ),
    ):
        (frame,) = get_temporal_observations(item, selection, tmp_path)
        with rasterio.open(frame.path) as src:
            assert src.read(1, masked=True).tolist() == [[24, None]]


@pytest.mark.parametrize(
    ("epsg", "grid", "expected_longitudes", "point", "value"),
    [
        (4807, from_origin(0, 54, 0.01, 0.02), (2.33651, 2.35451), (2.341, 48.595), 24),
        (
            4807,
            from_origin(190, 54, 2, 0.02),
            (173.33828, 176.93817),
            (174, 48.595),
            24,
        ),
        (4807, from_origin(0, 54, 200, 0.02), (-180, 180), (-5, 48.595), 37),
        (
            4322,
            from_origin(-30, 90.04, 0.1, 0.2),
            (-29.99985, -29.79985),
            (-29.94985, 89.999),
            24,
        ),
        (
            4322,
            from_origin(-30, -89.84, 0.1, 0.2),
            (-29.99985, -29.79985),
            (-29.94985, -90),
            24,
        ),
        (
            4807,
            from_origin(20, 100, 0.11, 0.2),
            (-180, 180),
            (-161.28646, 89.99930275),
            24,
        ),
        (
            4807,
            from_origin(20, -99.84, 0.11, 0.2),
            (-180, 180),
            (-161.28646, -89.99930268),
            24,
        ),
    ],
    ids=[
        "paris",
        "eastern-grads",
        "global-grads",
        "north",
        "south",
        "north-grad-edge",
        "south-grad-edge",
    ],
)
def test_geographic_grid_footprint_and_original_pixel(
    tmp_path: Path,
    epsg: int,
    grid: rasterio.Affine,
    expected_longitudes: tuple[float, float],
    point: tuple[float, float],
    value: int,
) -> None:
    """Find an original geographic raster cell inside its WGS84 Catalog footprint.

    Args:
        tmp_path: Isolated Catalog mount.
        epsg: Native coordinate reference system for the source.
        grid: Raster transform in its native angular units.
        expected_longitudes: Western and eastern WGS84 Catalog bounds.
        point: Requested WGS84 position inside the first or wrapped last cell.
        value: Original raster sample at the requested position.
    """
    from eolab_app.raster.pixel import read_raster_pixel
    from eolab_app.raster.source_models import TemporalRasterSelection
    from eolab_app.raster.temporal_source import get_temporal_observations
    from tests.test_catalog_temporal import create_scanner, scan

    root = tmp_path / "rainfall"
    root.mkdir()
    manifest = annual_manifest(root)
    for path in root.glob("*.tif"):
        with rasterio.open(path, "r+") as src:
            src.crs = f"EPSG:{epsg}"
            src.transform = grid
            if path.name == "rain_2024.tif":
                src.write(numpy.array([[24, 37]], dtype="int16"), 1)
    built = run_cli("build", manifest)
    assert built.returncode == 0, built.stderr
    manager, writer = create_scanner(tmp_path)
    assert asyncio.run(scan(manager))["errors"] == []
    ((key, item),) = writer.write_session.items.items()
    west_deg, south, east_deg, north = item["bbox"]
    assert (west_deg, east_deg) == pytest.approx(expected_longitudes, abs=0.0001)
    assert west_deg <= point[0] <= east_deg and south <= point[1] <= north
    assert item["geometry"]["coordinates"][0][0] == [west_deg, south]
    axis = item["properties"]["cube:dimensions"]["x"]
    assert axis["reference_system"] == epsg
    assert axis["extent"] == pytest.approx([grid.c + grid.a / 2, grid.c + 1.5 * grid.a])
    query = TemporalRasterSelection(
        collectionId=key[0], itemId=key[1], variable="rain", time="2025-01-01T00:00:00Z"
    )
    (observation,) = get_temporal_observations(item, query, tmp_path)
    assert observation.path == root / "rain_2024.tif"
    assert read_raster_pixel(observation, *point).value == value


@pytest.mark.parametrize(
    ("west", "cell_width", "centers"),
    [
        (179.0, 1.0, (179.5, -179.5)),
        (-181.0, 1.0, (179.5, -179.5)),
        (230.0, 5.0, (-127.5, -122.5)),
        (0.0, 180.0, (90.0, -90.0)),
    ],
    ids=["east-crossing", "west-crossing", "shifted-region", "shifted-world"],
)
def test_shifted_web_mercator_reads_original_cells(
    tmp_path: Path, west: float, cell_width: float, centers: tuple[float, float]
) -> None:
    """Read the same original column by a WGS84 point and by a small area around it.

    Args:
        tmp_path: Catalog mount containing a prepared two-column archive.
        west: Longitude of the grid's native western edge, before wrapping.
        cell_width: Longitude span in degrees of each Web Mercator cell.
        centers: Expected WGS84 longitudes of the two native cell centers.
    """
    from eolab_app.raster.bounded_window import NoRasterBoundsOverlapError
    from eolab_app.raster.pixel import read_raster_pixel
    from eolab_app.raster.source_models import TemporalRasterSelection
    from eolab_app.raster.statistics import read_raster_statistics
    from eolab_app.raster.temporal_source import get_temporal_observations
    from eolab_app.sampling_area import SelectedBoundsSamplingArea
    from tests.test_catalog_temporal import create_scanner, scan

    root = tmp_path / "temperature"
    root.mkdir()
    manifest = annual_manifest(root)
    metres_per_degree = math.tau * 6378137 / 360
    for path in root.glob("*.tif"):
        with rasterio.open(path, "r+") as src:
            src.crs = "EPSG:3857"
            src.transform = from_origin(
                west * metres_per_degree, 1000, cell_width * metres_per_degree, 2000
            )
            src.write(numpy.array([[24, 37]], dtype="int16"), 1)
    built = run_cli("build", manifest)
    assert built.returncode == 0, built.stderr
    manager, writer = create_scanner(tmp_path)
    assert asyncio.run(scan(manager))["errors"] == []
    ((key, item),) = writer.write_session.items.items()
    query = TemporalRasterSelection(
        collectionId=key[0], itemId=key[1], variable="rain", time="2025-01-01T00:00:00Z"
    )
    (observation,) = get_temporal_observations(item, query, tmp_path)
    for column, (lon, value) in enumerate(zip(centers, (24, 37), strict=True)):
        pixel = read_raster_pixel(observation, lon, 0)
        assert (pixel.row, pixel.column, pixel.value) == (0, column, value)
        area = SelectedBoundsSamplingArea((lon - 0.1, -0.001, lon + 0.1, 0.001))
        stats = read_raster_statistics(observation, area)
        assert (stats.valid_sample_count, stats.sample_minimum) == (1, value)
    if cell_width < 180:
        assert not read_raster_pixel(observation, 0, 0).in_bounds
        with pytest.raises(NoRasterBoundsOverlapError):
            read_raster_statistics(
                observation, SelectedBoundsSamplingArea((-0.1, -0.001, 0.1, 0.001))
            )


@pytest.mark.parametrize("answer", ["y", "n"])
def test_conflicting_clues_and_declined_dates(tmp_path: Path, answer: str) -> None:
    """Retain every candidate for review and protect an edited draft.

    Args:
        tmp_path: Dedicated directory with one agreed and one disputed filename.
        answer: Whether the operator accepts the unambiguous suggestions.
    """
    write_frame(tmp_path / "frame_2024.tif", 1, acquisition="2023")
    write_frame(tmp_path / "frame_2022.tif", 2)
    write_frame(tmp_path / "frame_2025_02_29.tif", 3)
    write_frame(tmp_path / "undated.tif", 4)
    for stem in (
        "snow.2024.12.31",
        "snow_2024-7-15",
        "snow_2024-366",
        "snow_2025-01-02_08-30-42",
        "snow_2024-12-31T08h30m",
        "snow_20241231T083042Z",
        "snow_20241231T083042.000Z",
        "snow_20241231T083042.001Z",
    ):
        write_frame(tmp_path / f"{stem}.tif", 5)
    write_frame(
        tmp_path / "tagged.tif", 6, acquisition="2024-07-14T06:00:00.000000+00:00"
    )
    result = run_cli("draft", tmp_path, answers=f"{answer}\nsnapshot\n")
    assert result.returncode == 0, result.stderr
    manifest = tmp_path / "stack.yaml"
    text = manifest.read_text()
    assert "2024" in text and "dataset ACQUISITION_DATE: 2023" in text
    proposals = {
        row["file"]: row["time"] for row in yaml.safe_load(text)["observations"]
    }
    assert {name: date for name, date in proposals.items() if date is not None} == (
        {
            "frame_2022.tif": "2022",
            "snow.2024.12.31.tif": "2024-12-31",
            "snow_20241231T083042Z.tif": "2024-12-31T08:30:42Z",
            "snow_20241231T083042.000Z.tif": "2024-12-31T08:30:42.000Z",
            "tagged.tif": "2024-07-14T06:00:00.000000+00:00",
        }
        if answer == "y"
        else {}
    )
    assert run_cli("draft", tmp_path).returncode == 1
    assert manifest.read_text() == text


def test_invalid_dates_ranges_and_grid_are_reported(tmp_path: Path) -> None:
    """Reject conflicting annual frames and name all affected files before publication.

    Args:
        tmp_path: Archive containing a mixture of invalid observation rows.
    """
    manifest = annual_manifest(tmp_path)
    stack = yaml.safe_load(manifest.read_text())
    write_frame(tmp_path / "shifted.tif", 1, origin=0.5)
    write_frame(tmp_path / "wrapped.tif", 1, origin=240)
    write_frame(tmp_path / "off-pole.tif", 1)
    with rasterio.open(tmp_path / "off-pole.tif", "r+") as src:
        src.transform = from_origin(1, 99, 1, 1)
    stack["observations"].extend(
        [
            {"file": "shifted.tif", "time": "2023"},
            {"file": "wrapped.tif", "time": "2020"},
            {"file": "off-pole.tif", "time": "2019"},
            {"file": "short.tif", "time": {"start": "2024-05-01", "end": "2024-10-01"}},
            {"file": "bad.tif", "time": "2025-02-29"},
            {
                "file": "rain_2022.tif",
                "time": {"start": "2022-01-01", "end": "2023-01-01"},
            },
        ]
    )
    manifest.write_text(yaml.safe_dump(stack))
    failed = run_cli("build", manifest)
    assert failed.returncode == 1
    for message in (
        "shifted.tif: Different transform",
        "wrapped.tif: Reproject or shift the regional longitude grid",
        "off-pole.tif: The geographic grid has no valid latitude",
        "short.tif: Expected one complete calendar year",
        "bad.tif: day is out of range",
        "duplicate time or overlap",
    ):
        assert message in failed.stderr
    assert not (tmp_path / "catalog.sqlite").exists()
    assert not (tmp_path / "dataset.yaml").exists()


@pytest.mark.parametrize("name_tag", ["standard_name", "STANDARD_NAME"])
def test_measurements_with_identical_units(tmp_path: Path, name_tag: str) -> None:
    """Keep different declared measurements out of one indexed variable.

    Args:
        tmp_path: Archive containing equally sized rasters with matching units.
        name_tag: Spelling used by the GeoTIFF writer for its measurement tag.
    """
    manifest = annual_manifest(tmp_path)
    first, second = sorted(tmp_path.glob("*.tif"))
    with rasterio.open(first, "r+") as src:
        src.update_tags(**{name_tag: "precipitation_amount"})
    assert run_cli("build", manifest, "--check").returncode == 0
    with rasterio.open(second, "r+") as src:
        src.update_tags(1, **{name_tag: "runoff_amount"})
    result = run_cli("build", manifest)
    assert result.returncode == 1
    for clue in (first.name, second.name, "precipitation_amount", "runoff_amount"):
        assert clue in result.stderr
    assert not (tmp_path / "dataset.yaml").exists()


@pytest.mark.parametrize("tag_band", [0, 1], ids=["dataset", "band"])
def test_build_checks_temporal_cell_methods(tmp_path: Path, tag_band: int) -> None:
    """Reject an annual maximum labeled as a mean before publishing the archive.

    Args:
        tmp_path: Directory for two annual observations of the same variable.
        tag_band: Location of the conflicting CF metadata on the second frame.
    """
    manifest = annual_manifest(tmp_path)
    stack = yaml.safe_load(manifest.read_text())
    stack["variable"].update(id="temperature", units="degC", time_support="mean")
    manifest.write_text(yaml.safe_dump(stack))
    first, second = sorted(tmp_path.glob("*.tif"))
    for path in (first, second):
        with rasterio.open(path, "r+") as src:
            src.update_tags(standard_name="air_temperature", units="degC")
    with rasterio.open(first, "r+") as src:
        src.update_tags(cell_methods="area: maximum time: mean (interval: 1 day)")
    with rasterio.open(second, "r+") as src:
        src.update_tags(tag_band, CELL_METHODS="time: maximum")
    for options in (("--check",), ()):
        failed = run_cli("build", manifest, *options)
        assert failed.returncode == 1, failed.stderr
        assert all(word in failed.stderr for word in (second.name, "maximum", "mean"))
        assert not (tmp_path / "catalog.sqlite").exists()
        assert not (tmp_path / "dataset.yaml").exists()
    with rasterio.open(second, "r+") as src:
        src.update_tags(
            tag_band, CELL_METHODS="time: area: mean (comment: time: maximum)"
        )
    built = run_cli("build", manifest)
    assert built.returncode == 0, built.stderr


def test_units_in_geotiff_metadata(tmp_path: Path) -> None:
    """Report a conflicting band unit even when the dedicated GDAL unit matches.

    Args:
        tmp_path: Directory containing two observations reviewed as millimetres.
    """
    manifest = annual_manifest(tmp_path)
    first, second = sorted(tmp_path.glob("*.tif"))
    with rasterio.open(first, "r+") as src:
        src.update_tags(units="mm")
    with rasterio.open(second, "r+") as src:
        src.set_band_unit(1, "mm")
        src.update_tags(1, UNITS="cm")
    result = run_cli("build", manifest)
    assert result.returncode == 1
    for clue in (second.name, "cm", "mm"):
        assert clue in result.stderr
    assert not (tmp_path / "catalog.sqlite").exists()


@pytest.mark.parametrize("key", ["observations", "time"])
def test_duplicate_manifest_keys(tmp_path: Path, key: str) -> None:
    """Report the repeated YAML key and line before a row can be overwritten.

    Args:
        tmp_path: Directory with a reviewed archive manifest.
        key: Repeated field at the root or within one observation.
    """
    manifest = annual_manifest(tmp_path)
    original = manifest.read_text().splitlines()
    line = next(
        i for i, value in enumerate(original) if value.lstrip().startswith(key + ":")
    )
    original.insert(line, original[line])
    manifest.write_text("\n".join(original))
    result = run_cli("build", manifest, "--check")
    assert result.returncode == 1
    assert key in result.stderr and f"line {line + 2}" in result.stderr


@pytest.mark.parametrize("internal", [False, True])
def test_standalone_raster_mask(tmp_path: Path, internal: bool) -> None:
    """Only publish masks that travel with their indexed GeoTIFF.

    Args:
        tmp_path: Archive directory.
        internal: Whether GDAL embeds the mask or writes a separate file.
    """
    manifest = annual_manifest(tmp_path)
    frame = tmp_path / "rain_2022.tif"
    with (
        rasterio.Env(GDAL_TIFF_INTERNAL_MASK=internal),
        rasterio.open(frame, "r+") as src,
    ):
        src.write_mask(numpy.array([[255, 0]], dtype="uint8"))
    result = run_cli("build", manifest)
    if internal:
        assert result.returncode == 0, result.stderr
        with rasterio.open(frame) as src:
            assert src.read(1, masked=True).tolist() == [[22, None]]
    else:
        assert result.returncode == 1
        assert "rain_2022.tif.msk" in result.stderr
        assert not (tmp_path / "dataset.yaml").exists()


@pytest.mark.parametrize("nodata", [float("inf"), float("-inf"), float("nan")])
def test_nonfinite_nodata_catalog(tmp_path: Path, nodata: float) -> None:
    """Publish nonfinite NoData as valid JSON while preserving the native cell mask.

    Args:
        tmp_path: Mount containing the archive.
        nodata: Floating-point sentinel written to the GeoTIFF.
    """
    from tests.test_catalog_temporal import create_scanner, scan

    root = tmp_path / "stack"
    root.mkdir()
    manifest = annual_manifest(root)
    for path in root.glob("*.tif"):
        with rasterio.open(path) as src:
            profile = src.profile
        profile.update(dtype="float32", nodata=nodata)
        with rasterio.open(path, "w", **profile) as src:
            src.write(numpy.array([[12, nodata]], dtype="float32"), 1)
    result = run_cli("build", manifest)
    assert result.returncode == 0, result.stderr
    manager, writer = create_scanner(tmp_path)
    assert asyncio.run(scan(manager))["errors"] == []
    (item,) = writer.write_session.items.values()
    json.dumps(item, allow_nan=False)
    with rasterio.open(root / "rain_2024.tif") as src:
        assert src.read(1, masked=True).tolist() == [[12, None]]


def test_retry_interrupted_publication(tmp_path: Path) -> None:
    """Recover after process exit between publishing the index and its descriptor.

    Args:
        tmp_path: Dedicated archive directory.
    """
    manifest = annual_manifest(tmp_path)
    crash = """import os, runpy, sys
from pathlib import Path
link = Path.hardlink_to
def interrupt(path, target):
    if path.name == 'dataset.yaml':
        os._exit(12)
    link(path, target)
Path.hardlink_to = interrupt
runpy.run_path(sys.argv[1])['build_stack'](Path(sys.argv[2]), False)
"""
    assert (
        subprocess.run([sys.executable, "-c", crash, SCRIPT, manifest]).returncode == 12
    )
    index = tmp_path / "catalog.sqlite"
    original = index.read_bytes()
    index.write_bytes(b"unrelated index")
    assert run_cli("build", manifest).returncode == 1
    assert index.read_bytes() == b"unrelated index"
    index.write_bytes(original)
    result = run_cli("build", manifest)
    assert result.returncode == 0, result.stderr
    assert list(tmp_path.rglob("dataset.yaml")) == [tmp_path / "dataset.yaml"]
    assert index.read_bytes() == original
    manifest.write_text("incomplete: true")
    assert "Archive output already exists" in run_cli("build", manifest).stderr
    assert "Field required" in run_cli("build", manifest, "--check").stderr


@pytest.mark.parametrize(
    ("second_start", "valid"), [("2024-02-29", True), ("2024-02-28", False)]
)
def test_explicit_periods_may_touch(
    tmp_path: Path, second_start: str, valid: bool
) -> None:
    """Allow adjacent end-exclusive intervals and reject an overlapping leap-day series.

    Args:
        tmp_path: Archive containing two real frames.
        second_start: Beginning of the second explicit interval.
        valid: Whether the pair should pass validation.
    """
    manifest = annual_manifest(tmp_path)
    stack = yaml.safe_load(manifest.read_text())
    stack["variable"]["period"] = "explicit"
    first, second = stack["observations"]
    first["time"] = {"start": "2024-02-01", "end": "2024-02-29"}
    second["time"] = {"start": second_start, "end": "2024-03-05"}
    manifest.write_text(yaml.safe_dump(stack))
    result = run_cli("build", manifest, "--check")
    assert result.returncode == (0 if valid else 1), result.stderr
    if not valid:
        assert first["file"] in result.stderr and second["file"] in result.stderr


@pytest.mark.parametrize("explicit", [False, True])
def test_browse_covered_months(tmp_path: Path, explicit: bool) -> None:
    """Browse a leap-day boundary and read the exact frame covered by each choice.

    Args:
        tmp_path: Archive mount.
        explicit: Use unequal intervals with second-precision boundaries.
    """
    from eolab_app.raster.source_models import (
        TemporalIntervalSelection,
        TemporalTimeQuery,
    )
    from eolab_app.raster.temporal_source import (
        get_temporal_observations,
        get_temporal_time_choices,
    )
    from tests.test_catalog_temporal import create_scanner, scan

    root = tmp_path / "stack"
    root.mkdir()
    manifest = annual_manifest(root)
    stack = yaml.safe_load(manifest.read_text())
    stack["variable"]["period"] = "explicit" if explicit else "calendar_day"
    first, second = stack["observations"]
    first["time"] = (
        {"start": "2024-01-21T06:12:43Z", "end": "2024-03-01"}
        if explicit
        else "2024-02-29"
    )
    second["time"] = (
        {"start": "2024-03-01", "end": "2024-03-02"} if explicit else "2024-03-01"
    )
    manifest.write_text(yaml.safe_dump(stack))
    result = run_cli("build", manifest)
    assert result.returncode == 0, result.stderr
    manager, writer = create_scanner(tmp_path)
    assert asyncio.run(scan(manager))["errors"] == []
    ((key, item),) = writer.write_session.items.items()
    ref = dict(collectionId=key[0], itemId=key[1], variable="rain")
    dates = get_temporal_time_choices(
        item, TemporalTimeQuery(**ref, month="2024-02"), tmp_path
    )
    assert dates.months == ("2024-02", "2024-03")
    (end,) = dates.times
    assert end == "2024-03-01T00:00:00.000Z"
    start = "2024-02-29T00:00:00Z"
    if explicit:
        start = dates.interval_starts[end]
        assert start == "2024-01-21T06:12:43.000Z"
    (frame,) = get_temporal_observations(
        item, TemporalIntervalSelection(**ref, startTime=start, endTime=end), tmp_path
    )
    assert frame.path.name == first["file"]
