"""Test S3-compatible remote object-storage catalog scanning."""

import asyncio
from collections.abc import AsyncIterator, Sequence
from datetime import datetime, timezone
from pathlib import Path
from threading import Event

import fiona
import numpy
import pytest
import rasterio
from rasterio.transform import from_origin

from eolab_app.catalog.models import CatalogItemSource, DatasetMetadataResult
from eolab_app.catalog.reconciliation import (
    MissingItemReconciler,
    catalog_item_is_missing,
)
from eolab_app.catalog.remote import (
    RemoteDatasetCandidate,
    RemoteDatasetHandlerRegistry,
    RemoteDiscoveryPage,
    RemoteScanRoot,
)
from eolab_app.catalog.scanner import ScanManager
from eolab_app.catalog.s3 import (
    S3AssetAvailability,
    S3ConnectionSettings,
    S3DatasetDiscovery,
    S3DatasetMetadataPipeline,
    _verify_candidate_unchanged,
    build_s3_dataset_metadata,
)
from tests.s3_support import S3FixtureService
from tests.catalog_support import RecordingCatalogDatabase, RecordingCatalogWriter


FIXTURE_SECRET = "fixture-secret-value"


class BlockingRemoteDiscovery:
    """Hold a remote listing open until its owning scan is cancelled."""

    def __init__(self) -> None:
        """Create events that expose entry and prevent natural completion."""
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def pages(self) -> AsyncIterator[RemoteDiscoveryPage]:
        """Wait indefinitely after proving discovery started.

        Yields:
            No pages unless a test unexpectedly releases the blocker.
        """
        self.started.set()
        await self.release.wait()
        if False:
            yield RemoteDiscoveryPage(candidates=())


class UnusedRemoteMetadataPipeline:
    """Reject metadata work in cancellation-before-discovery tests."""

    async def results(
        self,
        dataset_candidates: Sequence[RemoteDatasetCandidate],
    ) -> AsyncIterator[DatasetMetadataResult]:
        """Fail if a candidate reaches this intentionally unused reader.

        Args:
            dataset_candidates: Unexpected remote candidates.

        Yields:
            No metadata results.

        Raises:
            AssertionError: If the scanner invokes the reader.
        """
        if dataset_candidates:
            raise AssertionError("Remote metadata should not start")
        if False:
            yield DatasetMetadataResult(
                path=None,
                items=(),
                error=None,
                elapsed_seconds=0,
                processing_seconds=0,
                source_name="unused",
            )


def fixture_connection(
    fixture: S3FixtureService,
    *,
    access_key_id: str | None = None,
    page_size: int = 2,
) -> S3ConnectionSettings:
    """Build server-side settings for the local S3 fixture.

    Args:
        fixture: Running local service.
        access_key_id: Optional credential override used by failure tests.
        page_size: Maximum objects requested per listing call.

    Returns:
        S3 connection settings with path-style HTTP access.
    """
    return S3ConnectionSettings(
        endpoint_url=fixture.endpoint_url,
        region="us-east-1",
        access_key_id=access_key_id or fixture.access_key_id,
        secret_access_key=FIXTURE_SECRET,
        list_page_size=page_size,
        metadata_concurrency=2,
    )


def fixture_root(fixture: S3FixtureService) -> RemoteScanRoot:
    """Build the stable provider-neutral fixture root.

    Args:
        fixture: Local service whose bucket is scanned.

    Returns:
        Remote root for the `datasets/` prefix.
    """
    return RemoteScanRoot(
        source_id="fixture-primary",
        bucket=fixture.bucket,
        prefix="datasets/",
        display_name="Research object store",
    )


