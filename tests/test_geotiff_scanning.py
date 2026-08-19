"""Test GeoTIFF metadata extraction and scan orchestration."""

import asyncio
import json
import os
from contextlib import AbstractAsyncContextManager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx2
import numpy
import pytest
import rasterio
from rasterio.transform import from_origin

from eolab_app.geotiff import (
    ACQUISITION_DATETIME_DESCRIPTION,
    FALLBACK_DATETIME_DESCRIPTION,
    build_stac_item,
)
from eolab_app.scanning import ScanManager, StacApiWriter


def write_geotiff(
    path: Path,
    acquisition_datetime: str | None = None,
) -> None:
    """Write a small spatially valid GeoTIFF fixture."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=3,
        height=2,
        count=1,
        dtype="uint8",
        crs="EPSG:4326",
        transform=from_origin(-123, 49, 0.1, 0.1),
        nodata=0,
    ) as dataset:
        dataset.write(numpy.ones((1, 2, 3), dtype="uint8"))
        if acquisition_datetime is not None:
            dataset.update_tags(
                ns="IMAGERY",
                ACQUISITIONDATETIME=acquisition_datetime,
            )


def test_geotiff_uses_embedded_acquisition_datetime(tmp_path: Path) -> None:
    """Prefer an unambiguous GDAL acquisition timestamp over file metadata."""
    geotiff_path = tmp_path / "nested" / "observation.tif"
    write_geotiff(geotiff_path, "2024-06-15T13:20:04-07:00")

    item = build_stac_item(tmp_path, geotiff_path)

    assert item["properties"]["datetime"] == "2024-06-15T20:20:04Z"
    assert item["properties"]["description"] == ACQUISITION_DATETIME_DESCRIPTION
    assert item["properties"]["proj:epsg"] == 4326
    assert item["properties"]["proj:shape"] == [2, 3]
    assert item["bbox"] == pytest.approx([-123, 48.8, -122.7, 49])
    assert item["assets"]["data"]["raster:bands"] == [
        {"data_type": "uint8", "nodata": 0.0}
    ]
    json.dumps(item)


def test_geotiff_discloses_filesystem_timestamp_fallback(tmp_path: Path) -> None:
    """Use and disclose file modification time when observation time is absent."""
    geotiff_path = tmp_path / "model-output.tiff"
    write_geotiff(geotiff_path)
    modified_at = datetime(2025, 2, 11, 17, 31, 52, tzinfo=timezone.utc)
    os.utime(geotiff_path, (modified_at.timestamp(), modified_at.timestamp()))

    item = build_stac_item(tmp_path, geotiff_path)

    assert item["properties"]["datetime"] == "2025-02-11T17:31:52Z"
    assert item["properties"]["description"] == FALLBACK_DATETIME_DESCRIPTION
    assert item["assets"]["data"]["updated"] == "2025-02-11T17:31:52Z"


def test_geotiff_rejects_ambiguous_acquisition_datetime(tmp_path: Path) -> None:
    """Reject an acquisition value with no UTC offset instead of guessing."""
    geotiff_path = tmp_path / "ambiguous.tif"
    write_geotiff(geotiff_path, "2024-06-15T13:20:04")

    with pytest.raises(ValueError, match="valid RFC 3339 timestamp"):
        build_stac_item(tmp_path, geotiff_path)


def test_item_identifier_is_stable_for_relative_path(tmp_path: Path) -> None:
    """Generate the same identifier whenever the mounted path is rescanned."""
    first_root = tmp_path / "first"
    second_root = tmp_path / "second"
    first_path = first_root / "models" / "result.tif"
    second_path = second_root / "models" / "result.tif"
    write_geotiff(first_path)
    write_geotiff(second_path)

    first_item = build_stac_item(first_root, first_path)
    second_item = build_stac_item(second_root, second_path)

    assert first_item["id"] == second_item["id"]


def test_geotiff_title_preserves_relative_filename(tmp_path: Path) -> None:
    """Preserve the literal relative path used by Catalog substring search."""
    geotiff_path = tmp_path / "Model Outputs" / "grassland_2002.tif"
    write_geotiff(geotiff_path)

    item = build_stac_item(tmp_path, geotiff_path)

    assert item["properties"]["title"] == "Model Outputs/grassland_2002.tif"
    assert "keywords" not in item["properties"]


class RecordingCatalogSession:
    """Record catalog writes while providing an async context manager."""

    def __init__(self, item_error: Exception | None = None) -> None:
        self.collections: dict[str, dict[str, Any]] = {}
        self.items: dict[str, dict[str, Any]] = {}
        self.item_batches: list[list[dict[str, Any]]] = []
        self.item_error = item_error

    async def __aenter__(self) -> "RecordingCatalogSession":
        return self

    async def __aexit__(self, *exception_details: object) -> None:
        return None

    async def upsert_collection(self, collection: dict[str, Any]) -> None:
        self.collections[collection["id"]] = collection

    async def upsert_items(self, items: list[dict[str, Any]]) -> None:
        self.item_batches.append(items)
        if self.item_error is not None:
            raise self.item_error
        self.items.update((item["id"], item) for item in items)


class RecordingCatalogWriter:
    """Return the same in-memory write session for every scan."""

    def __init__(self, item_error: Exception | None = None) -> None:
        self.write_session = RecordingCatalogSession(item_error)

    def session(self) -> AbstractAsyncContextManager[RecordingCatalogSession]:
        return self.write_session


class RecordingCatalogItemCounter:
    """Return a representative catalog Item count without PostgreSQL."""

    async def count_items(self) -> int:
        return 37


def test_scan_continues_after_an_invalid_geotiff(tmp_path: Path) -> None:
    """Index valid files, report invalid files, and keep stable upsert results."""
    write_geotiff(tmp_path / "valid.TIF")
    (tmp_path / "invalid.tiff").write_text("not a raster", encoding="utf-8")
    catalog_writer = RecordingCatalogWriter()
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogItemCounter(),
        8,
    )

    async def run_twice() -> tuple[dict[str, Any], dict[str, Any]]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        first_status = scan_manager.status()
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return first_status, scan_manager.status()

    first_status, second_status = asyncio.run(run_twice())

    assert first_status["state"] == "completed"
    assert first_status["discovered"] == 2
    assert first_status["processed"] == 2
    assert first_status["indexed"] == 1
    assert first_status["failed"] == 1
    assert first_status["catalogItemsBeforeScan"] == 37
    assert first_status["errors"][0]["path"] == "invalid.tiff"
    assert second_status["indexed"] == 1
    assert len(catalog_writer.write_session.collections) == 1
    assert len(catalog_writer.write_session.items) == 1


def test_scan_combines_multiple_directories_under_one_mount(tmp_path: Path) -> None:
    """Scan configured directories while retaining mount-relative Item paths."""
    observations_path = tmp_path / "observations"
    model_outputs_path = tmp_path / "model_outputs"
    write_geotiff(observations_path / "result.tif")
    write_geotiff(model_outputs_path / "result.tif")
    catalog_writer = RecordingCatalogWriter()
    scan_manager = ScanManager(
        tmp_path,
        (observations_path, model_outputs_path),
        catalog_writer,
        RecordingCatalogItemCounter(),
        8,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["state"] == "completed"
    assert status["indexed"] == 2
    assert {
        item["properties"]["title"]
        for item in catalog_writer.write_session.items.values()
    } == {"observations/result.tif", "model_outputs/result.tif"}


def test_scan_reads_metadata_concurrently_and_bulk_upserts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Honor configured concurrency and write 205 Items as 100, 100, and 5."""
    for item_index in range(205):
        (tmp_path / f"item-{item_index:03}.tif").touch()

    active_metadata_calls = 0
    maximum_metadata_calls = 0

    def build_item(source_root: Path, geotiff_path: Path) -> dict[str, Any]:
        relative_path = geotiff_path.relative_to(source_root).as_posix()
        return {
            "id": relative_path,
            "collection": "eolab-mounted-geotiffs",
        }

    async def yielding_to_thread(function: Any, *args: Any) -> Any:
        nonlocal active_metadata_calls, maximum_metadata_calls
        if function is not build_item:
            return function(*args)

        active_metadata_calls += 1
        maximum_metadata_calls = max(maximum_metadata_calls, active_metadata_calls)
        await asyncio.sleep(0)
        try:
            return function(*args)
        finally:
            active_metadata_calls -= 1

    monkeypatch.setattr("eolab_app.scanning.build_stac_item", build_item)
    monkeypatch.setattr("eolab_app.scanning.asyncio.to_thread", yielding_to_thread)
    catalog_writer = RecordingCatalogWriter()
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogItemCounter(),
        3,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert maximum_metadata_calls == 3
    assert [
        len(item_batch)
        for item_batch in catalog_writer.write_session.item_batches
    ] == [100, 100, 5]
    assert status["processed"] == 205
    assert status["indexed"] == 205
    assert status["failed"] == 0


