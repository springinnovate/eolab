"""Original-data equivalence and private lifetime checks at the shared raster boundary."""

import asyncio
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
from threading import Event
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from eolab_app.raster.models import (
    AuthorizedRaster,
    CatalogPixelRequest,
    CatalogRasterRequest,
    CatalogRasterStatisticsRequest,
    CatalogRasterPairRequest,
)
from eolab_app.raster.pixel_service import RasterPixelService
from eolab_app.raster.errors import RasterConflictError
from eolab_app.raster.source_access import RasterSourceAccess
from eolab_app.raster.source_identity import RasterSourceIdentity
from eolab_app.raster.source_models import (
    RasterPixelSourceRequest,
    RasterStatisticsSourceRequest,
    RasterPairSourceRequest,
    RunArtifactReference,
)
from eolab_app.raster.statistics_service import RasterStatisticsService
from eolab_app.routes.raster_analysis import create_raster_analysis_router
from eolab_app.source_files import (
    LeasedSourceFiles,
    ResolvedSourceFile,
    SourceFileError,
    file_identity,
    finish_source_task,
)
from eolab_app.execution.bounded_process import ProcessDeadlineError
from test_raster_statistics_service import _statistics

CATALOG = {
    "collectionId": "eolab-mounted-geotiffs",
    "itemId": "geotiff-0123456789abcdef01234567",
}
PRIVATE = {"kind": "runArtifact", "jobId": "a" * 32, "artifactId": "b" * 32}


