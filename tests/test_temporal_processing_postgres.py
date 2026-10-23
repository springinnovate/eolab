"""Run admitted temporal data through real Processing jobs and raster publication."""

import asyncio
from collections.abc import Iterator
from copy import deepcopy
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx2
import numpy
import pytest
from rasterio.io import MemoryFile
import zarr

from eolab_app.catalog.scanner import ScanManager
from eolab_app.processing.artifacts import LocalJobArtifacts
from eolab_app.processing.job_store import PostgresJobStore
from eolab_app.processing.model_run_contracts import RunDocument
from eolab_app.processing.model_yaml import parse_yaml
from eolab_app.processing.service import ProcessingService
from eolab_app.processing.worker import ProcessingWorker
from eolab_app.raster.catalog import StacRasterCatalog
from eolab_app.raster.source_authorization import CatalogRasterSourceAuthorizer
from eolab_app.raster.sources import MountedRasterResolver
from eolab_app.routes.processing import create_processing_router
from test_processing_jobs import HEADERS, store
from tests.test_catalog_temporal import (
    ITEM_KEY,
    PRECIPITATION,
    TEMPERATURE,
    create_scanner,
    era5_archive,
    scan,
)
from tests.test_temporal_source_access import populate_month

TemporalBoundary = tuple[
    TestClient, ProcessingWorker, ProcessingService, Path, ScanManager
]
BOUNDS = {"west": -0.3, "south": -0.1, "east": 0.3, "north": 0.1}


@pytest.fixture
def temporal_boundary(
    era5_archive: Path, store: PostgresJobStore
) -> Iterator[TemporalBoundary]:
    """Compose source admission, HTTP, PostgreSQL and native jobs without GeoServer.

    Args:
        era5_archive: Real SQLite catalog and partially populated monthly Zarr stores.
        store: Explicit disposable PostgreSQL database.

    Yields:
        Client, worker, service, archive and scanner for actual data/lifecycle tests.
    """
    populate_month(era5_archive, TEMPERATURE, (10, 20, 30))
    populate_month(era5_archive, PRECIPITATION, (1, 99, 3))
    array = zarr.open_array(era5_archive / "2000/02/era5.zarr" / TEMPERATURE, mode="r+")
    array[1, 360, 0] = numpy.nan
    array[:, 360, 1] = numpy.nan
    scanner, writer = create_scanner(era5_archive)
    assert asyncio.run(scan(scanner))["errors"] == []

    def catalog_response(request: httpx2.Request) -> httpx2.Response:
        """Serve the scanner's current authoritative Item at the catalog boundary.

        Args:
            request: Internal catalog GET request.

        Returns:
            The admitted item, or a missing-item response.
        """
        parts = request.url.path.split("/")
        item = writer.write_session.items.get((parts[-3], parts[-1]))
        return httpx2.Response(200, json=item) if item else httpx2.Response(404)

    catalog_client = httpx2.AsyncClient(
        transport=httpx2.MockTransport(catalog_response)
    )
    authorizer = CatalogRasterSourceAuthorizer(
        StacRasterCatalog(catalog_client, "http://catalog"),
        MountedRasterResolver(era5_archive.parent),
    )
    artifacts = LocalJobArtifacts(era5_archive.parent / "outputs", (era5_archive,))
    artifacts.initialize()
    service = ProcessingService(store, artifacts, model_authorizer=authorizer)
    worker = ProcessingWorker(authorizer, store, artifacts, store.limits)
    app = FastAPI()
    app.include_router(create_processing_router(service))
    try:
        with TestClient(app, base_url="https://testserver") as client:
            yield client, worker, service, era5_archive, scanner
    finally:
        asyncio.run(catalog_client.aclose())