def test_scan_caps_error_details_without_losing_failure_count(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep status polling bounded when many files cannot be read."""
    for item_index in range(105):
        (tmp_path / f"invalid-{item_index:03}.tif").touch()

    def reject_item(source_root: Path, geotiff_path: Path) -> dict[str, Any]:
        raise ValueError("invalid raster")

    monkeypatch.setattr("eolab_app.scanning.build_stac_item", reject_item)
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        RecordingCatalogWriter(),
        RecordingCatalogItemCounter(),
        8,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["state"] == "completed"
    assert status["processed"] == 105
    assert status["failed"] == 105
    assert len(status["errors"]) == 100
    assert status["errorsTruncated"] is True


def test_scan_stops_after_a_bulk_catalog_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stop and cancel queued work after a systemic catalog failure."""
    for item_index in range(500):
        (tmp_path / f"item-{item_index:03}.tif").touch()

    def build_item(source_root: Path, geotiff_path: Path) -> dict[str, Any]:
        relative_path = geotiff_path.relative_to(source_root).as_posix()
        return {
            "id": relative_path,
            "collection": "eolab-mounted-geotiffs",
        }

    monkeypatch.setattr("eolab_app.scanning.build_stac_item", build_item)
    catalog_writer = RecordingCatalogWriter(
        RuntimeError("catalog unavailable")
    )
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogItemCounter(),
        8,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["state"] == "failed"
    assert status["processed"] == 100
    assert status["indexed"] == 0
    assert status["failed"] == 0
    assert len(catalog_writer.write_session.item_batches) == 1
    assert status["errors"][-1] == {
        "path": None,
        "error": "Scan stopped: catalog unavailable",
    }


def test_scan_prevents_overlap(tmp_path: Path) -> None:
    """Reject a second start while directory discovery is still running."""
    catalog_writer = RecordingCatalogWriter()
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogItemCounter(),
        8,
    )

    async def start_twice() -> None:
        await scan_manager.start()
        with pytest.raises(RuntimeError, match="already running"):
            await scan_manager.start()

    asyncio.run(start_twice())


