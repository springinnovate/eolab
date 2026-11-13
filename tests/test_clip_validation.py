"""Clip admission reuses validated inputs while storage retains its wire contract."""

import asyncio
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from typing import Any
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

from eolab_app.processing import clip_models
from eolab_app.processing.clip_models import ClipInputs, ClipJobRequest, UnpreparedClip
from eolab_app.processing.model_operations import get_model_operation
from eolab_app.processing.models import JobInputFile
from eolab_app.processing.ports import JobArtifactStore, JobStore
from eolab_app.processing.service import ProcessingService
from eolab_app.processing.shared_calculations import identify_shared_calculation
from eolab_app.raster.models import CatalogRasterRequest
from eolab_app.routes.processing import create_processing_router
from raster_source_support import SOURCE

BOUNDS = {"west": 0.0, "south": 1.0, "east": 2.0, "north": 3.0}
SOURCES = [
    SOURCE,
    {"source": SOURCE},
    {
        "source": {
            "collectionId": "eolab-temporal-datasets",
            "itemId": "observations",
            "variable": "temperature",
            "time": "2025-01-01T01:00:00+01:00",
        }
    },
    {"source": {"kind": "runArtifact", "jobId": "a" * 32, "artifactId": "b" * 32}},
]
AREAS = [
    {"selectedBounds": BOUNDS},
    {"samplingBox": {"center": {"longitude": 1.0, "latitude": 2.0}, "sideLengthKm": 5}},
    {
        "catalogSelection": {
            "collectionId": "eolab-mounted-vectors",
            "itemId": "polygons",
            "assetKey": "data",
            "layerName": "areas",
            "filter": {"rules": [{"field": "name", "operator": "eq", "value": "A"}]},
        }
    },
]


@pytest.mark.parametrize("source", SOURCES)
@pytest.mark.parametrize("area", AREAS)
def test_clip_submission_preserves_canonical_hashes_and_stored_inputs(
    source: dict[str, Any], area: dict[str, Any]
) -> None:
    """Keep retry identity, sharing and private capture across source and area types.

    Args:
        source: Public catalog, temporal or private raster input.
        area: Public rectangle, sampling box or catalog vector area.
    """
    operation = get_model_operation("raster.clip.v1")
    original = ClipInputs(**source, **area)
    expected_request = original.model_dump(mode="json", by_alias=True)
    expected_spec = {"operation": operation.id, "request": expected_request}
    expected_hash = hashlib.sha256(
        json.dumps(expected_request, sort_keys=True).encode()
    ).hexdigest()
    expected_work = identify_shared_calculation(UnpreparedClip(request=original))
    jobs = MagicMock(spec=JobStore)
    file = JobInputFile("a" * 32, "b" * 32, "c" * 64, 100, "image/tiff", "result")
    jobs.inspect_input_file.return_value = file
    now = datetime.now(timezone.utc)
    jobs.submit.return_value = {
        "id": "d" * 32,
        "operation": operation.id,
        "status": "queued",
        "created_at": now,
        "updated_at": now,
        "expires_at": now,
        "progress": {},
        "error": None,
    }
    service = ProcessingService(jobs, MagicMock(spec=JobArtifactStore))
    for request_id in ("first-clip-request-1122", "second-clip-request-1122"):
        request = ClipJobRequest(**source, **area, requestId=request_id)
        queued = UnpreparedClip(request=request)
        assert queued.request is request
        assert queued.model_dump(mode="json", by_alias=True) == expected_spec
        plan = operation.queue(request, {})
        assert plan.specification == expected_spec
        assert plan.work_key == expected_work
        restored = operation.parse_specification(plan.specification)
        assert restored.model_dump(mode="json", by_alias=True) == expected_spec
        assert identify_shared_calculation(restored) == expected_work
        with patch.object(
            clip_models, "CatalogRasterRequest", wraps=CatalogRasterRequest
        ) as repeated_validation:
            asyncio.run(service.submit_raster_clip("owner", request))
        repeated_validation.assert_not_called()
        owner, retry_id, submitted, request_hash = jobs.submit.call_args.args
        assert (owner, retry_id, request_hash) == ("owner", request_id, expected_hash)
        assert submitted.specification == expected_spec
        if source.get("source", {}).get("kind") == "runArtifact":
            jobs.inspect_input_file.assert_called_with("owner", "a" * 32, "b" * 32)
            assert submitted.input_files == (file,)
            assert submitted.work_key is None
        else:
            jobs.inspect_input_file.assert_not_called()
            assert submitted.input_files == ()
            assert submitted.work_key == expected_work


