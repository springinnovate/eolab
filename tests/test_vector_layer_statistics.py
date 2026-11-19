"""Verify complete-layer benchmarks through the native and HTTP boundaries."""

import asyncio
from dataclasses import dataclass
from pathlib import Path
from threading import Event

import fiona
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from catalog_selection_support import FixtureCatalog
from eolab_app.catalog_selection import ResolvedCatalogSelection
from eolab_app.routes.vector_sampling import create_vector_sampling_router
from eolab_app.routes.vector_uploads import create_vector_uploads_router
from eolab_app.source_files import (
    LeasedSourceFiles,
    ResolvedSourceFile,
    SourceFileError,
)
from eolab_app.vector import sampling
from eolab_app.vector.field_statistics import (
    VectorFieldStatistics,
    VectorLayerStatisticsRequest,
)
from eolab_app.vector.models import ResolvedVectorSource
from eolab_app.vector.sampling import VectorSamplingService
from eolab_app.vector_uploads import VectorUploadStore
from tests.test_vector_uploads import HEADERS, write_layer


@dataclass(frozen=True)
class _LeasedVectorFile(ResolvedSourceFile):
    """Published vector file with the lease token protecting a native read."""

    lease_id: str


@pytest.fixture
def catalog(tmp_path: Path) -> FixtureCatalog:
    """Expose a real unfiltered layer with null, negative and very large readings.

    Args:
        tmp_path: Directory for the fixture GeoPackage.

    Returns:
        Catalog identity and native source for the layer.
    """
    path = tmp_path / "watersheds.gpkg"
    with fiona.open(
        path,
        "w",
        driver="GPKG",
        layer="watersheds",
        crs="EPSG:4326",
        schema={
            "geometry": "Point",
            "properties": {
                "Total ES": "float",
                "empty": "float",
                "cancel": "float",
                "large": "float",
            },
        },
    ) as layer:
        layer.writerecords(
            {
                "geometry": {"type": "Point", "coordinates": (index, 0)},
                "properties": {
                    "Total ES": total,
                    "empty": None,
                    "cancel": cancel,
                    "large": large,
                },
            }
            for index, (total, cancel, large) in enumerate(
                [
                    (70.0, 1e308, 1e308),
                    (10.0, 1.0, 1e308),
                    (None, -1e308, None),
                    (0.0, None, None),
                    (-30.0, None, None),
                    (float("inf"), None, None),
                ]
            )
        )
    return FixtureCatalog(
        ResolvedVectorSource("mounted", "geopackage", path, "data", "watersheds")
    )


def test_layer_statistics_read_all_original_features(catalog: FixtureCatalog) -> None:
    """Return finite-value statistics independently of GeoServer and chosen features.

    Args:
        catalog: Authoritative unfiltered watershed source.
    """
    app = FastAPI()
    app.include_router(
        create_vector_sampling_router(VectorSamplingService(catalog, catalog))
    )
    source = {
        "collectionId": "eolab-mounted-vectors",
        "itemId": "watersheds",
        "assetKey": "data",
        "layerName": "watersheds",
        "filter": {},
        "calculatedFields": [{"name": "Half ES", "expression": "'Total ES' / 2"}],
    }
    fields = ["Total ES", "Half ES", "empty", "cancel", "large"]
    with TestClient(app) as client:
        response = client.post(
            "/api/vector-sampling/layer-statistics",
            json={"source": source, "fields": fields},
        )
        filtered = client.post(
            "/api/vector-sampling/layer-statistics",
            json={
                "source": {
                    **source,
                    "filter": {
                        "rules": [{"field": "Total ES", "operator": "gt", "value": 50}]
                    },
                },
                "fields": fields,
            },
        )
        missing_identity = client.post(
            "/api/vector-sampling/layer-statistics",
            json={"source": {**source, "layerName": "another"}, "fields": fields},
        )

    assert response.status_code == 200, response.text
    assert response.headers["Cache-Control"] == "private, no-store"
    assert response.json() == [
        {"field": "Total ES", "count": 4, "mean": 12.5, "minimum": -30, "maximum": 70},
        {"field": "Half ES", "count": 4, "mean": 6.25, "minimum": -15, "maximum": 35},
        {"field": "empty", "count": 0, "mean": None, "minimum": None, "maximum": None},
        {
            "field": "cancel",
            "count": 3,
            "mean": 1 / 3,
            "minimum": -1e308,
            "maximum": 1e308,
        },
        {
            "field": "large",
            "count": 2,
            "mean": 1e308,
            "minimum": 1e308,
            "maximum": 1e308,
        },
    ]
    assert filtered.status_code == 422
    assert missing_identity.status_code == 409
    assert str(catalog.source.source_path) not in missing_identity.text