def write_remote_geotiff_fixture(path: Path) -> bytes:
    """Create a large uncompressed GeoTIFF suitable for range-read assertions.

    Args:
        path: Temporary local path used only to create fixture bytes.

    Returns:
        Complete GeoTIFF bytes to upload to the local S3 service.
    """
    width = 2048
    height = 2048
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=width,
        height=height,
        count=1,
        dtype="uint8",
        crs="EPSG:4326",
        transform=from_origin(-123, 49, 0.001, 0.001),
        tiled=True,
        blockxsize=256,
        blockysize=256,
    ) as dataset:
        dataset.write(numpy.zeros((1, height, width), dtype="uint8"))
    return path.read_bytes()


def write_remote_shapefile_fixture(path: Path) -> tuple[Path, ...]:
    """Create one complete point Shapefile for remote fixture upload.

    Args:
        path: Temporary local `.shp` path.

    Returns:
        Deterministically ordered component paths created by Fiona.
    """
    with fiona.open(
        path,
        mode="w",
        driver="ESRI Shapefile",
        schema={"geometry": "Point", "properties": {"name": "str:40"}},
        crs="EPSG:4326",
    ) as dataset:
        dataset.write({
            "geometry": {"type": "Point", "coordinates": (-122.5, 48.5)},
            "properties": {"name": "remote"},
        })
    return tuple(sorted(path.parent.glob(f"{path.stem}.*")))


async def discover_all(
    discovery: S3DatasetDiscovery,
) -> list[RemoteDatasetCandidate]:
    """Collect bounded discovery pages for concise focused assertions.

    Args:
        discovery: Configured S3 discovery adapter.

    Returns:
        Candidates emitted across all pages.
    """
    return [
        candidate
        async for page in discovery.pages()
        for candidate in page.candidates
    ]


def test_s3_discovery_pages_and_groups_shapefile_sidecars(
    tmp_path: Path,
) -> None:
    """Keep provider listings bounded while grouping across page boundaries.

    Args:
        tmp_path: Temporary directory used to create valid fixture formats.
    """
    geotiff_bytes = write_remote_geotiff_fixture(tmp_path / "remote.tif")
    shapefile_paths = write_remote_shapefile_fixture(tmp_path / "roads.shp")
    with S3FixtureService() as fixture:
        fixture.add_object("datasets/imagery/remote.tif", geotiff_bytes)
        for component_path in shapefile_paths:
            fixture.add_object(
                f"datasets/vectors/{component_path.name}",
                component_path.read_bytes(),
            )
        fixture.add_object("datasets/vectors/incomplete.shp", b"invalid")
        fixture.add_object("outside/ignored.tif", geotiff_bytes)

        candidates = asyncio.run(discover_all(S3DatasetDiscovery(
            (fixture_root(fixture),),
            fixture_connection(fixture, page_size=2),
        )))

    assert [candidate.handler_name for candidate in candidates] == [
        "remote-geotiff",
        "remote-shapefile",
        "remote-shapefile",
    ]
    roads = candidates[-1]
    assert [component.key for component in roads.components] == sorted(
        f"datasets/vectors/{path.name}" for path in shapefile_paths
    )
    list_requests = [
        request
        for request in fixture.requests
        if request.query.get("list-type") == ["2"]
    ]
    assert len(list_requests) >= 3
    assert all(request.query["max-keys"] == ["2"] for request in list_requests)
    assert all(request.query["prefix"] == ["datasets/"] for request in list_requests)


