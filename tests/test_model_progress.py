"""Operation-owned progress through model serialization and its public contract."""

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from pydantic import ValidationError

from eolab_app.processing import model_operations as operations
from eolab_app.processing.model_run_contracts import ModelJobResponse, ModelProgress
from eolab_app.processing.model_runs import serialize_model_job


def model_row(operation: str, progress: dict[str, Any]) -> dict[str, Any]:
    """Build a minimal owned running record without requiring result files.

    Args:
        operation: Captured operation identity.
        progress: Persisted native snapshot to serialize.

    Returns:
        A running model record with valid identity and lifecycle fields.
    """
    now = datetime.now(timezone.utc)
    summary = {
        "label": "Habitat run",
        "model": {
            "id": "habitat-fixture",
            "version": "1.0.0",
            "definitionSha256": "b" * 64,
            "title": "Habitat fixture",
        },
    }
    summary["operationId"] = operation
    return {
        "id": "a" * 32,
        "status": "running",
        "summary": summary,
        "presentation": {"utcOffsetMinutes": 0},
        "progress": progress,
        "created_at": now,
        "updated_at": now,
        "expires_at": now + timedelta(days=7),
        "error": None,
    }


@pytest.mark.parametrize("phase", ["counting_habitat", "measuring_regions"])
def test_registered_operation_supplies_unfamiliar_stage_description(
    monkeypatch: pytest.MonkeyPatch, phase: str
) -> None:
    """A fixture operation can rename a phase without changing inputs or outputs.

    Args:
        monkeypatch: Isolated installed-operation registry.
        phase: A phase unknown to the generic model implementation.
    """
    original = operations.get_model_operation("raster.aggregate.v1")
    operation = replace(
        original,
        id="fixture.habitat.v1",
        progress_descriptions=((phase, "Measuring habitat"),),
    )
    monkeypatch.setattr(
        operations, "OPERATIONS", {**operations.OPERATIONS, operation.id: operation}
    )
    row = model_row(
        operation.id,
        {
            "phase": phase,
            "completed": 1,
            "total": 3,
            "unit": "regions",
            "description": "Untrusted snapshot description",
        },
    )
    response = ModelJobResponse.model_validate(serialize_model_job(row))
    assert response.progress.model_dump() == {
        "phase": phase,
        "description": "Measuring habitat",
        "completed": 1,
        "total": 3,
        "unit": "regions",
    }
    assert operation.inputs == original.inputs and operation.output == original.output


@pytest.mark.parametrize(
    ("operation", "phase", "description"),
    [
        ("raster.aggregate.v1", "calculating", "Calculating"),
        (
            "raster.aggregate.v1",
            "preparing_selected_polygons",
            "Reading selected features",
        ),
        ("raster.aggregate.v1", "preparing_polygon_mask", "Creating the analysis mask"),
        ("raster.clip.v1", "clipping", "Clipping raster"),
        ("raster.clip.v1", "creating_cog", "Preparing GeoTIFF"),
        ("raster.clip.v1", "validating", "Checking GeoTIFF"),
        ("raster.clip.v1", "checksumming", "Finishing download"),
        (
            "hydrology.downstream_beneficiaries.v1",
            "routing_downstream",
            "Tracing downstream flow",
        ),
        (
            "hydrology.downstream_beneficiaries.v1",
            "buffering_downstream_coverage",
            "Buffering downstream coverage",
        ),
    ],
)
def test_installed_operation_descriptions_preserve_stage_meaning(
    operation: str, phase: str, description: str
) -> None:
    """Stage descriptions stay with their operation after removal from Models.

    Args:
        operation: Installed operation identity.
        phase: Native progress stage.
        description: User-facing wording for that stage.
    """
    row = model_row(operation, {"phase": phase})
    response = ModelJobResponse.model_validate(serialize_model_job(row))
    assert response.progress.description == description
    assert response.progress.completed is None and response.progress.total is None


@pytest.mark.parametrize(
    ("operation", "phase"),
    [("raster.aggregate.v1", "unknown_phase"), ("removed.operation.v1", "calculating")],
)
def test_unrecognized_stage_or_uninstalled_operation_preserves_running_history(
    operation: str, phase: str
) -> None:
    """Unavailable stage metadata leaves a truthful generic client fallback possible.

    Args:
        operation: Installed or historical operation identity.
        phase: A native stage whose metadata might be unavailable.
    """
    row = model_row(operation, {"phase": phase, "completedBlocks": 1, "totalBlocks": 3})
    response = ModelJobResponse.model_validate(serialize_model_job(row))
    assert response.status == "running" and response.progress.phase == phase
    assert response.progress.description is None
    assert response.progress.completed == 1 and response.progress.total == 3


@pytest.mark.parametrize(
    "status", ["queued", "cancelling", "failed", "cancelled", "interrupted"]
)
def test_progress_does_not_replace_lifecycle_or_errors(status: str) -> None:
    """Progress metadata leaves lifecycle transitions and retained failures intact.

    Args:
        status: Non-running lifecycle state with an older progress snapshot.
    """
    row = model_row("raster.aggregate.v1", {"phase": "calculating"})
    row["status"] = status
    if status == "failed":
        row["error"] = {"code": "calculation_failed", "detail": "Calculation failed."}
    response = ModelJobResponse.model_validate(serialize_model_job(row))
    assert response.status == status and response.progress.description is None
    assert (response.error is not None) == (status == "failed")


@pytest.mark.parametrize("description", [None, "Checking <b>habitat</b>", "🌳" * 200])
def test_progress_description_accepts_optional_bounded_literal_text(
    description: str | None,
) -> None:
    """Descriptions preserve literal text and count Unicode characters consistently.

    Args:
        description: Absent metadata or a valid literal description.
    """
    assert ModelProgress(description=description).description == description
    assert ModelProgress().description is None


@pytest.mark.parametrize("description", [0, False, [], {}, "", " \t\n", "🌳" * 201])
def test_progress_description_rejects_invalid_metadata(description: Any) -> None:
    """The public model contract rejects malformed or oversized description values.

    Args:
        description: Invalid operation metadata presented to response validation.
    """
    with pytest.raises(ValidationError):
        ModelProgress(description=description)
