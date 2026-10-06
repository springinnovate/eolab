"""Real native execution, result files and public serialization across lifecycle ports."""

import asyncio
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock

import numpy as np

from eolab_app.processing.aggregate_models import (
    AggregateJobResponse,
    AggregatePlanRequest,
    UnpreparedCalculation,
)
from eolab_app.processing.artifacts import LocalJobArtifacts
from eolab_app.processing.clip_models import RasterClipLimits
from eolab_app.processing.service import public_job
from eolab_app.processing.worker import ProcessingWorker
from eolab_app.raster.source_identity import RasterSourceIdentity
from test_raster_clips import SOURCE, write_source


def test_real_plan_worker_and_public_result(tmp_path: Path) -> None:
    """Native execution returns durable results without publishing private paths.

    Args:
        tmp_path: Isolated source and artifact directories.
    """
    path = write_source(tmp_path / "source.tif", np.ones((32, 32), dtype="uint16"))
    authorized = SimpleNamespace(
        source_path=path, source_signature=RasterSourceIdentity.read(path)
    )
    authorizer = SimpleNamespace(authorize=AsyncMock(return_value=authorized))
    store = Mock()
    store.get_cached_calculation_results.return_value = {}
    identifier = "a" * 32
    limits = RasterClipLimits(free_space_floor=0)
    artifacts = LocalJobArtifacts(tmp_path / "artifacts")
    artifacts.initialize()
    request = AggregatePlanRequest(
        sources={"a": SOURCE},
        wholeRaster=True,
        calculations=[{"label": "Mean", "expression": "mean(a)"}],
    )
    claimed = datetime.now(timezone.utc)
    row = {
        "id": identifier,
        "attempt_id": "b" * 32,
        "spec": UnpreparedCalculation(request=request).model_dump(
            mode="json", by_alias=True
        ),
        "reserved_bytes": 0,
        "created_at": claimed - timedelta(seconds=2),
        "updated_at": claimed,
        "expires_at": claimed + timedelta(hours=1),
        "status": "running",
        "operation": "raster.aggregate.v1",
        "progress": {},
        "error": None,
    }
    configure_prepared_job_store(store, row)
    store.claim_next_job.return_value = row
    store.heartbeat.return_value = True
    store.finish.return_value = True
    worker = ProcessingWorker(authorizer, store, artifacts, limits)
    assert asyncio.run(worker.run_once())
    authorizer.authorize.assert_awaited_once_with(request.sources["a"])
    artifact = store.finish.call_args.args[2]
    assert artifacts.result_path(row["attempt_id"], result_name="result.csv").exists()
    # Match the adapter's JSON storage, then the HTTP response model.
    ready = {
        **row,
        "status": "ready",
        "artifact": json.loads(json.dumps(asdict(artifact))),
        "updated_at": datetime.now(timezone.utc),
    }
    response = AggregateJobResponse.model_validate(public_job(ready))
    assert float(response.result.rows[0].value) == 1
    assert str(path) not in response.model_dump_json()
    ready["status"] = "cancelled"
    assert public_job(ready)["result"] is None


def configure_prepared_job_store(store: Mock, row: dict[str, Any]) -> None:
    """Record worker preparation on the claimed fixture job.

    Args:
        store: Isolated lifecycle port; SQL fencing is tested with PostgreSQL.
        row: Mutable job that will receive prepared inputs and disk reservation.
    """

    def save(identifier: str, attempt: str, prepared: Any) -> dict[str, Any]:
        """Return the fields a successful storage reservation publishes.

        Args:
            identifier: Claimed job ID.
            attempt: Current attempt ID.
            prepared: Validated specification, summary and disk reservation.

        Returns:
            Updated job row for execution.
        """
        return {
            **row,
            "spec": prepared.specification,
            "summary": prepared.summary,
            "reserved_bytes": prepared.reserved_bytes,
        }

    store.save_prepared_job.side_effect = save
