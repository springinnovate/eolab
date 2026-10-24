"""Run temporal area summaries through admission, native execution and CSV download."""

import asyncio
import csv
from io import StringIO
import time
from typing import Any, Literal
from unittest.mock import Mock
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing.model_run_contracts import RunDocument
from eolab_app.processing.model_yaml import parse_yaml
from eolab_app.processing.temporal_series import (
    create_temporal_series,
    temporal_series_process_target,
)
from eolab_app.raster import sources
from test_processing_jobs import HEADERS, store
from tests.test_catalog_temporal import (
    ITEM_KEY,
    PRECIPITATION,
    TEMPERATURE,
    era5_archive,
)
from tests.test_temporal_processing_postgres import (
    BOUNDS,
    TemporalBoundary,
    temporal_boundary,
)


def series_request(client: TestClient, variable: str = TEMPERATURE) -> dict[str, Any]:
    """Select the available February observations through the discovered recipe.

    Args:
        client: Browser-session client owning the requested calculation.
        variable: Admitted variable to summarize without temporal integration.

    Returns:
        Path-free submission requesting one area mean for each available timestamp.
    """
    definition = next(
        model
        for model in client.get("/api/processing/models").json()["models"]
        if model["id"] == "temporal-area-series"
    )
    return {
        "requestId": uuid4().hex,
        "model": {
            key: definition[key] for key in ("id", "version", "definitionSha256")
        },
        "inputs": {
            "source": {
                "collectionId": ITEM_KEY[0],
                "itemId": ITEM_KEY[1],
                "variable": variable,
                "startTime": "2000-02-01T00:00:00Z",
                "endTime": "2000-02-01T03:00:00Z",
            },
            "area": {"kind": "selectedArea", "selectedBounds": BOUNDS},
            "statistic": "mean",
        },
        "parameters": {},
        "label": "February area means",
        "utcOffsetMinutes": 0,
    }


def submit_series(client: TestClient, request: dict[str, Any]) -> dict[str, Any]:
    """Submit a series through the existing same-origin model-run endpoint.

    Args:
        client: Browser-session client owning the requested run.
        request: Recipe identity, variable, period, area and statistic.

    Returns:
        Queued Processing job after successful HTTP admission.
    """
    response = client.post("/api/processing/model-runs", json=request, headers=HEADERS)
    assert response.status_code == 202, response.text
    return response.json()


