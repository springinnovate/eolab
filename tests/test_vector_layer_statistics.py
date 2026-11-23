"""Verify complete-layer benchmarks through the native and HTTP boundaries."""

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any, Never
from unittest.mock import Mock

import fiona
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from catalog_selection_support import FixtureCatalog
from eolab_app.attribute_filter import VectorFilter
from eolab_app.catalog_selection import CatalogSelection
from eolab_app.routes.vector_sampling import create_vector_sampling_router
from eolab_app.routes.vector_uploads import create_vector_uploads_router
from eolab_app.source_files import (
    LeasedSourceFiles,
    ResolvedSourceFile,
    SourceFileError,
)
from eolab_app.vector.field_statistics import (
    VectorFieldStatistics,
    VectorLayerStatisticsRequest,
    read_vector_layer_statistics,
)
from eolab_app.vector.field_statistics_jobs import LayerStatisticsJobs
from eolab_app.vector.models import ResolvedVectorSource
from eolab_app.vector.sampling import VectorSamplingService
from eolab_app.vector.selection_source import resolve_selection
from eolab_app.vector_uploads import VectorUploadStore
from eolab_jobs.client import JobsClient
from test_outline_jobs import outline_case
from tests.test_vector_uploads import HEADERS, write_layer


@dataclass(frozen=True)
class _LeasedVectorFile(ResolvedSourceFile):
    """Published vector file with the lease token protecting a native read."""

    lease_id: str


def native_fixture_executor(
    catalog: FixtureCatalog, uploads: VectorUploadStore | None = None
) -> Callable[
    [VectorLayerStatisticsRequest, str | None, str | None],
    Awaitable[tuple[VectorFieldStatistics, ...]],
]:
    """Read real Catalog or upload data in HTTP tests with a local Jobs substitute.

    Args:
        catalog: Authoritative fixture source, also used by the application.
        uploads: Private upload store when a fixture uses an upload.

    Returns:
        A coroutine that resolves the same original file and runs the native scan.
    """

    async def execute(
        request: VectorLayerStatisticsRequest,
        upload_owner: str | None,
        read_lease: str | None,
    ) -> tuple[VectorFieldStatistics, ...]:
        """Read the authorized native source and return full field summaries."""
        assert read_lease is None
        source = await resolve_selection(
            catalog, catalog, request.source, uploads, upload_owner
        )
        return read_vector_layer_statistics(source, request.fields)

    return execute


def test_registered_job_reads_every_feature(
    outline_case: tuple[CatalogSelection, dict[str, Any], str], tmp_path: Path
) -> None:
    """Measure whole-layer values through the real installed Jobs entry point.

    Args:
        outline_case: Real native polygons and HTTP Catalog authorization.
        tmp_path: Fixture source mount supplied to the child.
    """
    selection, _, url = outline_case
    whole_layer = selection.model_copy(update={"filter": VectorFilter()})
    command = (
        "from pathlib import Path; from eolab_app.vector import selection_operation as op; "
        f"op.CATALOG_URL={url!r}; op.SCAN_MOUNT=Path({str(tmp_path)!r}); "
        "from job_service.runner import main; main()"
    )
    result = subprocess.run(
        [sys.executable, "-c", command],
        cwd=Path(__file__).parents[1] / "services/jobs",
        input=json.dumps(
            {
                "operation": "vector.layer-statistics.v1",
                "inputs": {
                    "request": {
                        "source": whole_layer.model_dump(mode="json", by_alias=True),
                        "fields": ["selected"],
                    },
                },
            }
        ).encode(),
        env={**os.environ, "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"},
        capture_output=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr.decode()
    reply = json.loads(result.stdout)
    assert reply["ok"], reply
    assert reply["value"]["summaries"] == [
        {"field": "selected", "count": 2, "mean": 1.5, "minimum": 1, "maximum": 2}
    ]


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
        create_vector_sampling_router(
            VectorSamplingService(
                catalog,
                catalog,
                layer_statistics_executor=native_fixture_executor(catalog),
            )
        )
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
            VectorSamplingService(
                catalog,
                catalog,
                uploads=uploads,
                layer_statistics_executor=native_fixture_executor(catalog, uploads),
            )
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
    catalog: FixtureCatalog,
) -> None:
    """Reauthorize an owned result and retain its lease through cancellation.

    Args:
        catalog: Supplies the original GeoPackage for the published result.
    """
    reading = asyncio.Event()
    stopped = asyncio.Event()
    allow_exit = asyncio.Event()
    lease = "d" * 32
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
            lease_id=lease,
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
        return lease_id == lease

    async def run_job(
        submission: dict[str, Any],
        *,
        timeout_seconds: float,
        delete_on_completion: bool,
        require_terminal_cleanup: bool,
    ) -> Never:
        """Model a Jobs client awaiting native exit after cancellation."""
        assert submission["operation"] == "vector.layer-statistics.v1"
        assert submission["inputs"]["readLease"] == lease
        assert submission["inputs"]["request"]["fields"] == ["Total ES"]
        assert submission["executionTimeoutSeconds"] == 20
        assert submission["queueTimeoutSeconds"] == 30
        assert timeout_seconds == 60
        assert delete_on_completion and require_terminal_cleanup
        reading.set()
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            stopped.set()
            await allow_exit.wait()
            raise

    files = LeasedSourceFiles(acquire, release, check, renew)
    job_client = Mock(spec=JobsClient)
    job_client.run.side_effect = run_job
    service = VectorSamplingService(
        catalog,
        catalog,
        artifact_files=lambda: files,
        layer_statistics_executor=LayerStatisticsJobs(job_client),
    )
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

    async def cancel_read() -> None:
        """Check source ownership, then cancel an active original-source read."""
        with pytest.raises(SourceFileError, match="unavailable"):
            await service.layer_statistics(request, "another browser")
        assert not reading.is_set()
        task = asyncio.create_task(service.layer_statistics(request, "owner"))
        try:
            await asyncio.wait_for(reading.wait(), 5)
            task.cancel()
            await asyncio.wait_for(stopped.wait(), 5)
            assert not task.done()
            assert released == []
        finally:
            allow_exit.set()
            with pytest.raises(asyncio.CancelledError):
                await task

    asyncio.run(cancel_read())
    assert released == [lease]
