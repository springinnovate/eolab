"""Readable run names and download filenames at the shared model boundary."""

from datetime import datetime, timezone
from typing import Any

import pytest
from pydantic import TypeAdapter, ValidationError

from eolab_app.processing.artifact_manifest import FileName
from eolab_app.processing.model_run_contracts import (
    ModelRunNameRequest,
    ModelRunRequest,
)
from eolab_app.processing.model_runs import (
    describe_model_run_name,
    build_model_download_filename,
)
from test_model_definitions import summary_request


def named_run(**presentation: Any) -> dict[str, Any]:
    """Build an owned record whose creation time crosses a date boundary locally.

    Args:
        presentation: Optional edited label and fixed offset in minutes east of UTC.

    Returns:
        Job fields consumed by the common run and artifact naming functions.
    """
    return {
        "id": "0123456789abcdef" * 2,
        "created_at": datetime(2026, 10, 13, 1, 2, 3, tzinfo=timezone.utc),
        "summary": {"label": "Downstream ecosystem beneficiaries"},
        "presentation": presentation or None,
    }


def test_run_name_uses_fixed_local_creation_time_and_historical_utc() -> None:
    """Renaming preserves the original local timestamp; older runs retain a UTC fallback."""
    row = named_run(utcOffsetMinutes=-420)
    first = describe_model_run_name(row)
    assert first == {
        "name": "Downstream ecosystem beneficiaries",
        "nameTimestamp": "2026_10_12_18_02_03",
        "label": "Downstream ecosystem beneficiaries · 2026_10_12_18_02_03",
    }
    row["presentation"]["label"] = "Cuba biomass"
    renamed = describe_model_run_name(row)
    assert renamed["nameTimestamp"] == first["nameTimestamp"]
    assert renamed["label"] == "Cuba biomass · 2026_10_12_18_02_03"
    assert (
        describe_model_run_name(named_run())["nameTimestamp"] == "2026_10_13_01_02_03"
    )


@pytest.mark.parametrize("label", ["Café / biomass: 2021", "森林", "a" * 80, "CON"])
def test_filenames_are_portable_and_preserve_collection_member_identity(
    label: str,
) -> None:
    """Long or non-ASCII names cannot hide distinct output members or the fixed timestamp.

    Args:
        label: User-supplied run name, including punctuation and portable-device cases.
    """
    row = named_run(label=label, utcOffsetMinutes=-420)
    prefix = "routing_dem_" + "x" * 43
    names = [
        build_model_download_filename(
            row, f"{prefix}_drain_{index}", "original.tif", "image/tiff"
        )
        for index in (1, 2)
    ]
    assert len(set(names)) == 2
    for index, filename in enumerate(names, start=1):
        assert TypeAdapter(FileName).validate_python(filename) == filename
        assert len(filename) <= 160
        assert filename.startswith(f"{prefix}_drain_{index}_")
        assert filename.endswith("_2026_10_12_18_02_03.tif")
        assert row["id"] not in filename
    if label == "Café / biomass: 2021":
        assert "cafe-biomass-2021" in names[0]
    if label == "森林":
        assert "model-run" in names[0]


@pytest.mark.parametrize("media_type", ["image/tiff", "application/x-custom-format"])
def test_long_stored_extension_cannot_overflow_download_filename(
    media_type: str,
) -> None:
    """A valid long private basename still produces a portable distinct download name.

    Args:
        media_type: Recognized format or one whose standard extension is unknown.
    """
    original = "file." + "x" * 150
    assert TypeAdapter(FileName).validate_python(original) == original
    output_name = "routing_dem_" + "x" * 45 + "_drain1"
    row = named_run(label="Cuba biomass", utcOffsetMinutes=-420)
    filename = build_model_download_filename(row, output_name, original, media_type)
    assert TypeAdapter(FileName).validate_python(filename) == filename
    assert filename.startswith(f"{output_name}_cuba-biomass_")
    assert "2026_10_12_18_02_03" in filename
    assert filename.endswith(
        (".tif", ".tiff") if media_type == "image/tiff" else ".bin"
    )


@pytest.mark.parametrize("offset", [-841, 841, True, 1.5, "60"])
def test_model_submission_rejects_invalid_timezone_offsets(offset: Any) -> None:
    """The HTTP submission schema rejects offsets that cannot describe a local timezone.

    Args:
        offset: Invalid offset value supplied at the request boundary.
    """
    with pytest.raises(ValidationError):
        ModelRunRequest.model_validate(
            {**summary_request(), "utcOffsetMinutes": offset}
        )


@pytest.mark.parametrize("label", ["", "   ", "a" * 81, None, 12])
def test_run_name_boundary_rejects_blank_long_or_nontext_names(label: Any) -> None:
    """Submission and rename requests accept the same readable nonempty name contract.

    Args:
        label: Invalid name to reject before changing a run.
    """
    with pytest.raises(ValidationError):
        ModelRunNameRequest.model_validate({"label": label})
    with pytest.raises(ValidationError):
        ModelRunRequest.model_validate({**summary_request(), "label": label})