def test_layer_statistics_require_the_upload_owner(
    tmp_path: Path, catalog: FixtureCatalog
) -> None:
    """Read a private upload through its existing browser cookie contract.

    Args:
        tmp_path: Isolated vector upload directory.
        catalog: Configures the ordinary public source resolver.
    """
    uploads = VectorUploadStore(tmp_path / "uploads", max_bytes=None)
    app = FastAPI()
    app.include_router(create_vector_uploads_router(uploads))
    app.include_router(
        create_vector_sampling_router(
            VectorSamplingService(catalog, catalog, uploads=uploads)
        )
    )
    with TestClient(app, base_url="https://testserver") as owner:
        uploaded = owner.post(
            "/api/vector-uploads?name=Wetlands",
            headers={**HEADERS, "Content-Type": "application/geopackage+sqlite3"},
            content=write_layer(tmp_path / "wetlands.gpkg"),
        )
        assert uploaded.status_code == 201, uploaded.text
        query = {
            "source": {
                "uploadId": uploaded.json()["id"],
                "layerName": "areas",
                "filter": {},
            },
            "fields": ["weight"],
        }
        path = "/api/vector-sampling/layer-statistics"
        response = owner.post(path, json=query, headers=HEADERS)
        assert response.status_code == 200, response.text
        assert response.json() == [
            {"field": "weight", "count": 1, "mean": 2.5, "minimum": 2.5, "maximum": 2.5}
        ]
        assert owner.post(path, json=query).status_code == 403
        with TestClient(app, base_url="https://testserver") as stranger:
            assert stranger.post(path, json=query, headers=HEADERS).status_code == 404


def test_cancelled_result_read_retains_lease_until_native_exit(
    catalog: FixtureCatalog, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Reauthorize an owned result and retain its lease through cancellation.

    Args:
        catalog: Supplies the original GeoPackage for the published result.
        monkeypatch: Suspend the native reader to model cancellation during a read.
    """
    reading = Event()
    stopped = Event()
    allow_exit = Event()
    released: list[str] = []

    async def acquire(owner: str, job_id: str, artifact_id: str) -> _LeasedVectorFile:
        """Return the original result only to its owner."""
        if (owner, job_id, artifact_id) != ("owner", "a" * 32, "b" * 32):
            raise SourceFileError("This result is unavailable.", 404)
        path = catalog.source.source_path
        return _LeasedVectorFile(
            path=path,
            size=path.stat().st_size,
            sha256="c" * 64,
            media_type="application/geopackage+sqlite3",
            lease_id="lease",
        )

    async def release(lease_id: str) -> bool:
        """Observe release of the protected source."""
        released.append(lease_id)
        return True

    async def check(owner: str, job_id: str, artifact_id: str) -> None:
        """Check that the result is still owned by this browser."""
        await acquire(owner, job_id, artifact_id)

    async def renew(lease_id: str) -> bool:
        """Keep the lease valid until the test cancels the read."""
        return lease_id == "lease"

    def read(
        source: ResolvedCatalogSelection, fields: tuple[str, ...], stop: Event
    ) -> tuple[VectorFieldStatistics, ...]:
        """Wait for the cancellation signal and delay native exit briefly."""
        assert source.read_lease == "lease"
        assert fields == ("Total ES",)
        reading.set()
        assert stop.wait(5)
        stopped.set()
        assert allow_exit.wait(5)
        return ()

    files = LeasedSourceFiles(acquire, release, check, renew)
    service = VectorSamplingService(catalog, catalog, artifact_files=lambda: files)
    request = VectorLayerStatisticsRequest.model_validate(
        {
            "source": {
                "kind": "runArtifact",
                "jobId": "a" * 32,
                "artifactId": "b" * 32,
                "layerName": "watersheds",
                "filter": {},
            },
            "fields": ["Total ES"],
        }
    )
    monkeypatch.setattr(sampling, "read_vector_layer_statistics", read)

    async def cancel_read() -> None:
        """Check source ownership, then cancel an active original-source read."""
        with pytest.raises(SourceFileError, match="unavailable"):
            await service.layer_statistics(request, "another browser")
        assert not reading.is_set()
        task = asyncio.create_task(service.layer_statistics(request, "owner"))
        try:
            assert await asyncio.to_thread(reading.wait, 5)
            task.cancel()
            assert await asyncio.to_thread(stopped.wait, 5)
            assert not task.done()
            assert released == []
        finally:
            allow_exit.set()
            with pytest.raises(asyncio.CancelledError):
                await task

    asyncio.run(cancel_read())
    assert released == ["lease"]