def test_remote_geotiff_uses_ranges_and_emits_unsigned_identity(
    tmp_path: Path,
) -> None:
    """Read raster metadata by byte range without exposing transport secrets.

    Args:
        tmp_path: Temporary directory used to create the raster bytes.
    """
    geotiff_bytes = write_remote_geotiff_fixture(tmp_path / "remote.tif")
    modified = datetime(2025, 7, 8, 9, 10, 11, tzinfo=timezone.utc)
    with S3FixtureService() as fixture:
        fixture.add_object(
            "datasets/imagery/remote.tif",
            geotiff_bytes,
            last_modified=modified,
        )
        connection = fixture_connection(fixture)
        candidate = asyncio.run(discover_all(S3DatasetDiscovery(
            (fixture_root(fixture),),
            connection,
        )))[0]
        result = build_s3_dataset_metadata(candidate, connection)

        get_requests = [
            request
            for request in fixture.requests
            if request.method == "GET" and request.byte_range is not None
        ]
        endpoint_url = fixture.endpoint_url

    assert result.error is None
    item = result.items[0]
    assert item["properties"]["datetime"] == "2025-07-08T09:10:11Z"
    assert item["properties"]["eolab:source_kind"] == "remote-object-storage"
    assert item["assets"]["data"]["href"] == (
        "s3://catalog-fixture/datasets/imagery/remote.tif"
    )
    assert item["assets"]["data"]["file:size"] == len(geotiff_bytes)
    assert "eolab:rendering" not in item["assets"]["data"]
    assert endpoint_url not in repr(item)
    assert FIXTURE_SECRET not in repr(item)
    assert get_requests
    assert all(request.byte_range.startswith("bytes=") for request in get_requests)
    assert not any(
        request.method == "GET"
        and request.path.endswith("remote.tif")
        and request.byte_range is None
        for request in fixture.requests
    )


def test_remote_shapefile_preserves_component_assets(
    tmp_path: Path,
) -> None:
    """Read remote vector metadata and retain separate exact sidecar Assets.

    Args:
        tmp_path: Temporary directory used to create Shapefile components.
    """
    component_paths = write_remote_shapefile_fixture(tmp_path / "habitat.shp")
    with S3FixtureService() as fixture:
        for component_path in component_paths:
            fixture.add_object(
                f"datasets/vectors/{component_path.name}",
                component_path.read_bytes(),
            )
        connection = fixture_connection(fixture, page_size=1)
        candidate = asyncio.run(discover_all(S3DatasetDiscovery(
            (fixture_root(fixture),),
            connection,
        )))[0]
        result = build_s3_dataset_metadata(candidate, connection)

    assert result.error is None
    item = result.items[0]
    assert item["properties"]["table:row_count"] == 1
    assert item["properties"]["eolab:source_kind"] == "remote-object-storage"
    assert {"shp", "shx", "dbf", "prj"} <= item["assets"].keys()
    assert all(
        asset["href"].startswith("s3://catalog-fixture/datasets/vectors/")
        for asset in item["assets"].values()
    )
    assert all(
        request.byte_range is not None
        for request in fixture.requests
        if request.method == "GET" and request.path.endswith(tuple(
            component_path.suffix for component_path in component_paths
        )) and not request.query
    )


def test_missing_remote_shapefile_components_are_isolated() -> None:
    """Report one dataset error without trying to download an invalid primary."""
    with S3FixtureService() as fixture:
        fixture.add_object("datasets/incomplete.shp", b"invalid")
        connection = fixture_connection(fixture)
        candidate = asyncio.run(discover_all(S3DatasetDiscovery(
            (fixture_root(fixture),),
            connection,
        )))[0]
        result = build_s3_dataset_metadata(candidate, connection)

    assert result.items == ()
    assert result.error == (
        "Shapefile is missing required components: .dbf, .prj, .shx"
    )
    assert not any(
        request.method == "GET" and request.path.endswith("incomplete.shp")
        for request in fixture.requests
    )


def test_s3_credential_failures_are_redacted() -> None:
    """Keep secrets and internal endpoint details out of listing failures."""
    with S3FixtureService() as fixture:
        fixture.add_object("datasets/remote.tif", b"invalid")
        connection = fixture_connection(
            fixture,
            access_key_id="wrong-access-key",
        )

        with pytest.raises(RuntimeError) as captured_error:
            asyncio.run(discover_all(S3DatasetDiscovery(
                (fixture_root(fixture),),
                connection,
            )))
        endpoint_url = fixture.endpoint_url

    error_text = str(captured_error.value)
    assert error_text == "S3 request failed (AccessDenied)"
    assert endpoint_url not in error_text
    assert FIXTURE_SECRET not in error_text
    assert "wrong-access-key" not in error_text