def period_request(client: TestClient, variable: str = TEMPERATURE) -> dict[str, Any]:
    """Select two available observations using the discovered period-map recipe.

    Args:
        client: Current browser-session client.
        variable: Admitted variable requested for the same half-open period.

    Returns:
        Path-free submission selecting the three equatorial cells in BOUNDS.
    """
    models = client.get("/api/processing/models").json()["models"]
    definition = next(item for item in models if item["id"] == "temporal-period-map")
    return {
        "requestId": uuid4().hex,
        "model": {
            key: definition[key] for key in ("id", "version", "definitionSha256")
        },
        "inputs": {
            "source": {
                "collectionId": ITEM_KEY[0],
                "itemId": ITEM_KEY[1],
                "variable": variable,
                "startTime": "2000-02-01T00:00:00Z",
                "endTime": "2000-02-01T02:00:00Z",
            },
            "area": {"kind": "selectedArea", "selectedBounds": BOUNDS},
            "reduction": {"reducer": "mean"},
        },
        "parameters": {},
        "label": "February mean",
        "utcOffsetMinutes": 0,
    }


def submit_period(client: TestClient, request: dict[str, Any]) -> dict[str, Any]:
    """Submit a captured interval through the existing same-origin model endpoint.

    Args:
        client: Browser-session client owning the requested job.
        request: Validated recipe selection and calculation inputs.

    Returns:
        Accepted Processing job response.
    """
    response = client.post("/api/processing/model-runs", json=request, headers=HEADERS)
    assert response.status_code == 202, response.text
    return response.json()


def test_period_map_outputs_are_owned_reusable_rasters(
    temporal_boundary: TemporalBoundary, store: PostgresJobStore
) -> None:
    """Preserve real values, missing-data counts and source lineage through publication.

    Args:
        temporal_boundary: Actual temporal admission, HTTP and native worker.
        store: Disposable real database required by this integration suite.
    """
    client, worker, _, archive, _ = temporal_boundary
    request = period_request(client)
    job = submit_period(client, request)
    identifier = job["jobId"]
    pending = parse_yaml(
        client.get(f"/api/processing/jobs/{identifier}/run-yaml").content, run=True
    )
    assert pending["execution"]["sources"]["source"] == {
        "kind": "temporalInterval",
        "unit": "K",
        "timeSupport": "instantaneous",
    }
    assert submit_period(client, request)["jobId"] == identifier
    assert client.portal.call(worker.run_once)
    ready = client.get(f"/api/processing/jobs/{identifier}").json()
    assert ready["status"] == "ready", ready
    assert ready["result"]["temporalCoverage"] == {
        "unit": "K",
        "observationCount": 2,
        "firstObservation": "2000-02-01T00:00:00Z",
        "lastObservation": "2000-02-01T01:00:00Z",
    }
    rasters = {
        file["name"]: file
        for file in ready["artifacts"]["files"]
        if file["mediaType"] == "image/tiff"
    }
    assert set(rasters) == {"raster", "count"}
    for name, expected in (("raster", [[17, 10, numpy.nan]]), ("count", [[2, 1, 0]])):
        response = client.get(rasters[name]["url"])
        assert response.status_code == 200
        with MemoryFile(response.content) as memory, memory.open() as raster:
            assert raster.count == 1
            samples = [
                value[0] for value in raster.sample([(-0.25, 0), (0, 0), (0.25, 0)])
            ]
            numpy.testing.assert_allclose(samples, expected[0], equal_nan=True)
            assert numpy.count_nonzero(raster.read_masks(1)) == (
                2 if name == "raster" else 3
            )
            output_width = raster.width
    exported_response = client.get(f"/api/processing/jobs/{identifier}/run-yaml")
    exported = parse_yaml(exported_response.content, run=True)
    RunDocument.model_validate(exported)
    assert exported["invocation"] == pending["invocation"]
    assert exported["execution"]["state"] == "prepared"
    assert exported["execution"]["sources"]["source"]["grid"]["width"] == output_width
    assert "sourceSignature" not in exported_response.text
    assert str(archive) not in exported_response.text
    assert client.get(ready["result"]["provenanceUrl"]).status_code == 200
    with TestClient(client.app, base_url="https://testserver") as stranger:
        assert stranger.get(rasters["raster"]["url"]).status_code == 404
        assert stranger.get(f"/api/processing/jobs/{identifier}").status_code == 404
    # The ordinary raster-summary model reads the published file, not the archive.
    model = next(
        item
        for item in client.get("/api/processing/models").json()["models"]
        if item["id"] == "raster-summary"
    )
    child = submit_period(
        client,
        {
            "requestId": uuid4().hex,
            "model": {key: model[key] for key in ("id", "version", "definitionSha256")},
            "inputs": {
                "raster": {
                    "kind": "runArtifact",
                    "jobId": identifier,
                    "artifactId": rasters["raster"]["artifactId"],
                },
                "area": {"kind": "wholeRaster"},
            },
            "parameters": {"summary": "sum(a)"},
            "label": "Mean-map sum",
            "utcOffsetMinutes": 0,
        },
    )
    assert client.portal.call(worker.run_once)
    child = client.get(f"/api/processing/jobs/{child['jobId']}").json()
    assert child["status"] == "ready", child
    assert float(child["result"]["rows"][0]["value"]) == 27


