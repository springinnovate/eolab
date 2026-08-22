"""Test the typed single-scan coordination boundary."""

from pathlib import Path

from eolab_app.catalog.scanner import ScanManager
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