def test_remote_identity_is_idempotent_and_detects_mid_scan_changes(
    tmp_path: Path,
) -> None:
    """Keep unchanged IDs stable and reject a listing snapshot that changed.

    Args:
        tmp_path: Temporary directory used to create two raster revisions.
    """
    first_bytes = write_remote_geotiff_fixture(tmp_path / "first.tif")
    second_bytes = first_bytes + b"changed"
    with S3FixtureService() as fixture:
        fixture.add_object("datasets/remote.tif", first_bytes)
        connection = fixture_connection(fixture)
        candidate = asyncio.run(discover_all(S3DatasetDiscovery(
            (fixture_root(fixture),),
            connection,
        )))[0]
        first_item = build_s3_dataset_metadata(candidate, connection).items[0]
        second_item = build_s3_dataset_metadata(candidate, connection).items[0]
        fixture.add_object("datasets/remote.tif", second_bytes)

        with pytest.raises(
            RuntimeError,
            match="changed or disappeared during scan",
        ):
            _verify_candidate_unchanged(candidate, connection)

    assert first_item["id"] == second_item["id"]
    assert first_item["assets"]["data"]["eolab:object_etag"] == (
        second_item["assets"]["data"]["eolab:object_etag"]
    )


def test_remote_reconciliation_handles_deleted_and_moved_objects() -> None:
    """Prove stale old locations missing while accepting the moved object."""
    with S3FixtureService() as fixture:
        fixture.add_object("datasets/old/remote.tif", b"old")
        availability = S3AssetAvailability(
            (fixture_root(fixture),),
            fixture_connection(fixture),
        )
        old_item = CatalogItemSource(
            "eolab-mounted-geotiffs",
            "geotiff-old",
            ("s3://catalog-fixture/datasets/old/remote.tif",),
        )
        fixture.remove_object("datasets/old/remote.tif")
        fixture.add_object("datasets/new/remote.tif", b"new")
        moved_item = CatalogItemSource(
            "eolab-mounted-geotiffs",
            "geotiff-new",
            ("s3://catalog-fixture/datasets/new/remote.tif",),
        )

        old_missing = catalog_item_is_missing(
            old_item,
            Path.cwd(),
            availability,
        )
        moved_missing = catalog_item_is_missing(
            moved_item,
            Path.cwd(),
            availability,
        )

    assert old_missing is True
    assert moved_missing is False


def test_cancelling_remote_discovery_releases_the_scan(
    tmp_path: Path,
) -> None:
    """Cancel a large-prefix listing and return a terminal status promptly.

    Args:
        tmp_path: Empty mounted source used by the combined scan manager.
    """
    discovery = BlockingRemoteDiscovery()
    writer = RecordingCatalogWriter()
    manager = ScanManager(
        tmp_path,
        (tmp_path,),
        writer,
        RecordingCatalogDatabase(writer),
        1,
        1,
        10,
        remote_discovery=discovery,
        remote_metadata_pipeline=UnusedRemoteMetadataPipeline(),
    )

    async def start_and_cancel() -> dict[str, object]:
        """Start the scan, observe remote discovery, and cancel it.

        Returns:
            Terminal scanner status.
        """
        await manager.start()
        await asyncio.wait_for(discovery.started.wait(), timeout=2)
        return await asyncio.wait_for(manager.cancel(), timeout=2)

    status = asyncio.run(start_and_cancel())

    assert status["state"] == "cancelled"
    assert status["currentFile"] is None