def test_new_run_reads_refreshed_values_without_changing_completed_outputs(
    temporal_boundary: TemporalBoundary, store: PostgresJobStore
) -> None:
    """Read current source values after operator refresh while old results stay immutable.

    Args:
        temporal_boundary: Actual temporal admission, HTTP and native worker.
        store: Disposable real database required by this integration suite.
    """
    client, worker, _, archive, scanner = temporal_boundary
    request = period_request(client)
    first = submit_period(client, request)
    assert client.portal.call(worker.run_once)
    first = client.get(f"/api/processing/jobs/{first['jobId']}").json()
    assert first["status"] == "ready", first
    original = client.get(first["result"]["url"]).content
    array = zarr.open_array(archive / "2000/02/era5.zarr" / TEMPERATURE, mode="r+")
    array[:2, 360, 0] = [40, 60]
    for month in ("01", "02"):
        zarr.open_array(
            archive / f"2000/{month}/era5.zarr" / TEMPERATURE, mode="r+"
        ).attrs["units"] = "degC"
    assert client.portal.call(scan, scanner)["errors"] == []
    second_request = deepcopy(request)
    second_request["requestId"] = uuid4().hex
    second = submit_period(client, second_request)
    assert client.portal.call(worker.run_once)
    second = client.get(f"/api/processing/jobs/{second['jobId']}").json()
    assert second["status"] == "ready", second
    assert second["result"]["temporalCoverage"]["unit"] == "degC"
    with (
        MemoryFile(client.get(second["result"]["url"]).content) as memory,
        memory.open() as raster,
    ):
        assert next(raster.sample([(0, 0)]))[0] == 50
    assert client.get(first["result"]["url"]).content == original
    saved = client.get(f"/api/processing/jobs/{first['jobId']}").json()
    assert saved["result"]["temporalCoverage"] == first["result"]["temporalCoverage"]


def test_period_map_rejects_rate_variables_without_publishing(
    temporal_boundary: TemporalBoundary, store: PostgresJobStore
) -> None:
    """Fail unsupported interval-rate semantics explicitly without inventing a depth.

    Args:
        temporal_boundary: Actual temporal admission, HTTP and native worker.
        store: Disposable real database required by this integration suite.
    """
    client, worker, _, _, _ = temporal_boundary
    job = submit_period(client, period_request(client, PRECIPITATION))
    assert client.portal.call(worker.run_once)
    failed = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert failed["status"] == "failed", failed
    assert "instantaneous" in failed["error"]["detail"].lower()
    assert failed["result"] is None
    assert failed["artifacts"]["files"] == []


