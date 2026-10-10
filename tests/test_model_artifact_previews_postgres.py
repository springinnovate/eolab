"""Private map previews through real Processing ownership, storage and HTTP boundaries."""

from collections.abc import Iterator
import hashlib
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient
import psycopg
import pytest

from eolab_app.rendering.artifact_preview import ArtifactPreviewService
from eolab_app.processing.source_access import create_model_source_files
from eolab_app.routes.processing import (
    COOKIE,
    create_processing_router,
    get_processing_session_owner_hash,
)
from eolab_app.routes.raster_analysis import create_raster_analysis_router
from eolab_app.raster.source_access import RasterSourceAccess
from eolab_app.raster.pixel_service import RasterPixelService
from eolab_app.raster.statistics_service import RasterStatisticsService
from test_model_runs_postgres import model_boundary, model_request, submit
from test_processing_jobs import boundary, store, HEADERS, AREA
from test_raster_clips import SOURCE


@pytest.fixture
def preview_boundary(model_boundary: Any) -> Iterator[Any]:
    """Compose the actual renderer over the existing file delivery authority.

    Args:
        model_boundary: Real model service, native worker and PostgreSQL store.

    Yields:
        Connected preview client, worker and service.
    """
    _, worker, service = model_boundary
    app = FastAPI()
    files = create_model_source_files(service)
    renderer = ArtifactPreviewService(files)
    sources = RasterSourceAccess(worker.authorizer, files)
    app.include_router(
        create_raster_analysis_router(
            RasterPixelService(sources, 2),
            RasterStatisticsService(sources, 2, 8),
            source_access=sources,
            session_owner=lambda request, response: get_processing_session_owner_hash(
                request, response, 7 * 86_400
            ),
        )
    )
    app.include_router(
        create_processing_router(service, preview_artifact=renderer.read)
    )
    with TestClient(app, base_url="https://testserver") as client:
        yield client, worker, service