def test_remote_results_feed_scan_progress_bulk_upsert_and_rescan(
    tmp_path: Path,
) -> None:
    """Use the shared coordinator and classify an unchanged rescan in place.

    Args:
        tmp_path: Empty mounted root and raster fixture workspace.
    """
    geotiff_bytes = write_remote_geotiff_fixture(tmp_path / "source.tif")
    with S3FixtureService() as fixture:
        fixture.add_object("datasets/source.tif", geotiff_bytes)
        root = fixture_root(fixture)
        connection = fixture_connection(fixture, page_size=1)
        writer = RecordingCatalogWriter()
        database = RecordingCatalogDatabase(writer)
        manager = ScanManager(
            tmp_path,
            (tmp_path / "empty",),
            writer,
            database,
            1,
            1,
            10,
            remote_discovery=S3DatasetDiscovery((root,), connection),
            remote_metadata_pipeline=S3DatasetMetadataPipeline(connection),
            reconciler=MissingItemReconciler(
                tmp_path,
                database,
                10,
                remote_asset_availability=S3AssetAvailability(
                    (root,),
                    connection,
                ),
            ),
        )
        (tmp_path / "empty").mkdir()

        async def run_scan() -> dict[str, object]:
            """Start one scan and wait for its terminal status.

            Returns:
                Completed scan status.
            """
            await manager.start()
            while manager.status()["state"] in {"discovering", "scanning"}:
                await asyncio.sleep(0.01)
            return manager.status()

        first_status = asyncio.run(run_scan())
        first_keys = set(writer.write_session.items)
        second_status = asyncio.run(run_scan())

    assert first_status["state"] == "completed"
    assert first_status["sourceDatasetsDiscovered"] == 1
    assert first_status["sourceDatasetsProcessed"] == 1
    assert first_status["catalogItemsWritten"] == 1
    assert second_status["catalogItemsAlreadyPresent"] == 1
    assert set(writer.write_session.items) == first_keys


def test_remote_metadata_cancellation_waits_for_worker_cleanup(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Cancel metadata consumption without abandoning an in-flight GDAL read.

    Args:
        tmp_path: Temporary directory used to create raster fixture bytes.
        monkeypatch: Runtime replacement fixture for the worker boundary.
    """
    geotiff_bytes = write_remote_geotiff_fixture(tmp_path / "cancel.tif")
    with S3FixtureService() as fixture:
        fixture.add_object("datasets/cancel.tif", geotiff_bytes)
        connection = fixture_connection(fixture)
        candidate = asyncio.run(discover_all(S3DatasetDiscovery(
            (fixture_root(fixture),),
            connection,
        )))[0]
        worker_started = Event()
        worker_release = Event()

        def blocking_metadata_builder(
            remote_candidate: RemoteDatasetCandidate,
            remote_connection: S3ConnectionSettings,
            remote_handlers: RemoteDatasetHandlerRegistry,
        ) -> DatasetMetadataResult:
            """Pause one real fixture-backed metadata read.

            Args:
                remote_candidate: Candidate supplied by the pipeline.
                remote_connection: S3 connection supplied by the pipeline.
                remote_handlers: Explicit remote format registry.

            Returns:
                Real metadata result after the test releases the worker.
            """
            worker_started.set()
            if not worker_release.wait(timeout=2):
                raise AssertionError("Cancellation test did not release worker")
            return build_s3_dataset_metadata(
                remote_candidate,
                remote_connection,
                remote_handlers,
            )

        monkeypatch.setattr(
            "eolab_app.catalog.s3.build_s3_dataset_metadata",
            blocking_metadata_builder,
        )

        async def cancel_result() -> None:
            """Cancel one pending result after its worker starts."""
            results = S3DatasetMetadataPipeline(connection).results((candidate,))
            result_task = asyncio.create_task(anext(results))
            await asyncio.to_thread(worker_started.wait, 2)
            result_task.cancel()
            asyncio.get_running_loop().call_later(0.05, worker_release.set)
            with pytest.raises(asyncio.CancelledError):
                await result_task
            await results.aclose()

        asyncio.run(cancel_result())

    assert worker_started.is_set()
    assert worker_release.is_set()
