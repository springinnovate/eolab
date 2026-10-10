"""Original-data equivalence and private lifetime checks at the shared raster boundary."""

import asyncio
from dataclasses import dataclass
import hashlib
from pathlib import Path
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
    SourceFileError,
    finish_source_task,
)
from test_raster_statistics_service import _statistics

CATALOG = {
    "collectionId": "eolab-mounted-geotiffs",
    "itemId": "geotiff-0123456789abcdef01234567",
}
PRIVATE = {"kind": "runArtifact", "jobId": "a" * 32, "artifactId": "b" * 32}


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
def test_metadata_reports_reader_capabilities_without_promising_mask_support(
    tmp_path: Path, masked: bool
) -> None:
    """Describe original metadata and distinguish current pixel/statistics mask support.

    Args:
        tmp_path: Isolated source directory.
        masked: Include validity that the statistics reader currently rejects.
    """
    path = write_source(tmp_path / "source.tif", masked)
    authority = FileAuthority(path)
    sources = RasterSourceAccess(CatalogAuthority(path), authority.files())
    result = asyncio.run(sources.describe(RunArtifactReference(**PRIVATE), "owner"))
    assert result["width"] == 4 and result["height"] == 4
    assert result["version"] == authority.sha256
    assert result["capabilities"]["pixels"]["supported"]
    assert result["capabilities"]["statistics"]["supported"] is not masked
    if masked:
        assert "validity masks" in result["capabilities"]["statistics"]["reason"]
        pixel = asyncio.run(
            RasterPixelService(sources, 1).get(
                RasterPixelSourceRequest(source=PRIVATE, longitude=-1.5, latitude=1.5),
                "owner",
            )
        )
        assert pixel.in_bounds and pixel.value is None
        with pytest.raises(RasterConflictError, match="validity masks"):
            asyncio.run(
                RasterStatisticsService(sources, 1, 1).get(
                    RasterStatisticsSourceRequest(source=PRIVATE), "owner"
                )
            )
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


def test_lost_lease_stops_pixel_work_before_releasing_the_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failed renewal cancels active native work and withholds its result.

    Args:
        tmp_path: Isolated immutable source fixture.
        monkeypatch: Control native execution and the owning renewal callback.
    """
    path = write_source(tmp_path / "source.tif")
    authority = FileAuthority(path)

    async def exercise() -> None:
        """Lose retention only after the native reader starts."""
        entered, stopped = asyncio.Event(), asyncio.Event()

        async def renew(lease: str) -> bool:
            """Deny retention once the read is active.

            Args:
                lease: Issued transfer token.

            Returns:
                Whether retention is still available.
            """
            return lease in authority.leases and not entered.is_set()

        async def native(reader: Any, *arguments: Any) -> Any:
            """Keep native work active until source retention cancels it.

            Args:
                reader: Existing pixel reader.
                arguments: Original path and coordinates.

            Returns:
                No result because this read loses its lease.
            """
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                assert authority.leases
                stopped.set()

        monkeypatch.setattr(authority, "renew", renew)
        monkeypatch.setattr(
            "eolab_app.raster.pixel_service.read_private_raster", native
        )
        sources = RasterSourceAccess(CatalogAuthority(path), authority.files(0.02))
        with pytest.raises(SourceFileError, match="no longer available"):
            await asyncio.wait_for(
                RasterPixelService(sources, 1).get(
                    RasterPixelSourceRequest(source=PRIVATE, longitude=0, latitude=0),
                    "owner",
                ),
                10,
            )
        assert stopped.is_set() and not authority.leases

    asyncio.run(exercise())


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

        async def consume() -> None:
            """Hold the authorized file around a consumer's complete read."""
            async with files.open("owner", PRIVATE["jobId"], PRIVATE["artifactId"]):
                pytest.fail("The checksum fixture must not return a source")

        first, second = asyncio.create_task(consume()), asyncio.create_task(consume())
        await asyncio.wait_for(entered.wait(), 10)
        with pytest.raises(SourceFileError) as failure:
            await consume()
        assert failure.value.status == 429 and calls == 2
        first.cancel()
        second.cancel()
        await asyncio.gather(first, second, return_exceptions=True)
        assert not authority.leases

    asyncio.run(exercise())