def test_series_csv_preserves_values_lineage_and_session_ownership(
    temporal_boundary: TemporalBoundary,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Publish native area means with exact coverage and owned downloadable files.

    Args:
        temporal_boundary: Real catalog admission, PostgreSQL, HTTP and native worker.
        monkeypatch: Count observation lookups while retaining the actual source reader.
    """
    client, worker, _, archive, _ = temporal_boundary
    observations = Mock(wraps=sources.get_temporal_observations)
    monkeypatch.setattr(sources, "get_temporal_observations", observations)
    request = series_request(client)
    job = submit_series(client, request)
    assert observations.call_count == 0
    base = f"/api/processing/jobs/{job['jobId']}"
    pending = parse_yaml(client.get(base + "/run-yaml").content, run=True)
    assert pending["execution"]["sources"]["source"] == {
        "kind": "temporalInterval",
        "unit": "K",
        "timeSupport": "instantaneous",
    }
    assert client.portal.call(worker.run_once)
    assert observations.call_count == 1
    ready = client.get(base).json()
    assert ready["status"] == "ready", ready
    result = ready["result"]
    assert (result["kind"], result["presentation"], result["mediaType"]) == (
        "timeSeries",
        "download",
        "text/csv",
    )
    assert result["statistic"] == "mean"
    assert "rows" not in result
    assert result["temporalCoverage"] == {
        "unit": "K",
        "observationCount": 3,
        "firstObservation": "2000-02-01T00:00:00Z",
        "lastObservation": "2000-02-01T02:00:00Z",
    }
    download = client.get(result["url"])
    assert download.status_code == 200
    rows = list(csv.DictReader(StringIO(download.text)))
    assert [float(row["value"]) for row in rows] == [11, 22, 31]
    assert [int(row["valid_pixels"]) for row in rows] == [2, 1, 2]
    assert {row["state"] for row in rows} == {"ok"}
    assert {row["unit"] for row in rows} == {"K"}
    assert {row["variable"] for row in rows} == {TEMPERATURE}
    assert list(rows[0]) == [
        "time_utc",
        "interval_start_utc",
        "interval_end_utc",
        "variable",
        "statistic",
        "value",
        "unit",
        "valid_pixels",
        "state",
    ]
    assert all(
        row["time_utc"] == row["interval_start_utc"] == row["interval_end_utc"]
        for row in rows
    )
    files = ready["artifacts"]["files"]
    csv_file = next(file for file in files if file["mediaType"] == "text/csv")
    assert client.get(csv_file["url"]).content == download.content
    assert {file["mediaType"] for file in files} == {"text/csv", "application/json"}
    exported_response = client.get(base + "/run-yaml")
    exported = parse_yaml(exported_response.content, run=True)
    RunDocument.model_validate(exported)
    assert exported["invocation"] == pending["invocation"]
    assert exported["invocation"]["inputs"] == request["inputs"]
    assert exported["execution"]["state"] == "prepared"
    provenance_response = client.get(result["provenanceUrl"])
    assert provenance_response.status_code == 200
    provenance = provenance_response.json()
    assert provenance["weighting"] == "equal_valid_pixel"
    assert provenance["temporalAggregation"] == "none"
    assert provenance["inputUnit"] == provenance["unit"] == "K"
    assert [observation["time"] for observation in provenance["observations"]] == [
        row["time_utc"] for row in rows
    ]
    assert str(archive) not in exported_response.text + provenance_response.text
    with TestClient(client.app, base_url="https://testserver") as stranger:
        for url in (base, csv_file["url"], result["url"], result["provenanceUrl"]):
            assert stranger.get(url).status_code == 404
    assert client.delete(base, headers=HEADERS).status_code == 200
    client.portal.call(worker.cleanup)
    assert client.get(csv_file["url"]).status_code == 409
    assert not list((worker.artifacts.root / "results").iterdir())
    assert not list((worker.artifacts.root / "attempts").iterdir())


def test_rate_series_keeps_original_units_intervals_and_observation_gaps(
    temporal_boundary: TemporalBoundary,
) -> None:
    """Summarize each rate independently without converting it into a period total.

    Args:
        temporal_boundary: Admitted rate observations with one missing hourly label.
    """
    client, worker, _, _, _ = temporal_boundary
    request = series_request(client, PRECIPITATION)
    request["inputs"]["source"]["startTime"] = "2000-01-31T23:30:00Z"
    job = submit_series(client, request)
    assert client.portal.call(worker.run_once)
    ready = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert ready["status"] == "ready", ready
    rows = list(csv.DictReader(StringIO(client.get(ready["result"]["url"]).text)))
    assert [float(row["value"]) for row in rows] == pytest.approx([5 / 3, 11 / 3])
    assert [row["time_utc"] for row in rows] == [
        "2000-02-01T00:00:00+00:00",
        "2000-02-01T02:00:00+00:00",
    ]
    assert [row["interval_start_utc"] for row in rows] == [
        "2000-01-31T23:00:00+00:00",
        "2000-02-01T01:00:00+00:00",
    ]
    assert all(row["interval_end_utc"] == row["time_utc"] for row in rows)
    assert {row["unit"] for row in rows} == {"kg m**-2 s**-1"}
    assert ready["result"]["temporalCoverage"]["observationCount"] == 2
    provenance = client.get(ready["result"]["provenanceUrl"]).json()
    assert provenance["timeSupport"] == "mean_rate"
    assert provenance["temporalAggregation"] == "none"
    assert provenance["inputUnit"] == provenance["unit"] == "kg m**-2 s**-1"


@pytest.mark.parametrize("statistic,unit", [("mean", "K"), ("count", "cells")])
def test_series_retains_nodata_observations(
    temporal_boundary: TemporalBoundary,
    statistic: str,
    unit: str,
) -> None:
    """Keep timestamps with no valid selected cells, distinguishing them from gaps.

    Args:
        temporal_boundary: Native observations containing an all-NoData column.
        statistic: Spatial statistic requested for each observation.
        unit: Original measurement unit, or cells for a count.
    """
    client, worker, _, _, _ = temporal_boundary
    request = series_request(client)
    request["inputs"]["statistic"] = statistic
    request["inputs"]["area"]["selectedBounds"] = {
        "west": 0.2,
        "south": -0.1,
        "east": 0.3,
        "north": 0.1,
    }
    job = submit_series(client, request)
    assert client.portal.call(worker.run_once)
    ready = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert ready["status"] == "ready", ready
    rows = list(csv.DictReader(StringIO(client.get(ready["result"]["url"]).text)))
    assert len(rows) == 3
    assert {row["value"] for row in rows} == {""}
    assert {row["valid_pixels"] for row in rows} == {"0"}
    assert {row["state"] for row in rows} == {"no_valid_data"}
    assert {row["unit"] for row in rows} == {unit}


def pause_after_series_csv(
    queue: ProcessResultWriter,
    operation: Literal["plan", "series"],
    arguments: tuple[Any, ...],
) -> None:
    """Pause the native child after writing its CSV so cancellation races publication.

    Args:
        queue: Supervisor-owned channel receiving the completed artifact.
        operation: Native grid planning or per-observation calculation.
        arguments: Real authorized observations, area, output directory and limits.
    """
    if operation == "plan":
        temporal_series_process_target(queue, operation, arguments)
        return
    artifact = create_temporal_series(*arguments)
    (arguments[2] / "checkpoint").touch()
    time.sleep(5)
    queue.put(("ok", artifact))


def test_cancelled_series_never_publishes_its_completed_csv(
    temporal_boundary: TemporalBoundary,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Remove private CSV and progress files when cancellation wins publication.

    Args:
        temporal_boundary: Real native calculation, HTTP session and durable job store.
        monkeypatch: Pause the actual child after CSV creation, before publication.
    """
    client, worker, _, _, _ = temporal_boundary
    job = submit_series(client, series_request(client))
    base = f"/api/processing/jobs/{job['jobId']}"
    monkeypatch.setattr(
        "eolab_app.processing.temporal_series_operation.temporal_series_process_target",
        pause_after_series_csv,
    )

    async def cancel_after_csv_write() -> None:
        """Wait for the child checkpoint, cancel through HTTP and verify cleanup."""
        task = asyncio.create_task(worker.run_once())
        try:
            async with asyncio.timeout(15):
                while not list(
                    (worker.artifacts.root / "attempts").glob("*/checkpoint")
                ):
                    await asyncio.sleep(0.05)
            stopped = client.post(base + "/cancel", headers=HEADERS)
            assert stopped.status_code == 202, stopped.text
            assert stopped.json()["status"] == "cancelling"
            await task
            state = client.get(base).json()
            assert state["status"] == "cancelled"
            assert state["result"] is None and state["artifacts"]["files"] == []
            assert client.get(base + "/result").status_code == 409
            await worker.cleanup()
            assert not list((worker.artifacts.root / "results").iterdir())
            assert not list((worker.artifacts.root / "attempts").iterdir())
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(cancel_after_csv_write())