def test_clip_queue_reuses_validation_and_revalidates_persisted_inputs() -> None:
    """Run clip invariants once at admission and again when the worker restores JSON."""
    operation = get_model_operation("raster.clip.v1")
    with patch.object(
        clip_models, "CatalogRasterRequest", wraps=CatalogRasterRequest
    ) as validate_source:
        request = ClipJobRequest(
            **SOURCE, selectedBounds=BOUNDS, requestId="clip-validation-1122"
        )
        assert validate_source.call_count == 1
        queued = UnpreparedClip(request=request)
        assert queued.request is request
        plan = operation.queue(request, {})
        assert validate_source.call_count == 1
        restored = operation.parse_specification(plan.specification)
        assert validate_source.call_count == 2
        assert restored.model_dump(mode="json", by_alias=True) == plan.specification
        UnpreparedClip.model_validate_json(json.dumps(plan.specification))
        assert validate_source.call_count == 3


@pytest.mark.parametrize(
    "inputs",
    [
        SOURCE,
        {**SOURCE, "selectedBounds": BOUNDS, **AREAS[1]},
        {**SOURCE, "source": SOURCE, "selectedBounds": BOUNDS},
        {"selectedBounds": BOUNDS},
        {**SOURCE, "selectedBounds": {**BOUNDS, "west": 5}},
        {**SOURCE, "selectedBounds": BOUNDS, "sourcePath": "/private/input.tif"},
        {
            **SOURCE,
            "samplingBox": {
                "center": {"longitude": 0, "latitude": 90},
                "sideLengthKm": 5,
            },
        },
        {
            **SOURCES[2],
            "source": {**SOURCES[2]["source"], "time": "2025-01-01"},
            "selectedBounds": BOUNDS,
        },
    ],
)
def test_raw_and_persisted_clip_boundaries_reject_invalid_inputs(
    inputs: dict[str, Any],
) -> None:
    """Reject invalid clip values at HTTP, request construction and worker restoration.

    Args:
        inputs: Invalid raw request without its retry identifier.
    """
    operation = get_model_operation("raster.clip.v1")
    with pytest.raises(ValidationError):
        ClipJobRequest(**inputs, requestId="invalid-clip-request-1122")
    stored = {"operation": operation.id, "request": inputs}
    with pytest.raises(ValidationError):
        operation.parse_specification(deepcopy(stored))
    with pytest.raises(ValidationError):
        UnpreparedClip.model_validate_json(json.dumps(stored))
    service = MagicMock(spec=ProcessingService)
    app = FastAPI()
    app.include_router(create_processing_router(service))
    with TestClient(app, base_url="https://testserver") as client:
        response = client.post(
            "/api/processing/raster-clips",
            json={**inputs, "requestId": "invalid-clip-request-1122"},
            headers={"X-EOLab-Processing": "1"},
        )
    assert response.status_code == 422
    service.submit_raster_clip.assert_not_called()


def test_model_clip_binding_and_uploaded_area_keep_the_queue_contract() -> None:
    """Preserve a recipe-bound private vector descriptor without the retry key."""
    operation = get_model_operation("raster.clip.v1")
    selection = {
        "uploadId": "01234567-89ab-cdef-0123-456789abcdef",
        "layerName": "polygons",
        "filter": {"enabled": True, "match": "all", "rules": []},
    }
    request = operation.bind(
        {
            "raster": SOURCE,
            "area": {"kind": "catalogSelection", "selection": selection},
        },
        {},
        "model-clip-request-1122",
        "Clip",
    )
    plan = operation.queue(request, {})
    assert plan.specification["request"]["catalogSelection"] == selection
    assert "requestId" not in plan.specification["request"]
    assert operation.vector_selections(request) == {"area": request.catalogSelection}
    assert (
        operation.parse_specification(plan.specification).request.catalogSelection
        == request.catalogSelection
    )