def test_missing_geographic_extent_does_not_disable_numerical_capabilities(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An extent projection failure leaves original-grid analysis metadata available.

    Args:
        tmp_path: Isolated original-raster directory.
        monkeypatch: Replace only the optional extent conversion.
    """
    from eolab_app.raster import source_access

    def unavailable(*args: Any) -> None:
        """Represent an unsupported geographic extent.

        Args:
            args: Source CRS and original bounds.

        Raises:
            ValueError: Always, to model failed extent conversion.
        """
        raise ValueError("No geographic extent")

    monkeypatch.setattr(source_access, "transform_bounds_to_wgs84", unavailable)
    result = source_access.describe_raster_file(write_source(tmp_path / "source.tif"))
    assert result["bounds"] is None
    assert result["capabilities"]["pixels"]["supported"]
    assert result["capabilities"]["statistics"]["supported"]


def write_source(path: Path, masked: bool = False) -> Path:
    """Write a small original-resolution raster with optional internal validity.

    Args:
        path: Isolated test source path.
        masked: Whether the upper-left value is invalid through an internal mask.

    Returns:
        Completed single-band GeoTIFF containing values zero through fifteen.
    """
    with (
        rasterio.Env(GDAL_TIFF_INTERNAL_MASK=True),
        rasterio.open(
            path,
            "w",
            driver="GTiff",
            width=4,
            height=4,
            count=1,
            dtype="float32",
            crs="EPSG:4326",
            transform=from_origin(-2, 2, 1, 1),
        ) as target,
    ):
        target.write(np.arange(16, dtype="float32").reshape(4, 4), 1)
        if masked:
            mask = np.full((4, 4), 255, dtype="uint8")
            mask[0, 0] = 0
            target.write_mask(mask)
    return path


@dataclass
class FileLease:
    """A controlled authority's immutable file and its outstanding retention token."""

    path: Path
    size: int
    sha256: str
    lease_id: str
    media_type: str = "image/tiff"


class FileAuthority:
    """Track ownership, immutable metadata and active leases without a database fake reader."""

    def __init__(self, path: Path) -> None:
        """Record one published source's metadata.

        Args:
            path: Completed source GeoTIFF.
        """
        self.path = path
        self.size = path.stat().st_size
        self.sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
        self.ready = True
        self.owners = {"owner"}
        self.leases: set[str] = set()
        self.sequence = 0
        self.check_count = 0

    async def check(self, owner: str, run: str, file: str) -> tuple[int, str, str]:
        """Authorize the requesting session against current source availability.

        Args:
            owner: Server-derived owner.
            run: Opaque run identity.
            file: Opaque file identity.

        Returns:
            Published size, checksum and format.

        Raises:
            SourceFileError: If ownership or availability fails.
        """
        self.check_count += 1
        if (
            owner not in self.owners
            or run != PRIVATE["jobId"]
            or file != PRIVATE["artifactId"]
        ):
            raise SourceFileError("Unavailable to this session", 404)
        if not self.ready:
            raise SourceFileError("Result expired or deleted", 409)
        return self.size, self.sha256, "image/tiff"

    async def acquire(self, owner: str, run: str, file: str) -> FileLease:
        """Authorize and retain a file before any native read.

        Args:
            owner: Requesting owner.
            run: Opaque run identity.
            file: Opaque file identity.

        Returns:
            Newly retained source.

        Raises:
            SourceFileError: If current authorization fails.
        """
        await self.check(owner, run, file)
        self.sequence += 1
        lease = str(self.sequence)
        self.leases.add(lease)
        return FileLease(self.path, self.size, self.sha256, lease)

    async def resolve(self, owner: str, run: str, file: str) -> ResolvedSourceFile:
        """Authorize a short read of the original file without retaining it.

        Args:
            owner: Requesting session.
            run: Opaque run identity.
            file: Opaque output identity.

        Returns:
            Original-file metadata after the same ownership and expiry check.

        Raises:
            SourceFileError: If current access is denied.
        """
        await self.check(owner, run, file)
        return ResolvedSourceFile(self.path, self.size, self.sha256, "image/tiff")

    async def release(self, lease: str) -> bool:
        """Release one completed read's retention token.

        Args:
            lease: Acquired token.

        Returns:
            True after removal.
        """
        self.leases.remove(lease)
        return True

    async def renew(self, lease: str) -> bool:
        """Keep existing reader retention independent of new-request availability.

        Args:
            lease: Acquired token.

        Returns:
            Whether the transfer is still retained.
        """
        return lease in self.leases

    def files(self, renewal_seconds: float = 10) -> LeasedSourceFiles:
        """Compose the actual shared file-access helper.

        Args:
            renewal_seconds: Shortened only for the lease-loss fixture.

        Returns:
            Production source lifetime/verification code with controlled authority.
        """
        return LeasedSourceFiles(
            self.acquire,
            self.release,
            self.check,
            self.renew,
            renewal_seconds=renewal_seconds,
            resolve=self.resolve,
        )


class CatalogAuthority:
    """Authorize the same original data through the existing catalog interface."""

    def __init__(self, path: Path) -> None:
        """Retain a catalog source identity.

        Args:
            path: Original source path.
        """
        self.source = AuthorizedRaster(path, RasterSourceIdentity.read(path))

    async def authorize(self, request: CatalogRasterRequest) -> AuthorizedRaster:
        """Resolve a validated catalog identity without a renderer.

        Args:
            request: Requested catalog identity.

        Returns:
            Scanner-authorized original data.
        """
        return self.source


def test_catalog_and_private_sources_use_the_same_native_analysis(
    tmp_path: Path,
) -> None:
    """Compare exact pixels and ordinary/paired distributions through both source adapters.

    Args:
        tmp_path: Isolated source directory.
    """
    path = write_source(tmp_path / "source.tif")
    authority = FileAuthority(path)
    sources = RasterSourceAccess(CatalogAuthority(path), authority.files())
    pixels, statistics = RasterPixelService(sources, 2), RasterStatisticsService(
        sources, 2, 8
    )

    async def exercise() -> None:
        """Use actual numerical readers and inspect cache reuse and lease cleanup."""
        location = {"longitude": -0.5, "latitude": 0.5}
        catalog_pixel = await pixels.get(CatalogPixelRequest(**CATALOG, **location))
        private_pixel = await pixels.get(
            RasterPixelSourceRequest(source=PRIVATE, **location), "owner"
        )
        assert catalog_pixel == private_pixel and private_pixel.value == 5
        request = RasterStatisticsSourceRequest(source=PRIVATE)
        expected = await statistics.get(CatalogRasterStatisticsRequest(**CATALOG))
        actual = await statistics.get(request, "owner")
        assert actual == expected and actual.valid_sample_count == 16
        assert await statistics.get(request, "owner") is actual
        categorized = await statistics.get(
            RasterStatisticsSourceRequest(source=PRIVATE, categoryValues=[0, 5, 15]),
            "owner",
        )
        assert categorized == await statistics.get(
            CatalogRasterStatisticsRequest(**CATALOG, categoryValues=[0, 5, 15])
        )
        paired = await statistics.get_paired(
            RasterPairSourceRequest(xRaster=PRIVATE, yRaster=CATALOG), "owner"
        )
        catalog_pair = await statistics.get_paired(
            CatalogRasterPairRequest(
                xRaster={**CATALOG, "itemId": "geotiff-" + "f" * 24},
                yRaster=CATALOG,
            )
        )
        assert paired == catalog_pair and paired.paired_sample_count > 0
        assert not authority.leases
        authority.ready = False
        with pytest.raises(SourceFileError):
            await statistics.get(request, "owner")
        authority.ready = True
        with pytest.raises(SourceFileError) as error:
            await statistics.get(request, "foreign")
        assert error.value.status == 404
        with path.open("ab") as stream:
            stream.write(b"changed")
        with pytest.raises(SourceFileError, match="changed"):
            await statistics.get(request, "owner")
        assert not authority.leases

    asyncio.run(exercise())


@pytest.mark.parametrize("masked", [False, True])
def test_metadata_and_services_support_embedded_validity_masks(
    tmp_path: Path, masked: bool
) -> None:
    """Read embedded validity consistently through private pixel/statistics services.

    Args:
        tmp_path: Isolated source directory.
        masked: Exclude the upper-left zero through an internal mask.
    """
    path = write_source(tmp_path / "source.tif", masked)
    authority = FileAuthority(path)
    sources = RasterSourceAccess(CatalogAuthority(path), authority.files())
    result = asyncio.run(sources.describe(RunArtifactReference(**PRIVATE), "owner"))
    assert result["width"] == 4 and result["height"] == 4
    assert result["version"] == authority.sha256
    assert result["capabilities"]["pixels"]["supported"]
    assert result["capabilities"]["statistics"]["supported"]
    if masked:
        pixel = asyncio.run(
            RasterPixelService(sources, 1).get(
                RasterPixelSourceRequest(source=PRIVATE, longitude=-1.5, latitude=1.5),
                "owner",
            )
        )
        assert pixel.in_bounds and pixel.value is None
        statistics = asyncio.run(
            RasterStatisticsService(sources, 1, 1).get(
                RasterStatisticsSourceRequest(source=PRIVATE), "owner"
            )
        )
        assert statistics.valid_sample_count == 15
    assert str(path) not in str(result) and not authority.leases


def test_private_analysis_requests_are_path_free_and_keep_legacy_catalog_requests(
    tmp_path: Path,
) -> None:
    """Exercise the public analysis schemas, owner injection and private response headers.

    Args:
        tmp_path: Isolated source directory.
    """
    path = write_source(tmp_path / "source.tif")
    authority = FileAuthority(path)
    sources = RasterSourceAccess(CatalogAuthority(path), authority.files())
    app = FastAPI()
    app.include_router(
        create_raster_analysis_router(
            RasterPixelService(sources, 2),
            RasterStatisticsService(sources, 2, 8),
            source_access=sources,
            session_owner=lambda request, response: request.cookies.get(
                "session", "foreign"
            ),
        )
    )
    with TestClient(app) as client:
        client.cookies.set("session", "owner")
        body = {"source": PRIVATE, "longitude": -0.5, "latitude": 0.5}
        response = client.post("/api/raster-analysis/pixels", json=body)
        assert response.status_code == 200 and response.json()["value"] == 5
        assert "no-store" in response.headers["cache-control"]
        assert (
            client.post("/api/raster-analysis/statistics", json=CATALOG).status_code
            == 200
        )
        assert (
            client.post(
                "/api/raster-analysis/sources", json={"source": PRIVATE}
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/raster-analysis/pixels",
                json={**body, "source": {**PRIVATE, "path": str(path)}},
            ).status_code
            == 422
        )
        assert (
            client.post(
                "/api/raster-analysis/pixels", json={**body, "owner": "owner"}
            ).status_code
            == 422
        )
        client.cookies.clear()
        denied = client.post("/api/raster-analysis/pixels", json=body)
        assert (
            denied.status_code == 404 and "no-store" in denied.headers["cache-control"]
        )
    assert not authority.leases


def test_coalesced_private_read_retains_files_until_its_last_waiter_stops(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One cancelled caller cannot release the remaining caller's source or shared read.

    Args:
        tmp_path: Isolated source directory.
        monkeypatch: Control only the supervised execution boundary.
    """
    path = write_source(tmp_path / "source.tif")
    authority = FileAuthority(path)

    async def exercise() -> None:
        """Cancel coalesced waiters in order and observe native-stop-before-release."""
        entered, stopped = asyncio.Event(), asyncio.Event()
        calls = 0

        async def native(reader: Any, *arguments: Any) -> Any:
            """Hold admitted native work until its final request cancels it.

            Args:
                reader: Existing reader selected by the service.
                arguments: Original source and sampling arguments.

            Returns:
                No result because this fixture is cancelled.
            """
            nonlocal calls
            calls += 1
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                assert authority.leases
                stopped.set()

        monkeypatch.setattr(
            "eolab_app.raster.statistics_service.read_private_raster", native
        )
        sources = RasterSourceAccess(CatalogAuthority(path), authority.files())
        service = RasterStatisticsService(sources, 1, 8)
        request = RasterStatisticsSourceRequest(source=PRIVATE)
        first = asyncio.create_task(service.get(request, "owner"))
        await asyncio.wait_for(entered.wait(), 10)
        second = asyncio.create_task(service.get(request, "owner"))

        async def wait_for_join() -> None:
            """Wait for the second authorized request to join the shared computation."""
            while service._waiter_count < 2:
                await asyncio.sleep(0.01)

        await asyncio.wait_for(wait_for_join(), 10)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        assert authority.leases and not stopped.is_set()
        second.cancel()
        with pytest.raises(asyncio.CancelledError):
            await second
        assert stopped.is_set() and not authority.leases and calls == 1

    asyncio.run(exercise())


def test_revocation_during_read_prevents_delivery_and_cache_cannot_restore_access(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Reauthorize after native completion and again before any later cache hit.

    Args:
        tmp_path: Isolated source directory.
        monkeypatch: Revoke access during the real service's numerical boundary.
    """
    path = write_source(tmp_path / "source.tif")
    authority = FileAuthority(path)

    async def read_and_revoke(reader: Any, *arguments: Any) -> Any:
        """Return numerical data after deleting access to its source.

        Args:
            reader: Existing reader selected by the service.
            arguments: Authorized native arguments.

        Returns:
            Valid statistics that must not reach the requester.
        """
        authority.ready = False
        return _statistics(4)

    monkeypatch.setattr(
        "eolab_app.raster.statistics_service.read_private_raster", read_and_revoke
    )
    sources = RasterSourceAccess(CatalogAuthority(path), authority.files())
    service = RasterStatisticsService(sources, 1, 8)

    async def exercise() -> None:
        """Reject both the completed read and a later request for its cached values."""
        for _ in range(2):
            with pytest.raises(SourceFileError):
                await service.get(
                    RasterStatisticsSourceRequest(source=PRIVATE), "owner"
                )
            assert not authority.leases

    asyncio.run(exercise())


def test_private_pixel_uses_the_original_grid_beyond_preview_resolution(
    tmp_path: Path,
) -> None:
    """Read a cell beyond column 512 from its source grid instead of a display preview.

    Args:
        tmp_path: Isolated original raster directory.
    """
    path = tmp_path / "wide.tif"
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=600,
        height=4,
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=from_origin(-3, 2, 0.01, 1),
    ) as target:
        target.write(np.arange(2400, dtype="float32").reshape(4, 600), 1)
    authority = FileAuthority(path)
    sources = RasterSourceAccess(CatalogAuthority(path), authority.files())
    pixel = asyncio.run(
        RasterPixelService(sources, 1).get(
            RasterPixelSourceRequest(source=PRIVATE, longitude=2.995, latitude=1.5),
            "owner",
        )
    )
    assert pixel.column == 599 and pixel.row == 0 and pixel.value == 599
    assert not authority.leases


def test_private_statistics_cache_is_separate_for_each_owner(tmp_path: Path) -> None:
    """Even authorities allowing two owners must not reuse private cache entries across them.

    Args:
        tmp_path: Isolated original raster directory.
    """
    path = write_source(tmp_path / "source.tif")
    authority = FileAuthority(path)
    authority.owners.add("second-owner")
    service = RasterStatisticsService(
        RasterSourceAccess(CatalogAuthority(path), authority.files()), 1, 8
    )

    async def exercise() -> None:
        """Read equal values under distinct ownership-aware cache identities."""
        request = RasterStatisticsSourceRequest(source=PRIVATE)
        first = await service.get(request, "owner")
        second = await service.get(request, "second-owner")
        assert first == second and first is not second
        assert await service.get(request, "second-owner") is second
        assert not authority.leases

    asyncio.run(exercise())


def test_private_no_overlap_uses_the_existing_statistics_error(tmp_path: Path) -> None:
    """Keep typed numerical failures intact across the private native-process boundary.

    Args:
        tmp_path: Isolated original raster directory.
    """
    path = write_source(tmp_path / "source.tif")
    authority = FileAuthority(path)
    service = RasterStatisticsService(
        RasterSourceAccess(CatalogAuthority(path), authority.files()), 1, 8
    )
    bounds = {"west": 10, "south": 10, "east": 11, "north": 11}

    async def exercise() -> None:
        """Compare catalog and private no-overlap messages through the real readers."""
        for request, owner in (
            (CatalogRasterStatisticsRequest(**CATALOG, selectedBounds=bounds), None),
            (
                RasterStatisticsSourceRequest(source=PRIVATE, selectedBounds=bounds),
                "owner",
            ),
        ):
            with pytest.raises(
                RasterConflictError, match="selected area does not overlap"
            ):
                await service.get(request, owner)
        assert not authority.leases

    asyncio.run(exercise())


def test_mutation_during_a_read_prevents_source_delivery(tmp_path: Path) -> None:
    """Do not deliver derived data when a verified file changes during its read scope.

    Args:
        tmp_path: Isolated immutable source fixture.
    """
    path = write_source(tmp_path / "source.tif")
    authority = FileAuthority(path)

    async def exercise() -> None:
        """Modify the retained file after checksum verification, before delivery."""
        with pytest.raises(SourceFileError, match="changed while"):
            async with authority.files().open(
                "owner", PRIVATE["jobId"], PRIVATE["artifactId"]
            ):
                with path.open("ab") as stream:
                    stream.write(b"changed")
        assert not authority.leases

    asyncio.run(exercise())


def test_private_pixel_reuses_short_reader_without_checksums_or_processes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Private picking uses the catalog reader and handles a disappearing source.

    Args:
        tmp_path: Original-file fixture directory.
        monkeypatch: Forbid expensive verification and child-process startup.
    """
    from eolab_app.raster.pixel import read_raster_pixel

    path = write_source(tmp_path / "source.tif")
    authority = FileAuthority(path)

    async def forbidden(*args: Any, **kwargs: Any) -> Any:
        """Fail if an interactive pixel request invokes the process supervisor.

        Args:
            args: Unexpected supervisor arguments.
            kwargs: Unexpected supervisor options.

        Raises:
            AssertionError: Always; picking must use its ordinary reader.
        """
        raise AssertionError("Pixel picking must not hash files or spawn children")

    monkeypatch.setattr("eolab_app.source_files.run_bounded_process", forbidden)
    monkeypatch.setattr("eolab_app.raster.source_access.run_bounded_process", forbidden)
    sources = RasterSourceAccess(CatalogAuthority(path), authority.files())
    service = RasterPixelService(sources, 1, pixel_reader=read_raster_pixel)
    request = RasterPixelSourceRequest(source=PRIVATE, longitude=-1.5, latitude=1.5)

    async def exercise() -> None:
        """Read the same cell, then reject wrong ownership, expiry and missing data."""
        catalog = await service.get(
            CatalogPixelRequest(**CATALOG, longitude=-1.5, latitude=1.5)
        )
        assert await service.get(request, "owner") == catalog
        assert authority.sequence == 0 and not authority.leases
        with pytest.raises(SourceFileError):
            await service.get(request, "someone-else")
        authority.ready = False
        with pytest.raises(SourceFileError):
            await service.get(request, "owner")
        authority.ready = True
        path.unlink()
        with pytest.raises(RasterConflictError, match="could not be sampled"):
            await service.get(request, "owner")

    asyncio.run(exercise())


def test_cancelled_private_pixel_retains_only_reader_capacity(tmp_path: Path) -> None:
    """Cancelled picks discard results while the existing bounded thread finishes.

    Args:
        tmp_path: Original-file fixture directory.
    """
    path = write_source(tmp_path / "source.tif")
    authority = FileAuthority(path)
    entered, release = Event(), Event()
    calls = []

    def reader(source: Path, longitude: float, latitude: float) -> Any:
        """Hold one ordinary reader to observe admission and cancellation.

        Args:
            source: Original raster path.
            longitude: Requested longitude.
            latitude: Requested latitude.

        Returns:
            Existing native pixel result.
        """
        from eolab_app.raster.pixel import read_raster_pixel

        calls.append(source)
        entered.set()
        release.wait(5)
        return read_raster_pixel(source, longitude, latitude)

    async def exercise() -> None:
        """Keep a second pick queued until the cancelled first native read exits."""
        service = RasterPixelService(
            RasterSourceAccess(CatalogAuthority(path), authority.files()), 1, reader
        )
        request = RasterPixelSourceRequest(source=PRIVATE, longitude=-1.5, latitude=1.5)
        first = asyncio.create_task(service.get(request, "owner"))
        await asyncio.to_thread(entered.wait, 3)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        second = asyncio.create_task(service.get(request, "owner"))
        await asyncio.sleep(0.02)
        assert len(calls) == 1 and not authority.leases
        release.set()
        await asyncio.wait_for(second, 3)
        assert len(calls) == 2

    try:
        asyncio.run(exercise())
    finally:
        release.set()


def test_lost_lease_cannot_be_hidden_by_shielded_consumer_cleanup(
    tmp_path: Path,
) -> None:
    """Withhold results when final cleanup consumes a renewal-loss cancellation.

    Args:
        tmp_path: Isolated immutable source fixture.
    """
    authority = FileAuthority(write_source(tmp_path / "source.tif"))

    async def exercise() -> None:
        """Lose the lease while the consumer waits for cancellation-safe cleanup."""
        reading = False

        async def renew(lease: str) -> bool:
            """Lose retention after source verification succeeds.

            Args:
                lease: Current file retention token.

            Returns:
                True until the consumer starts using its file.
            """
            return lease in authority.leases and not reading

        files = LeasedSourceFiles(
            authority.acquire,
            authority.release,
            authority.check,
            renew,
            renewal_seconds=0.02,
        )
        with pytest.raises(SourceFileError, match="no longer available"):
            async with files.open("owner", PRIVATE["jobId"], PRIVATE["artifactId"]):
                reading = True
                await finish_source_task(asyncio.create_task(asyncio.sleep(0.1)))
        assert not authority.leases

    asyncio.run(exercise())


def test_source_verification_has_bounded_capacity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Reject excess verification before a third file read starts and release all leases.

    Args:
        tmp_path: Isolated immutable source fixture.
        monkeypatch: Hold the supervised checksum boundary while admission fills.
    """
    path = write_source(tmp_path / "source.tif")
    authority = FileAuthority(path)
    authority.owners.add("second-owner")

    async def exercise() -> None:
        """Occupy both source-check slots, then reject and clean up the third request."""
        entered = asyncio.Event()
        calls = 0

        async def verify(*arguments: Any) -> Any:
            """Hold native checksum work until the request is cancelled.

            Args:
                arguments: Source-verification process arguments.

            Returns:
                No result because the fixture is cancelled.
            """
            nonlocal calls
            calls += 1
            if calls == 2:
                entered.set()
            await asyncio.Event().wait()

        monkeypatch.setattr("eolab_app.source_files.run_bounded_process", verify)
        files = authority.files()

        async def consume(owner: str = "owner") -> None:
            """Hold the authorized file around a consumer's complete read.

            Args:
                owner: Requesting session, distinguishing independently admitted checks.
            """
            async with files.open(owner, PRIVATE["jobId"], PRIVATE["artifactId"]):
                pytest.fail("The checksum fixture must not return a source")

        first, second = (
            asyncio.create_task(consume()),
            asyncio.create_task(consume("second-owner")),
        )
        await asyncio.wait_for(entered.wait(), 10)
        with pytest.raises(SourceFileError) as failure:
            await consume()
        assert failure.value.status == 429 and calls == 2
        first.cancel()
        second.cancel()
        await asyncio.gather(first, second, return_exceptions=True)
        assert not authority.leases

    asyncio.run(exercise())


async def consume_private_source(
    files: LeasedSourceFiles, owner: str = "owner"
) -> None:
    """Complete a file read through its authorization, verification and release boundary.

    Args:
        files: Production file access with a controlled test authority.
        owner: Session requesting the fixed private test source.

    Raises:
        SourceFileError: If authorization, verification or final access checks fail.
        asyncio.CancelledError: After the cancelled request's retention ends.
    """
    async with files.open(owner, PRIVATE["jobId"], PRIVATE["artifactId"]):
        pass


def test_missing_file_before_verification_keeps_its_integrity_error(
    tmp_path: Path,
) -> None:
    """Preserve the integrity failure and release retention when a leased file disappears.

    Args:
        tmp_path: Directory holding the published file before its disappearance.
    """
    authority = FileAuthority(write_source(tmp_path / "source.tif"))
    files = authority.files()

    async def acquire_then_remove(owner: str, run: str, file: str) -> FileLease:
        """Remove the file immediately after its authority grants a read lease.

        Args:
            owner: Requesting session.
            run: Opaque run identity.
            file: Opaque file identity.

        Returns:
            Authorized lease whose file disappears before verification starts.
        """
        lease = await authority.acquire(owner, run, file)
        authority.path.unlink()
        return lease

    files.acquire = acquire_then_remove
    with pytest.raises(
        SourceFileError, match="changed and is no longer valid"
    ) as error:
        asyncio.run(consume_private_source(files))
    assert error.value.status == 422 and not authority.leases


@pytest.mark.parametrize("outcome", ["success", "changed", "timeout", "stat_changed"])
def test_pending_verification_shares_work_but_not_leases_or_completed_results(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, outcome: str
) -> None:
    """Share one pending checksum while preserving admission, access checks and fresh retries.

    Args:
        tmp_path: Original immutable-file directory.
        monkeypatch: Control only the supervised checksum execution boundary.
        outcome: Verification success, content mismatch, timeout or mutation before delivery.
    """
    authority = FileAuthority(write_source(tmp_path / "source.tif"))

    async def exercise() -> None:
        """Join two checks, reject a third request and verify again after completion."""
        entered, finish = asyncio.Event(), asyncio.Event()
        second_admitted = asyncio.Event()
        calls = 0
        current_outcome = outcome

        async def renew(lease: str) -> bool:
            """Observe the second pending request through its live retention callback.

            Args:
                lease: Independently acquired request lease.

            Returns:
                Whether the authority still retains the lease.
            """
            if lease == "2":
                second_admitted.set()
            return lease in authority.leases

        async def verify(*arguments: Any) -> tuple[int, int, int, int, int] | None:
            """Hold one checksum and return the chosen native verification outcome.

            Args:
                arguments: Existing supervised target, file metadata and deadline.

            Returns:
                Current file identity, or None for a changed file.

            Raises:
                ProcessDeadlineError: For the controlled verification timeout.
            """
            nonlocal calls
            calls += 1
            entered.set()
            await finish.wait()
            if current_outcome == "timeout":
                raise ProcessDeadlineError
            if current_outcome == "changed":
                return None
            identity = file_identity(authority.path)
            if current_outcome == "stat_changed":
                stat = authority.path.stat()
                os.utime(
                    authority.path,
                    ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000),
                )
            return identity

        monkeypatch.setattr("eolab_app.source_files.run_bounded_process", verify)
        monkeypatch.setattr(authority, "renew", renew)
        files = authority.files(renewal_seconds=0.01)
        first = asyncio.create_task(consume_private_source(files))
        await asyncio.wait_for(entered.wait(), 3)
        second = asyncio.create_task(consume_private_source(files))
        try:
            await asyncio.wait_for(second_admitted.wait(), 3)
            with pytest.raises(SourceFileError) as rejected:
                await asyncio.wait_for(consume_private_source(files), 3)
            assert rejected.value.status == 429
            assert calls == 1 and len(authority.leases) == 2
            finish.set()
            results = await asyncio.gather(first, second, return_exceptions=True)
            if outcome == "success":
                assert results == [None, None]
                assert authority.check_count == 5
            else:
                assert all(isinstance(result, SourceFileError) for result in results)
                assert [result.status for result in results] == [
                    504 if outcome == "timeout" else 422
                ] * 2
            assert not authority.leases
            current_outcome = "success"
            await consume_private_source(files)
            assert calls == 2 and not authority.leases
        finally:
            first.cancel()
            second.cancel()
            await asyncio.gather(first, second, return_exceptions=True)

    asyncio.run(exercise())


