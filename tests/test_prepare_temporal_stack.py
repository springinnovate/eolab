"""Exercise operator preparation with real GeoTIFFs and the temporal Catalog reader."""

import asyncio
from pathlib import Path
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
    assert run_cli("build", manifest, "--check").returncode == 0
    assert not (root / "catalog.sqlite").exists()
    built = run_cli("build", manifest)
    assert built.returncode == 0, built.stderr
    assert run_cli("build", manifest).returncode == 1
    manager, writer = create_scanner(tmp_path)
    assert asyncio.run(scan(manager))["errors"] == []
    ((key, item),) = writer.write_session.items.items()
    assert item["properties"]["eolab:time_labels"] == "calendar_year"
    ref = dict(collectionId=key[0], itemId=key[1], variable="rain")
    dates = get_temporal_time_choices(item, TemporalTimeQuery(**ref), tmp_path)
    assert dates.months == ("2023-01", "2025-01")
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
    result = run_cli("draft", tmp_path, answers=f"{answer}\nsnapshot\n")
    assert result.returncode == 0, result.stderr
    manifest = tmp_path / "stack.yaml"
    text = manifest.read_text()
    assert "2024" in text and "dataset ACQUISITION_DATE: 2023" in text
    assert [row["time"] for row in yaml.safe_load(text)["observations"]] == [
        "2022" if answer == "y" else None,
        None,
        None,
        None,
    ]
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
    stack["observations"].extend(
        [
            {"file": "shifted.tif", "time": "2023"},
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
        "short.tif: Expected one complete calendar year",
        "bad.tif: day is out of range",
        "duplicate time or overlap",
    ):
        assert message in failed.stderr
    assert not (tmp_path / "catalog.sqlite").exists()
    assert not (tmp_path / "dataset.yaml").exists()


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
