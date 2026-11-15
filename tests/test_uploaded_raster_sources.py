"""Exercise private raster uploads through the ordinary source and rendering boundaries."""

import asyncio
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import hashlib
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx2
import pytest

from eolab_app.raster.geoserver import GeoServerRasterPublisher
from eolab_app.raster.models import (
    CatalogPixelRequest,
    CatalogRasterStatisticsRequest,
    CatalogRasterPairRequest,
)
from eolab_app.raster.pixel_service import RasterPixelService
from eolab_app.raster.publication import (
    RasterPublicationService,
    uploaded_raster_source,
)
from eolab_app.raster.source_access import RasterSourceAccess
from eolab_app.raster.source_models import (
    UploadedRasterReference,
    RasterPixelSourceRequest,
    RasterStatisticsSourceRequest,
    RasterPairSourceRequest,
    RasterSourceRequest,
)
from eolab_app.raster.sources import PublishedRasterRegistry
from eolab_app.raster.statistics_service import RasterStatisticsService
from eolab_app.routes.browser_identity import COOKIE
from eolab_app.routes.raster_analysis import create_raster_analysis_router
from eolab_app.source_files import SourceFileError
from eolab_app.upload_storage import UploadKind, UploadRecord, UploadStorage
from test_raster_source_access import CATALOG, CatalogAuthority, write_source
from test_temporary_raster_publication import OutputGeoServer

TOKEN = "c" * 64
OWNER = hashlib.sha256(TOKEN.encode()).hexdigest()


async def store_raster(storage: UploadStorage, source: Path) -> UploadRecord:
    """Publish a fixture original through the actual shared upload lifecycle.

    Args:
        storage: Isolated initialized upload volume.
        source: Complete native fixture already validated by its producer.

    Returns:
        The admitted opaque upload record.
    """

    async def chunks() -> AsyncIterator[bytes]:
        """Yield the original fixture as a streamed upload body.

        Yields:
            Complete bytes from the already-closed raster fixture.
        """
        yield source.read_bytes()

    async with storage.stage(OWNER, "raster", chunks()) as pending:
        record = UploadRecord(
            id=uuid4(),
            kind="raster",
            name="Reference sites",
            size_bytes=pending.size_bytes,
            created_at=datetime.now(timezone.utc),
        )
        storage.publish(pending, record)
        return record


def test_uploaded_raster_uses_original_pixel_and_statistics_readers(
    tmp_path: Path,
) -> None:
    """Read equivalent catalog/upload values without map or GeoServer services.

    Args:
        tmp_path: Isolated original and upload files.
    """
    path = write_source(tmp_path / "original.tif")
    uploads = UploadStorage(tmp_path / "uploads")
    uploads.initialize()
    sources = RasterSourceAccess(CatalogAuthority(path), uploads=uploads)
    pixels = RasterPixelService(sources, 2)
    statistics = RasterStatisticsService(sources, 2, 8)

    async def exercise() -> None:
        """Compare source-backed numerical results and reject another browser."""
        record = await store_raster(uploads, path)
        reference = UploadedRasterReference(kind="uploadedRaster", uploadId=record.id)
        location = {"longitude": -0.5, "latitude": 0.5}
        actual = await pixels.get(
            RasterPixelSourceRequest(source=reference, **location), upload_owner=OWNER
        )
        expected = await pixels.get(CatalogPixelRequest(**CATALOG, **location))
        assert actual == expected and actual.value == 5
        request = RasterStatisticsSourceRequest(source=reference)
        actual_stats = await statistics.get(request, upload_owner=OWNER)
        expected_stats = await statistics.get(CatalogRasterStatisticsRequest(**CATALOG))
        assert actual_stats == expected_stats
        paired = await statistics.get_paired(
            RasterPairSourceRequest(xRaster=reference, yRaster=CATALOG),
            upload_owner=OWNER,
        )
        expected_pair = await statistics.get_paired(
            CatalogRasterPairRequest(xRaster=CATALOG, yRaster=CATALOG)
        )
        assert paired == expected_pair
        with pytest.raises(SourceFileError):
            await statistics.get(request, owner=OWNER, upload_owner="b" * 64)
        with pytest.raises(SourceFileError):
            await sources.resolve(reference, OWNER)
        metadata = await sources.describe(reference, upload_owner=OWNER)
        assert metadata["source"] == reference.model_dump(by_alias=True)
        assert metadata["version"] == str(record.id)

    asyncio.run(exercise())