def test_completed_verification_rejects_same_size_content_change(
    tmp_path: Path,
) -> None:
    """Recheck the published checksum when content changes but size and mtime do not.

    Args:
        tmp_path: Original immutable-file directory.
    """
    authority = FileAuthority(write_source(tmp_path / "source.tif"))

    async def exercise() -> None:
        """Complete a real checksum, replace one byte and reject its former identity."""
        files = authority.files()
        await consume_private_source(files)
        assert not authority.leases
        original = authority.path.stat()
        data = bytearray(authority.path.read_bytes())
        data[-1] ^= 1
        authority.path.write_bytes(data)
        os.utime(authority.path, ns=(original.st_atime_ns, original.st_mtime_ns))
        changed = authority.path.stat()
        assert changed.st_size == original.st_size
        assert changed.st_mtime_ns == original.st_mtime_ns
        with pytest.raises(SourceFileError, match="changed") as rejected:
            await consume_private_source(files)
        assert rejected.value.status == 422 and not authority.leases

    asyncio.run(exercise())


@pytest.mark.parametrize("difference", ["owner", "file", "stat"])
def test_pending_verification_does_not_cross_source_or_owner_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, difference: str
) -> None:
    """Verify independently when an overlapping caller has a different source identity.

    Args:
        tmp_path: Original and replacement immutable-file directory.
        monkeypatch: Hold native checks while both requests are admitted.
        difference: Changed requesting owner, physical file or file-stat identity.
    """
    authority = FileAuthority(write_source(tmp_path / "source.tif"))

    async def exercise() -> None:
        """Admit two distinct identities and stop both native checks before releasing files."""
        first_entered, both_entered = asyncio.Event(), asyncio.Event()
        calls = 0

        async def verify(*arguments: Any) -> None:
            """Retain each distinct verification until its request is cancelled.

            Args:
                arguments: Existing supervised target, file metadata and deadline.
            """
            nonlocal calls
            calls += 1
            first_entered.set()
            if calls == 2:
                both_entered.set()
            await asyncio.Event().wait()

        monkeypatch.setattr("eolab_app.source_files.run_bounded_process", verify)
        files = authority.files()
        first = asyncio.create_task(consume_private_source(files))
        await asyncio.wait_for(first_entered.wait(), 3)
        owner = "owner"
        if difference == "owner":
            owner = "second-owner"
            authority.owners.add(owner)
        elif difference == "file":
            authority.path = write_source(tmp_path / "other.tif")
        else:
            stat = authority.path.stat()
            os.utime(
                authority.path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000)
            )
        second = asyncio.create_task(consume_private_source(files, owner))
        try:
            await asyncio.wait_for(both_entered.wait(), 3)
            assert calls == 2 and len(authority.leases) == 2
        finally:
            first.cancel()
            second.cancel()
            await asyncio.gather(first, second, return_exceptions=True)
        assert not authority.leases

    asyncio.run(exercise())


