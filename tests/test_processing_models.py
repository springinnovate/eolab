"""Verify that shared job contracts retain operation-specific result details."""

from typing import Literal

from eolab_app.processing.models import JobListResponse, JobResponse, JobResultResponse


class SummaryResult(JobResultResponse):
    """Test-only result with record counts instead of raster validity metadata."""

    records: int


class SummaryJob(JobResponse):
    """Test-only operation reusing the complete owned job lifecycle."""

    operation: Literal["test.summary.v1"]
    result: SummaryResult | None


def test_job_listing_preserves_non_raster_result_details() -> None:
    """Reuse lifecycle and download contracts without grids, areas, or pixels."""
    payload = {
        "jobId": "a" * 32,
        "operation": "test.summary.v1",
        "status": "ready",
        "createdAt": "2026-09-07T12:00:00Z",
        "updatedAt": "2026-09-07T12:00:01Z",
        "expiresAt": "2026-09-08T12:00:01Z",
        "progress": {"phase": "summarizing"},
        "error": None,
        "result": {
            "url": "/result",
            "provenanceUrl": "/provenance",
            "filename": "summary.csv",
            "bytes": 128,
            "sha256": "b" * 64,
            "records": 4,
        },
    }
    listing = JobListResponse[SummaryJob].model_validate({"jobs": [payload]})
    serialized = listing.model_dump(mode="json")["jobs"][0]
    assert serialized == payload
    assert serialized["result"]["records"] == 4