def test_catalog_writer_uses_standard_bulk_upserts() -> None:
    """Upsert a batch without per-Item existence requests."""
    requests: list[tuple[str, str, object | None]] = []

    def catalog_response(request: httpx2.Request) -> httpx2.Response:
        request_body = json.loads(request.content) if request.content else None
        requests.append((request.method, request.url.path, request_body))
        if request.method == "GET" and request.url.path.endswith(
            "/eolab-mounted-geotiffs"
        ):
            return httpx2.Response(404)
        return httpx2.Response(200, json="written")

    writer = StacApiWriter(
        "http://stac-api:8080",
        httpx2.MockTransport(catalog_response),
    )

    async def write_records() -> None:
        async with writer.session() as session:
            await session.upsert_collection(
                {"id": "eolab-mounted-geotiffs"}
            )
            await session.upsert_items(
                [{
                    "id": "geotiff-123",
                    "collection": "eolab-mounted-geotiffs",
                }]
            )

    asyncio.run(write_records())

    assert requests == [
        (
            "GET",
            "/collections/eolab-mounted-geotiffs",
            None,
        ),
        (
            "POST",
            "/collections",
            {"id": "eolab-mounted-geotiffs"},
        ),
        (
            "POST",
            "/collections/eolab-mounted-geotiffs/bulk_items",
            {
                "method": "upsert",
                "items": {
                    "geotiff-123": {
                        "id": "geotiff-123",
                        "collection": "eolab-mounted-geotiffs",
                    }
                },
            },
        ),
    ]