@pytest.mark.parametrize("cancel_first", [0, 1])
@pytest.mark.parametrize("finish_remaining", [True, False])
@pytest.mark.parametrize("stop_reason", ["cancel", "lease_loss"])
def test_shared_verification_cancellation_keeps_the_other_request_protected(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    cancel_first: int,
    finish_remaining: bool,
    stop_reason: str,
) -> None:
    """Detach either cancelled caller and stop shared native work before its final lease ends.

    Args:
        tmp_path: Immutable-file fixture directory.
        monkeypatch: Control native verification and its final stop.
        cancel_first: Whether the first or second admitted caller cancels first.
        finish_remaining: Complete the surviving request or repeatedly cancel it.
        stop_reason: Explicit caller cancellation or loss of its renewable lease.
    """
    authority = FileAuthority(write_source(tmp_path / "source.tif"))

    async def exercise() -> None:
        """Cancel one caller promptly, then complete or cancel the remaining checksum owner."""
        entered, finish = asyncio.Event(), asyncio.Event()
        second_admitted = asyncio.Event()
        stopping, allow_stop, stopped = (
            asyncio.Event(),
            asyncio.Event(),
            asyncio.Event(),
        )
        calls = 0
        lost_lease: str | None = None

        async def renew(lease: str) -> bool:
            """Renew each request's lease until that specific retention token is lost.

            Args:
                lease: Independently acquired retention token.

            Returns:
                Whether the test authority still retains this request's lease.
            """
            if lease == "2":
                second_admitted.set()
            return lease in authority.leases and lease != lost_lease

        async def verify(*arguments: Any) -> tuple[int, int, int, int, int]:
            """Keep native verification alive until completion or controlled cancellation.

            Args:
                arguments: Existing supervised target, file metadata and deadline.

            Returns:
                Verified file identity after successful completion.
            """
            nonlocal calls
            calls += 1
            entered.set()
            try:
                await finish.wait()
                return file_identity(authority.path)
            finally:
                stopping.set()
                await allow_stop.wait()
                assert authority.leases
                stopped.set()

        monkeypatch.setattr("eolab_app.source_files.run_bounded_process", verify)
        monkeypatch.setattr(authority, "renew", renew)
        files = authority.files(renewal_seconds=0.01)
        tasks = [asyncio.create_task(consume_private_source(files))]
        await asyncio.wait_for(entered.wait(), 3)
        tasks.append(asyncio.create_task(consume_private_source(files)))
        try:
            await asyncio.wait_for(second_admitted.wait(), 3)
            with pytest.raises(SourceFileError) as rejected:
                await asyncio.wait_for(consume_private_source(files), 3)
            assert rejected.value.status == 429 and calls == 1
            if stop_reason == "cancel":
                tasks[cancel_first].cancel()
            else:
                lost_lease = str(cancel_first + 1)
            expected_error = (
                asyncio.CancelledError if stop_reason == "cancel" else SourceFileError
            )
            with pytest.raises(expected_error):
                await asyncio.wait_for(tasks[cancel_first], 3)
            assert len(authority.leases) == 1 and not stopping.is_set()
            remaining = tasks[1 - cancel_first]
            if finish_remaining:
                allow_stop.set()
                finish.set()
                await asyncio.wait_for(remaining, 3)
            else:
                remaining.cancel()
                await asyncio.wait_for(stopping.wait(), 3)
                remaining.cancel()
                await asyncio.sleep(0)
                assert not remaining.done() and len(authority.leases) == 1
                allow_stop.set()
                with pytest.raises(asyncio.CancelledError):
                    await asyncio.wait_for(remaining, 3)
            assert stopped.is_set() and not authority.leases and calls == 1
        finally:
            allow_stop.set()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    asyncio.run(exercise())
