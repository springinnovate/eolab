"""Verify aligned-band reuse across independently admitted and owned model runs."""

from io import BytesIO
import hashlib
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from uuid import uuid4
from zipfile import ZipFile

from fastapi.testclient import TestClient
import numpy as np
import rasterio
from rasterio.io import MemoryFile
from rasterio.transform import from_origin
from rasterio.warp import transform_bounds, transform_geom
from shapely.geometry import box, mapping

from eolab_app.processing.habitat_raster_cache import HabitatInputCacheCleanup
from eolab_app.processing.model_definitions import ModelDefinition, ModelRegistry
from eolab_app.processing.native_processes import create_native_process
from eolab_app.raster.models import AuthorizedRaster, CatalogRasterRequest
from eolab_app.raster.source_identity import RasterSourceIdentity
from test_habitat_model import habitat_definition
from test_model_runs_postgres import model_boundary, model_request, submit
from test_processing_jobs import HEADERS, boundary, store


def test_new_habitat_submissions_reuse_values_after_edits_and_retain_private_ownership(
    model_boundary: Any,
    habitat_definition: ModelDefinition,
    tmp_path: Path,
) -> None:
    """Compare duplicate, edited and restored real jobs to independent fresh calculations.

    Args:
        model_boundary: HTTP session, disposable PostgreSQL, worker and published files.
        habitat_definition: Installed Habitat interface with small scientific fitting blocks.
        tmp_path: Independent immutable input rasters and cache namespaces.
    """
    client, worker, service = model_boundary
    rows, cols = np.indices((32, 48))
    x = rows * 0.3 + cols * 0.07
    terrain = ((rows // 2 + cols // 2) % 3).astype("float32")
    observed = (
        1
        + 0.33 * x
        + 0.17 * terrain
        + 0.12 * np.sin(rows + cols)
        + 0.08 * (cols % 3) * (rows > 11)
    )
    secondary = 2 + 0.13 * x - 0.12 * terrain + 0.08 * np.cos(2 * rows + cols)
    climate = x.astype("float32")
    climate[22:, 32:] = np.nan
    terrain[22:, 32:] = np.nan
    observed[22:, 32:] = np.nan  # Only the secondary response has data here.
    fine_observed = observed.repeat(2, axis=0).repeat(2, axis=1)
    fine_observed += np.random.default_rng(8).normal(0, 0.3, size=fine_observed.shape)
    originals = {
        "climate": climate[::2, ::2],
        "terrain": terrain[::2, ::2],
        "observed": fine_observed,
        "secondary": secondary,
        "ref": rows < 12,
    }
    catalog = {}
    admitted = {}
    for number, (name, pixels) in enumerate(originals.items()):
        path = tmp_path / f"{name}.tif"
        spacing = {"climate": 1000, "terrain": 1000, "observed": 250}.get(name, 500)
        with rasterio.open(
            path,
            "w",
            driver="GTiff",
            count=1,
            width=pixels.shape[1],
            height=pixels.shape[0],
            crs="EPSG:6933",
            transform=from_origin(0, 16000, spacing, spacing),
            nodata=np.nan,
            dtype="float32",
        ) as out:
            out.write(pixels.astype("float32"), 1)
        item = f"geotiff-{number:024x}"
        catalog[name] = {"collectionId": "eolab-mounted-geotiffs", "itemId": item}
        admitted[item] = AuthorizedRaster(path, RasterSourceIdentity.read(path))

    async def authorize(reference: CatalogRasterRequest) -> AuthorizedRaster:
        """Return an immutable fixture item during submission and execution.

        Args:
            reference: Catalog identifier from the public model request.

        Returns:
            Its admitted source path and identity.
        """
        return admitted[reference.item_id]

    service.model_authorizer = worker.authorizer = SimpleNamespace(authorize=authorize)
    worker.native = create_native_process(worker.limits)
    try:
        parent = submit(
            client,
            model_request(
                client,
                "raster-clip",
                inputs={
                    "raster": catalog["climate"],
                    "area": {
                        "kind": "selectedArea",
                        "selectedBounds": dict(
                            zip(
                                ("west", "south", "east", "north"),
                                transform_bounds(
                                    "EPSG:6933", "EPSG:4326", 1, 1, 23999, 15999
                                ),
                                strict=True,
                            )
                        ),
                    },
                },
            ),
        )
        assert client.portal.call(worker.run_once)
        parent_url = f"/api/processing/jobs/{parent['jobId']}"
        published = client.get(parent_url).json()
        assert published["status"] == "ready", published["error"]
        file = next(
            f for f in published["artifacts"]["files"] if f["mediaType"] == "image/tiff"
        )
        private = {
            "kind": "runArtifact",
            "jobId": parent["jobId"],
            "artifactId": file["artifactId"],
        }
        service.model_registry = ModelRegistry((habitat_definition,))
        shared = tmp_path / "reuse"
        bounds = transform_bounds("EPSG:6933", "EPSG:4326", 505, 5, 23495, 15495)
        ids = set()
        sites = []
        for north in (16000, 15000):
            geometry = transform_geom(
                "EPSG:6933", "EPSG:4326", mapping(box(0, north - 6000, 24000, north))
            )
            uploaded = client.post(
                "/api/processing/polygon-areas",
                headers=HEADERS,
                json={"polygons": [geometry]},
            )
            assert uploaded.status_code == 200, uploaded.text
            sites.append(
                {"kind": "polygonArea", "reference": uploaded.json()["polygonArea"]}
            )

        def request(selected: bool, shifted: bool, cropped: bool) -> dict[str, Any]:
            """Bind a newly identified model request with the given user edits.

            Args:
                selected: Include the categorical predictor and sparse secondary response.
                shifted: Move the reference polygon one kilometre south.
                cropped: Choose a smaller overlapping assessment area.

            Returns:
                A valid model submission using this browser's authorized sources.
            """
            predictors = [{"name": "climate", "source": private}]
            responses = [{"name": "observed", "source": catalog["observed"]}]
            methods = {"predictor_0": "bilinear", "response_0": "cubic"}
            if selected:
                predictors.append({"name": "terrain", "source": catalog["terrain"]})
                responses.insert(
                    0, {"name": "secondary", "source": catalog["secondary"]}
                )
                methods.update(
                    predictor_1="nearest", response_0="nearest", response_1="cubic"
                )
            area = (
                {
                    "kind": "selectedArea",
                    "selectedBounds": dict(
                        zip(("west", "south", "east", "north"), bounds, strict=True)
                    ),
                }
                if cropped
                else {"kind": "wholeRaster"}
            )
            return model_request(
                client,
                "habitat-condition",
                inputs={
                    "stack": {
                        "predictors": predictors,
                        "responses": responses,
                        "categoricalPredictor": "terrain" if selected else None,
                    },
                    "area": area,
                    "references": sites[int(shifted)],
                    "habitat_mask": None,
                    "preparation": {"resampling": methods},
                },
            )

        def execute(
            body: dict[str, Any], cache: Path | None
        ) -> tuple[dict[str, tuple[Any, ...]], int]:
            """Execute a new HTTP submission and fingerprint its score and diagnostics.

            Args:
                body: Public request carrying this run's polygon and variable choices.
                cache: Shared or fresh alignment cache, or None to read the full GDAL warp directly.

            Returns:
                Metadata, value and mask fingerprints for all five rasters and
                the score count returned to the browser.
            """
            worker.operation_settings = (
                {"habitat.condition.v1": cache / "habitat-cache"}
                if cache is not None
                else {}
            )
            job = submit(client, {**body, "requestId": uuid4().hex})
            assert job["jobId"] not in ids
            ids.add(job["jobId"])
            assert client.portal.call(worker.run_once)
            ready = client.get(f"/api/processing/jobs/{job['jobId']}").json()
            assert ready["status"] == "ready", ready["error"]
            downloads = {
                f["name"]: client.get(f["url"]) for f in ready["artifacts"]["files"]
            }
            assert all(response.status_code == 200 for response in downloads.values())
            response_names = downloads["provenance"].json()["variables"]["responses"]
            assert response_names == [
                r["name"] for r in body["inputs"]["stack"]["responses"]
            ]
            contents = {"score": downloads["reference_similarity"].content}
            with ZipFile(BytesIO(downloads["diagnostics"].content)) as archive:
                contents.update((n, archive.read(n)) for n in archive.namelist())
            assert len(contents) == 5
            outputs = {}
            for name, data in contents.items():
                with MemoryFile(data) as memory, memory.open() as raster:
                    row, column = raster.index(20100, 2100)
                    if name == "inference_status.tif":
                        # Only the secondary response has data here. The pixel is
                        # inside the AOI but outside the default predictor target.
                        assert raster.read(1)[row, column] == 0
                    if name == "score":
                        assert raster.read_masks(1)[row, column] == 0
                    outputs[name] = (
                        raster.crs,
                        raster.transform,
                        raster.shape,
                        raster.dtypes,
                        raster.descriptions,
                        hashlib.sha256(raster.read().tobytes()).digest(),
                        hashlib.sha256(raster.read_masks().tobytes()).digest(),
                    )
            return outputs, ready["result"]["validPixels"]

        first = execute(request(True, False, False), shared)
        assert first[1] > 0
        uncached = execute(request(True, False, False), None)
        differences = [
            name for name, result in first[0].items() if result != uncached[0][name]
        ]
        assert differences == []
        assert first[1] == uncached[1]
        private_scope = (
            shared / "habitat-aligned" / "runs" / parent["jobId"] / file["artifactId"]
        )
        original_tiles = {f: f.stat().st_ino for f in private_scope.rglob("*.tif")}
        assert original_tiles
        assert execute(request(True, False, False), shared) == first
        for index, (selected, shifted, cropped) in enumerate(
            ((True, True, False), (True, False, True), (False, False, False))
        ):
            edited = request(selected, shifted, cropped)
            changed = execute(edited, shared)
            assert changed == execute(edited, tmp_path / f"fresh-{index}")
            assert changed != first
        assert execute(request(True, False, False), shared) == first
        assert all(f.stat().st_ino == inode for f, inode in original_tiles.items())
        stolen = request(True, False, False)
        # Use a public raster reference to isolate the private predictor authorization.
        stolen["inputs"]["references"] = {"kind": "raster", "source": catalog["ref"]}
        stolen["inputs"]["preparation"]["resampling"]["reference_mask"] = "nearest"
        with TestClient(client.app, base_url="https://testserver") as other:
            denied = other.post(
                "/api/processing/model-runs", json=stolen, headers=HEADERS
            )
            assert denied.status_code in {404, 409}, denied.text
        assert client.delete(parent_url, headers=HEADERS).status_code in {200, 202}
        denied = client.post(
            "/api/processing/model-runs",
            json=request(True, False, False),
            headers=HEADERS,
        )
        assert denied.status_code in {404, 409}, denied.text
        HabitatInputCacheCleanup(
            shared / "habitat-aligned",
            86400,
            lambda _: True,
            lambda run: service.jobs.available_result(run) is not None,
        )()
        assert not private_scope.exists()
    finally:
        client.portal.call(worker.native.close)