def test_open_raster_retains_read_until_deletion_scope_ends(tmp_path: Path) -> None:
    """Deletion stops new access while an existing source read keeps its original.

    Args:
        tmp_path: Isolated original and upload files.
    """
    path = write_source(tmp_path / "original.tif")
    uploads = UploadStorage(tmp_path / "uploads")
    uploads.initialize()
    sources = RasterSourceAccess(CatalogAuthority(path), uploads=uploads)

    async def exercise() -> None:
        """Delete during the shared reading scope and inspect the retained bytes."""
        record = await store_raster(uploads, path)
        reference = UploadedRasterReference(kind="uploadedRaster", uploadId=record.id)
        async with sources.open(reference, upload_owner=OWNER) as source:
            uploads.delete(OWNER, record.id)
            assert source.data.read_bytes() == path.read_bytes()
            assert uploads.summary(OWNER).retained_files == 1
            with pytest.raises(SourceFileError):
                await sources.resolve(reference, upload_owner=OWNER)
        assert not source.data.exists()
        assert uploads.summary(OWNER).used_files == 0

    asyncio.run(exercise())


@pytest.mark.parametrize("paired", [False, True])
def test_shared_statistics_survive_first_waiter_cancellation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, paired: bool
) -> None:
    """Keep a coalesced read's original path until its final waiter finishes.

    Args:
        tmp_path: Isolated original and upload files.
        monkeypatch: Control native-reader scheduling without changing source access.
        paired: Whether the two coalesced requests compare a raster pair.
    """
    path = write_source(tmp_path / "original.tif")
    uploads = UploadStorage(tmp_path / "uploads")
    uploads.initialize()
    sources = RasterSourceAccess(CatalogAuthority(path), uploads=uploads)
    statistics = RasterStatisticsService(sources, 1, 8)

    async def exercise() -> None:
        """Delete and cancel while another caller still awaits the same native read."""
        record = await store_raster(uploads, path)
        reference = UploadedRasterReference(kind="uploadedRaster", uploadId=record.id)
        started, release, scopes_joined = (
            asyncio.Event(),
            asyncio.Event(),
            asyncio.Event(),
        )
        scopes = 0
        reads = 0
        original_open = uploads.open_source

        @asynccontextmanager
        async def observed_open(
            owner: str, identifier: UUID, kind: UploadKind
        ) -> AsyncIterator[tuple[UploadRecord, Path]]:
            """Signal when both requests have acquired their real source scopes.

            Args:
                owner: Browser identity from the existing authorization boundary.
                identifier: Opaque upload ID.
                kind: Existing source family.

            Yields:
                The unmodified common storage read scope.
            """
            nonlocal scopes
            async with original_open(owner, identifier, kind) as original:
                scopes += 1
                if scopes == (4 if paired else 2):
                    scopes_joined.set()
                yield original

        async def delayed_native(reader: Callable[..., Any], *arguments: Any) -> Any:
            """Pause before the actual native reader opens its captured original path.

            Args:
                reader: Existing numerical reader selected by statistics.
                arguments: Its unchanged original paths and sampling policy.

            Returns:
                The existing reader's numerical result.
            """
            nonlocal reads
            reads += 1
            started.set()
            await release.wait()
            return await asyncio.to_thread(reader, *arguments)

        monkeypatch.setattr(uploads, "open_source", observed_open)
        monkeypatch.setattr(
            "eolab_app.raster.statistics_service.read_private_raster", delayed_native
        )

        async def read() -> object:
            """Request the ordinary single-raster or paired analysis contract.

            Returns:
                The numerical summary shared by both requesting tasks.
            """
            if paired:
                return await statistics.get_paired(
                    RasterPairSourceRequest(xRaster=reference, yRaster=reference),
                    upload_owner=OWNER,
                )
            return await statistics.get(
                RasterStatisticsSourceRequest(source=reference), upload_owner=OWNER
            )

        first = asyncio.create_task(read())
        await asyncio.wait_for(started.wait(), 3)
        second = asyncio.create_task(read())
        await asyncio.wait_for(scopes_joined.wait(), 3)
        uploads.delete(OWNER, record.id)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        release.set()
        assert await asyncio.wait_for(second, 3) is not None
        assert reads == 1
        assert uploads.summary(OWNER).used_files == 0

    asyncio.run(exercise())