@pytest.mark.parametrize("terminal", ["delete", "expire"])
def test_private_preview_and_download_lifetimes(
    preview_boundary: Any, store: Any, terminal: str
) -> None:
    """Authorize preview and masked statistics only while the owned run is available.

    Args:
        preview_boundary: Actual HTTP, rendering, worker and store composition.
        store: Disposable PostgreSQL authority.
        terminal: Explicit deletion or expiry after preview and statistics succeed.
    """

    client, worker, service = preview_boundary
    request = model_request(
        client,
        "raster-clip",
        inputs={
            "raster": SOURCE,
            "area": {"kind": "selectedArea", "selectedBounds": AREA},
        },
    )
    job = submit(client, request)
    base = f"/api/processing/jobs/{job['jobId']}"
    assert client.portal.call(worker.run_once)
    ready = client.get(base).json()
    file = next(
        file
        for file in ready["artifacts"]["files"]
        if file["mediaType"] == "image/tiff"
    )
    url = file["url"] + "/preview"
    response = client.get(url)
    assert response.status_code == 200, response.text
    preview = response.json()
    assert (
        preview["jobId"] == job["jobId"] and preview["artifactId"] == file["artifactId"]
    )
    assert preview["sha256"] == file["sha256"]
    assert len(preview["values"]) <= 512 * 512
    assert "no-store" in response.headers["cache-control"]
    assert str(worker.artifacts.root) not in response.text
    reference = {
        "kind": "runArtifact",
        "jobId": job["jobId"],
        "artifactId": file["artifactId"],
    }
    pixel_request = {"source": reference, "longitude": 0.5, "latitude": 9.5}
    pixel = client.post(
        "/api/raster-analysis/pixels", json=pixel_request, headers=HEADERS
    )
    assert pixel.status_code == 200, pixel.text
    assert pixel.json()["inBounds"] and pixel.json()["value"] is not None
    assert "no-store" in pixel.headers["cache-control"]
    description = client.post(
        "/api/raster-analysis/sources", json={"source": reference}, headers=HEADERS
    )
    assert description.status_code == 200, description.text
    assert description.json()["version"] == file["sha256"]
    assert description.json()["capabilities"]["pixels"]["supported"]
    assert description.json()["capabilities"]["statistics"]["supported"]
    assert str(worker.artifacts.root) not in description.text
    statistics_request = {"source": reference}
    statistics = client.post(
        "/api/raster-analysis/statistics", json=statistics_request, headers=HEADERS
    )
    assert statistics.status_code == 200, statistics.text
    assert statistics.json()["validSampleCount"] == ready["result"]["validPixels"]
    assert "no-store" in statistics.headers["cache-control"]
    assert (
        client.post("/api/raster-analysis/pixels", json=pixel_request).status_code
        == 403
    )
    assert (
        client.post(
            "/api/raster-analysis/pixels",
            json=pixel_request,
            headers={**HEADERS, "Origin": "https://foreign.test"},
        ).status_code
        == 403
    )
    with TestClient(client.app, base_url="https://testserver") as foreign:
        denied = foreign.get(url)
        assert denied.status_code == 404
        assert denied.json()["detail"]["code"] == "job_not_found"
        assert "no-store" in denied.headers["cache-control"]
        denied_pixel = foreign.post(
            "/api/raster-analysis/pixels", json=pixel_request, headers=HEADERS
        )
        assert denied_pixel.status_code == 404
        assert "no-store" in denied_pixel.headers["cache-control"]
        assert (
            foreign.post(
                "/api/raster-analysis/statistics",
                json=statistics_request,
                headers=HEADERS,
            ).status_code
            == 404
        )
    assert client.get(base + "/artifacts/" + "0" * 32 + "/preview").status_code == 404
    provenance = next(
        file for file in ready["artifacts"]["files"] if file["role"] == "provenance"
    )
    assert client.get(provenance["url"] + "/preview").status_code == 422
    assert client.get(file["url"]).status_code == 200
    if terminal == "delete":
        assert client.delete(base, headers=HEADERS).status_code == 200
    else:
        with psycopg.connect(store.conninfo) as connection:
            connection.execute(
                "UPDATE processing.jobs SET expires_at=now()-interval '1 second' WHERE id=%s",
                (job["jobId"],),
            )
    assert client.get(url).status_code == 409
    assert (
        client.post(
            "/api/raster-analysis/statistics", json=statistics_request, headers=HEADERS
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/raster-analysis/pixels", json=pixel_request, headers=HEADERS
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/raster-analysis/sources", json={"source": reference}, headers=HEADERS
        ).status_code
        == 409
    )
    with psycopg.connect(store.conninfo) as connection:
        assert (
            connection.execute("SELECT count(*) FROM processing.transfers").fetchone()[
                0
            ]
            == 0
        )


def test_preview_rejects_same_size_storage_change(
    preview_boundary: Any, store: Any
) -> None:
    """A changed GeoTIFF cannot be displayed under the run's original checksum.

    Args:
        preview_boundary: Actual delivery and rendering boundary.
        store: Disposable PostgreSQL ownership and lifecycle authority.
    """
    client, worker, service = preview_boundary
    job = submit(
        client,
        model_request(
            client,
            "raster-clip",
            inputs={
                "raster": SOURCE,
                "area": {"kind": "selectedArea", "selectedBounds": AREA},
            },
        ),
    )
    assert client.portal.call(worker.run_once)
    ready = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    file = next(
        file
        for file in ready["artifacts"]["files"]
        if file["mediaType"] == "image/tiff"
    )
    owner = hashlib.sha256(client.cookies.get(COOKIE).encode()).hexdigest()
    source = client.portal.call(
        service.download_model_artifact, owner, job["jobId"], file["artifactId"]
    )
    with source.path.open("r+b") as output:
        output.seek(-1, 2)
        previous = output.read(1)
        output.seek(-1, 2)
        output.write(bytes([previous[0] ^ 1]))
    client.portal.call(service.transfer_heartbeat, source.lease_id, True)
    response = client.get(file["url"] + "/preview")
    assert response.status_code == 422 and "changed" in response.text
    pixel = client.post(
        "/api/raster-analysis/pixels",
        json={
            "source": {
                "kind": "runArtifact",
                "jobId": job["jobId"],
                "artifactId": file["artifactId"],
            },
            "longitude": 0.5,
            "latitude": 9.5,
        },
        headers=HEADERS,
    )
    assert pixel.status_code == 422 and "changed" in pixel.text
    with psycopg.connect(store.conninfo) as connection:
        assert (
            connection.execute("SELECT count(*) FROM processing.transfers").fetchone()[
                0
            ]
            == 0
        )
