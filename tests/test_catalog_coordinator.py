"""Test the typed single-scan coordination boundary."""

import asyncio
import logging
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import httpx2
import pytest
from fastapi import FastAPI

from eolab_app.catalog.scanner import ScanManager
from eolab_app.routes.scans import create_scan_router
from tests.catalog_support import RecordingCatalogDatabase, RecordingCatalogWriter


def test_initial_scan_status_is_typed_but_preserves_public_shape(
    tmp_path: Path,
) -> None:
    """Expose an isolated established JSON snapshot before the first scan."""
    writer = RecordingCatalogWriter()
    manager = ScanManager(
        tmp_path,
        (tmp_path,),
        writer,
        RecordingCatalogDatabase(writer),
        3,
        2,
        25,
    )

    first = manager.status()
    first["reconciliation"]["state"] = "failed"
    second = manager.status()

    assert second["state"] == "not_started"
    assert second["workerCount"] == 3
    assert second["writerCount"] == 2
    assert second["batchSize"] == 25
    assert second["sourceDatasetsDiscovered"] == 0
    assert second["sourceDatasetsProcessed"] == 0
    assert second["catalogItemsProduced"] == 0
    assert second["catalogItemsWritten"] == 0
    assert second["catalogItemsAlreadyPresent"] == 0
    assert second["reconciliation"]["state"] == "not_started"


@pytest.mark.parametrize(
    ("missing_item", "invalidation_failures"),
    [
        pytest.param(
            True, ("initial invalidation", "cleanup invalidation"), id="cleanup-fails"
        ),
        pytest.param(True, ("initial invalidation",), id="cleanup-recovers"),
        pytest.param(False, ("initial invalidation",), id="failure-without-removal"),
        pytest.param(True, (), id="success-with-removal"),
        pytest.param(False, (), id="success-without-removal"),
    ],
)
def test_scan_finishes_and_can_restart_after_cache_invalidation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    missing_item: bool,
    invalidation_failures: tuple[str, ...],
) -> None:
    """Publish terminal scan status even when cleanup invalidation also fails.

    Args:
        tmp_path: Real source mount containing no current datasets.
        monkeypatch: Fixture replacing only the database invalidation operation.
        caplog: Fixture capturing primary and secondary failure diagnostics.
        missing_item: Whether reconciliation must delete an absent source Item.
        invalidation_failures: Errors raised by successive invalidation attempts.
    """
    writer = RecordingCatalogWriter()
    item_key = ("eolab-mounted-geotiffs", "geotiff-missing")
    if missing_item:
        writer.write_session.items[item_key] = {
            "collection": item_key[0],
            "id": item_key[1],
            "assets": {"data": {"href": (tmp_path / "missing.tif").as_uri()}},
        }
    database = RecordingCatalogDatabase(writer)
    invalidate = AsyncMock(
        side_effect=[RuntimeError(message) for message in invalidation_failures]
        + [None]
    )
    monkeypatch.setattr(database, "invalidate_search_count_cache", invalidate)
    manager = ScanManager(tmp_path, (tmp_path,), writer, database, 1, 1, 25)
    application = FastAPI()
    application.include_router(create_scan_router(manager))
    caplog.set_level(logging.ERROR, logger="eolab_app.catalog.scanner")

    async def run_and_restart() -> tuple[dict[str, Any], dict[str, Any]]:
        """Await actual scan tasks and read their terminal HTTP snapshots.

        Returns:
            First scan and successful restart snapshots from the public route.
        """
        async with httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=application),
            base_url="http://testserver",
        ) as client:
            response = await client.post("/api/scans")
            assert response.status_code == 202
            assert manager._task is not None
            await asyncio.wait_for(manager._task, timeout=5)
            assert manager._task.done()
            assert manager._task.exception() is None
            response = await client.get("/api/scans/current")
            assert response.status_code == 200
            first_status = response.json()
            assert invalidate.await_count == 1 + bool(
                missing_item and invalidation_failures
            )

            invalidate.side_effect = None
            response = await client.post("/api/scans")
            assert response.status_code == 202
            assert manager._task is not None
            await asyncio.wait_for(manager._task, timeout=5)
            response = await client.get("/api/scans/current")
            assert response.status_code == 200
            return first_status, response.json()

    status, restarted_status = asyncio.run(run_and_restart())

    assert status["state"] == ("failed" if invalidation_failures else "completed")
    assert status["finishedAt"] is not None
    assert status["currentFile"] is None
    assert status["reconciliation"]["state"] == "completed"
    assert status["reconciliation"]["removed"] == int(missing_item)
    assert database.deleted_batches == ([[item_key]] if missing_item else [])
    assert item_key not in writer.write_session.items
    expected_errors = []
    if invalidation_failures:
        expected_errors.append(
            {"path": None, "error": "Scan stopped: initial invalidation"}
        )
        assert "RuntimeError: initial invalidation" in caplog.text
    if len(invalidation_failures) > 1:
        expected_errors.append(
            {"path": None, "error": "Scan cleanup failed: cleanup invalidation"}
        )
        assert "Catalog scan cleanup failed" in caplog.text
        assert "RuntimeError: cleanup invalidation" in caplog.text
    assert status["errors"] == expected_errors
    assert restarted_status["id"] != status["id"]
    assert restarted_status["state"] == "completed"
    assert restarted_status["finishedAt"] is not None
    assert restarted_status["errors"] == []