def test_uploaded_raster_http_uses_upload_cookie_without_processing_session(
    tmp_path: Path,
) -> None:
    """The existing analysis endpoints authorize the upload browser independently.

    Args:
        tmp_path: Isolated original and upload files.
    """
    path = write_source(tmp_path / "original.tif")
    uploads = UploadStorage(tmp_path / "uploads")
    uploads.initialize()
    record = asyncio.run(store_raster(uploads, path))
    sources = RasterSourceAccess(CatalogAuthority(path), uploads=uploads)
    app = FastAPI()
    app.include_router(
        create_raster_analysis_router(
            RasterPixelService(sources, 2),
            RasterStatisticsService(sources, 2, 8),
            source_access=sources,
        )
    )
    body = {
        "source": {"kind": "uploadedRaster", "uploadId": str(record.id)},
        "longitude": -0.5,
        "latitude": 0.5,
    }
    headers = {"X-EOLab-Uploads": "1"}
    with TestClient(app, base_url="https://testserver") as client:
        client.cookies.set(COOKIE, TOKEN)
        response = client.post(
            "/api/raster-analysis/pixels", json=body, headers=headers
        )
        assert response.status_code == 200, response.text
        assert response.json()["value"] == 5
        assert response.headers["Cache-Control"] == "private, no-store"
        client.cookies.clear()
        assert (
            client.post(
                "/api/raster-analysis/pixels", json=body, headers=headers
            ).status_code
            == 404
        )


def test_uploaded_raster_uses_normal_publication_and_cleanup(tmp_path: Path) -> None:
    """GeoServer publication remains private and is reclaimed after upload deletion.

    Args:
        tmp_path: Isolated original and upload files.
    """
    path = write_source(tmp_path / "original.tif")
    uploads = UploadStorage(tmp_path / "uploads")
    uploads.initialize()
    sources = RasterSourceAccess(CatalogAuthority(path), uploads=uploads)
    upstream = OutputGeoServer()
    registry = PublishedRasterRegistry()

    async def available(identifier: UUID) -> bool:
        """Check only upload lifetime for publication cleanup.

        Args:
            identifier: Server-generated upload ID.

        Returns:
            Whether the original still permits new access.
        """
        return uploads.is_available(identifier, "raster")

    async def exercise() -> None:
        """Use real GeoServer REST requests with the external server simulated."""
        record = await store_raster(uploads, path)
        reference = UploadedRasterReference(kind="uploadedRaster", uploadId=record.id)
        async with httpx2.AsyncClient(
            transport=httpx2.MockTransport(upstream)
        ) as client:
            publication = RasterPublicationService(
                None,
                None,
                GeoServerRasterPublisher(client, "http://geoserver/geoserver"),
                registry,
                source_access=sources,
                upload_available=available,
            )
            result = await publication.publish(
                RasterSourceRequest(source=reference), upload_owner=OWNER
            )
            assert uploaded_raster_source(result.layer_name) == reference
            assert await publication.authorize_layers((result.layer_name,), None, OWNER)
            with pytest.raises(SourceFileError):
                await publication.authorize_layers((result.layer_name,), None, "b" * 64)
            assert any(
                request.method == "PUT"
                and request.url.path.endswith("/external.geotiff")
                for request in upstream.requests
            )
            uploads.delete(OWNER, record.id)
            with pytest.raises(SourceFileError):
                await publication.authorize_layers((result.layer_name,), None, OWNER)
            await publication.cleanup()
            assert upstream.names == set()

    asyncio.run(exercise())