def test_precipitation_total_publishes_mm_and_preserves_input_units(
    temporal_boundary: TemporalBoundary, store: PostgresJobStore
) -> None:
    """Integrate cross-month hourly support, preserving gaps and native validity.

    Args:
        temporal_boundary: Real temporal source, HTTP service and native worker.
        store: Disposable PostgreSQL lifecycle storage.
    """
    client, worker, _, archive, _ = temporal_boundary
    array = zarr.open_array(archive / "2000/02/era5.zarr" / PRECIPITATION, mode="r+")
    array[0, 360, 0] = 0
    array[2, 360, 0] = numpy.nan
    array[:, 360, 1] = numpy.nan
    request = period_request(client, PRECIPITATION)
    request["inputs"]["source"]["startTime"] = "2000-01-31T23:00:00Z"
    request["inputs"]["reduction"] = {"reducer": "precipitation_total"}
    invalid = deepcopy(request)
    invalid["inputs"]["source"]["startTime"] = "2000-01-31T23:30:00Z"
    response = client.post("/api/processing/model-runs", json=invalid, headers=HEADERS)
    assert response.status_code == 400, response.text
    job = submit_period(client, request)
    assert client.portal.call(worker.run_once)
    ready = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert ready["status"] == "ready", ready
    assert ready["result"]["temporalCoverage"] == {
        "unit": "mm",
        "observationCount": 2,
        "firstObservation": "2000-02-01T00:00:00Z",
        "lastObservation": "2000-02-01T02:00:00Z",
    }
    rasters = {
        item["name"]: item
        for item in ready["artifacts"]["files"]
        if item["mediaType"] == "image/tiff"
    }
    assert set(rasters) == {"raster", "count"}
    for name, expected, unit in (
        ("raster", [8 * 3600, 0, numpy.nan], "mm"),
        ("count", [2, 1, 0], "observations"),
    ):
        with (
            MemoryFile(client.get(rasters[name]["url"]).content) as memory,
            memory.open() as raster,
        ):
            samples = [
                value[0] for value in raster.sample([(-0.25, 0), (0, 0), (0.25, 0)])
            ]
            numpy.testing.assert_allclose(samples, expected, equal_nan=True)
            assert raster.units == (unit,)
    exported = parse_yaml(
        client.get(f"/api/processing/jobs/{job['jobId']}/run-yaml").content, run=True
    )
    assert exported["invocation"]["inputs"] == request["inputs"]
    assert exported["execution"]["sources"]["source"]["unit"] == "kg m**-2 s**-1"
    policy = exported["execution"]["numericalPolicy"]
    assert policy["timeSupport"] == "mean_rate"
    assert policy["weighting"] == "interval_duration"
    assert policy["unit"] == "mm"
    provenance = client.get(ready["result"]["provenanceUrl"]).json()
    assert provenance["inputUnit"] == "kg m**-2 s**-1"
    assert provenance["availableDurationSeconds"] == 7200
    assert [item["time"] for item in provenance["observations"]] == [
        "2000-02-01T00:00:00+00:00",
        "2000-02-01T02:00:00+00:00",
    ]


@pytest.mark.parametrize(
    "variable,unit", [(TEMPERATURE, None), (PRECIPITATION, "m s**-1")]
)
def test_precipitation_total_rejects_unsupported_source_metadata(
    temporal_boundary: TemporalBoundary,
    store: PostgresJobStore,
    variable: str,
    unit: str | None,
) -> None:
    """Require a mean rate in the supported units before creating output files.

    Args:
        temporal_boundary: Real source metadata, HTTP and native worker.
        store: Disposable PostgreSQL lifecycle storage.
        variable: Instantaneous or rate source to submit as precipitation.
        unit: Unsupported units to publish before admission, when supplied.
    """
    client, worker, _, archive, scanner = temporal_boundary
    if unit is not None:
        for month in ("01", "02"):
            zarr.open_array(
                archive / f"2000/{month}/era5.zarr" / variable, mode="r+"
            ).attrs["units"] = unit
        assert client.portal.call(scan, scanner)["errors"] == []
    request = period_request(client, variable)
    request["inputs"]["reduction"] = {"reducer": "precipitation_total"}
    job = submit_period(client, request)
    assert client.portal.call(worker.run_once)
    failed = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert failed["status"] == "failed", failed
    assert failed["error"]["code"] == "unsupported_precipitation_source"
    assert failed["result"] is None and failed["artifacts"]["files"] == []
