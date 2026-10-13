"""Current catalog hydrology sources and immutable historical Run YAML records."""

import asyncio
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import fiona
import numpy as np
import pytest
import rasterio
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from rasterio.transform import from_origin
from shapely.geometry import box, mapping

from catalog_selection_support import FixtureCatalog
from eolab_app.catalog_selection import (
    ResolvedCatalogSelection,
    SelectionUnavailableError,
)
from eolab_app.processing.prepared_hydrology import (
    HydrologyGrid,
    HydrologyRegistration,
    PreparedHydrologyDefinition,
    PreparedHydrologySnapshot,
)
from eolab_app.processing.model_yaml import (
    compute_document_checksum,
    export_yaml,
    parse_yaml,
)
from eolab_app.processing.model_definitions import ModelRegistry
from eolab_app.processing.model_run_contracts import ModelRunRequest
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.service import ProcessingService
from eolab_app.raster.errors import RasterNotFoundError
from eolab_app.raster.models import AuthorizedRaster, CatalogRasterRequest
from eolab_app.raster.source_identity import RasterSourceIdentity
from eolab_app.routes.processing import create_processing_router
from eolab_app.vector.filters import CatalogVectorFilterRequest, VectorFilter
from eolab_app.vector.models import ResolvedVectorSource
from eolab_app.vector.sampling import VectorSamplingService
from eolab_app.vector.selection_source import resolve_selection


def prepare_sources(
    directory: Path,
    *,
    records: list[dict[str, Any]] | None = None,
    dem_values: np.ndarray | None = None,
    crs: str | None = "EPSG:4326",
    definition_changes: dict[str, Any] | None = None,
) -> tuple[
    PreparedHydrologyDefinition,
    AuthorizedRaster,
    ResolvedCatalogSelection,
    VectorSamplingService,
]:
    """Write a three-partition eastward network and DEM through real source contracts.

    Args:
        directory: Isolated source directory.
        records: Optional replacement watershed IDs, links, sink IDs and geometries.
        dem_values: Optional raster data; negative 9999 is NoData.
        crs: DEM coordinate system, or None to exercise missing metadata.
        definition_changes: Optional configuration fields to replace.

    Returns:
        Definition, authorized DEM, resolved vector and production reauthorization service.
    """
    directory.mkdir(parents=True, exist_ok=True)
    dem_path = directory / "elevation.tif"
    with rasterio.open(
        dem_path,
        "w",
        driver="GTiff",
        width=6,
        height=4,
        count=1,
        dtype="float32",
        crs=crs,
        nodata=-9999,
        transform=from_origin(0, 4, 1, 1),
    ) as dataset:
        dataset.write(
            np.asarray(
                (
                    dem_values
                    if dem_values is not None
                    else np.tile([6, 5, 4, 3, 2, 1], (4, 1))
                ),
                dtype="float32",
            ),
            1,
        )
    vector_path = directory / "watersheds.gpkg"
    if records is None:
        records = [
            {
                "id": i,
                "next": i + 1 if i < 3 else 0,
                "sink": 3,
                "geometry": mapping(box((i - 1) * 2, 0, i * 2, 4)),
            }
            for i in range(1, 4)
        ]
    with fiona.open(
        vector_path,
        "w",
        driver="GPKG",
        layer="watersheds",
        crs="EPSG:4326",
        schema={
            "geometry": "Polygon",
            "properties": {"id": "int64", "next": "int64", "sink": "int64"},
        },
    ) as dataset:
        for record in records:
            dataset.write(
                {
                    "geometry": record["geometry"],
                    "properties": {key: record[key] for key in ("id", "next", "sink")},
                }
            )
    catalog = FixtureCatalog(
        ResolvedVectorSource("mounted", "geopackage", vector_path, "data", "watersheds")
    )
    resolved = asyncio.run(
        resolve_selection(
            catalog,
            catalog,
            CatalogVectorFilterRequest(
                collectionId="eolab-mounted-vectors",
                itemId="watersheds",
                filter=VectorFilter(),
            ),
        )
    )
    document = {
        "schema": "eolab.hydrology/v1",
        "id": "example-network",
        "version": "1.0.0",
        "title": "Small eastward drainage",
        "description": "Three connected watersheds over a sloping DEM.",
        "dem": {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-111111111111111111111111",
        },
        "watersheds": {
            "collectionId": "eolab-mounted-vectors",
            "itemId": "watersheds",
        },
        "topology": {
            "idField": "id",
            "downstreamField": "next",
            "idType": "integer",
            "terminal": {"field": "next", "value": 0},
            "terminalIdField": "sink",
        },
        "terrain": {
            "routing": "mfd",
            "elevationUnit": "metre",
            "conditioning": "Synthetic eastward slope without pits",
            "datasetVersion": "fixture-v1",
        },
    }
    definition = PreparedHydrologyDefinition.model_validate(
        {**document, **(definition_changes or {})}
    )
    return (
        definition,
        AuthorizedRaster(dem_path, RasterSourceIdentity.read(dem_path)),
        resolved,
        VectorSamplingService(catalog, catalog),
    )


def legacy_snapshot(
    definition: PreparedHydrologyDefinition,
    dem: AuthorizedRaster,
    watersheds: ResolvedCatalogSelection,
) -> PreparedHydrologySnapshot:
    """Construct a historical report fixture without production registration code.

    Args:
        definition: Old configuration document retained in a saved run.
        dem: Fixture elevation source.
        watersheds: Fixture catalog vector source.

    Returns:
        Historical report with its original checksum contract.
    """
    with rasterio.open(dem.source_path) as dataset:
        grid = HydrologyGrid(
            crs=dataset.crs.to_string(),
            transform=tuple(dataset.transform)[:6],
            width=dataset.width,
            height=dataset.height,
            dtype=dataset.dtypes[0],
        )
    report = PreparedHydrologySnapshot.model_construct(
        definition=definition,
        demSignature=compute_document_checksum(dem.source_signature.to_catalog()),
        watershedSelection=watersheds.selection,
        validation=HydrologyRegistration(
            validator="eolab.hydrology-registration/v1",
            validatedAt=datetime(2026, 1, 1, tzinfo=timezone.utc),
            grid=grid,
        ),
        effectiveSha256="0" * 64,
    )
    return PreparedHydrologySnapshot.model_validate(
        {
            **report.model_dump(mode="json", by_alias=True),
            "effectiveSha256": report.compute_effective_checksum(),
        }
    )


@pytest.mark.parametrize(
    "validator",
    [
        "eolab.hydrology-registration/v1",
        "eolab.hydrology-validation/v1",
        "eolab.hydrology-validation/v2",
    ],
)
def test_historical_reports_keep_their_wire_checksum(
    tmp_path: Path, validator: str
) -> None:
    """Read saved registration and validation records without migrating their bytes.

    Args:
        tmp_path: Isolated original source fixtures.
        validator: Historical report schema retained in a saved Run YAML.
    """
    definition, dem, watersheds, _ = prepare_sources(tmp_path)
    report = legacy_snapshot(definition, dem, watersheds)
    document = report.model_dump(mode="json", by_alias=True)
    if "validation" in validator:
        document["validation"].update(
            validator=validator,
            watershedCount=3,
            terminalCount=1,
            demCellsChecked=24 if validator.endswith("v1") else 0,
            bounds={"west": 0.0, "south": 0.0, "east": 6.0, "north": 4.0},
        )
    payload = {
        key: value for key, value in document.items() if key != "effectiveSha256"
    }
    payload["validation"] = {
        key: value
        for key, value in payload["validation"].items()
        if key != "validatedAt"
    }
    document["effectiveSha256"] = compute_document_checksum(payload)
    restored = PreparedHydrologySnapshot.model_validate(
        parse_yaml(export_yaml(document, run=True), run=True)
    )
    assert restored.model_dump(mode="json", by_alias=True) == document
    document["demSignature"] = "f" * 64
    with pytest.raises(ValidationError, match="checksum"):
        PreparedHydrologySnapshot.model_validate(document)


def test_current_watershed_resolution_does_not_use_historical_signature(
    tmp_path: Path,
) -> None:
    """A new run accepts current sources while an active run keeps its own identity.

    Args:
        tmp_path: Isolated catalog vector and elevation fixtures.
    """
    definition, dem, watersheds, reader = prepare_sources(tmp_path)
    old_report = legacy_snapshot(definition, dem, watersheds)
    path = tmp_path / "watersheds.gpkg"
    stat = path.stat()
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
    current = asyncio.run(reader.resolve_source(definition.watersheds))
    assert current.selection != old_report.watershedSelection
    assert not current.selection.filter.active
    with pytest.raises(SelectionUnavailableError):
        asyncio.run(reader.resolve_for_sampling(old_report.watershedSelection))
    assert asyncio.run(reader.resolve_for_sampling(current.selection)) == current


def test_model_discovery_needs_no_registration_or_source_access() -> None:
    """Expose configured model inputs without any dataset eligibility endpoint."""
    app = FastAPI()
    app.include_router(create_processing_router(ProcessingService(object(), object())))
    with TestClient(app) as client:
        response = client.get("/api/processing/models")
        assert response.status_code == 200
        model = next(
            item
            for item in response.json()["models"]
            if item["id"] == "downstream-beneficiaries"
        )
        assert set(model["inputs"]) == {"starting_mask", "values"}
        assert set(model["steps"][0]["inputs"]["hydrology"]["value"]) == {
            "dem",
            "watersheds",
            "topology",
        }
        assert client.get("/api/processing/prepared-hydrology").status_code == 404
        assert not any(
            "prepared-hydrology" in path
            for path in client.get("/openapi.json").json()["paths"]
        )


def test_missing_configured_dem_names_the_unavailable_model_input(
    tmp_path: Path,
) -> None:
    """Report the missing configured DEM when a user starts the model without a report.

    Args:
        tmp_path: Mounted raster fixture used by the allowed user-selected inputs.
    """
    _, authorized, _, _ = prepare_sources(tmp_path)
    registry = ModelRegistry.load_installed()
    model = registry.get("downstream-beneficiaries", "4.0.0")
    configured_dem = model.steps[0].inputs["hydrology"].value.dem
    user_raster = {
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": "geotiff-" + "2" * 24,
    }

    async def authorize(source: CatalogRasterRequest) -> AuthorizedRaster:
        """Allow the selected raster and report a missing model-configured DEM.

        Args:
            source: Catalog identity requested by model submission.

        Returns:
            The readable fixture for the user-selected raster.

        Raises:
            RasterNotFoundError: If submission opens the configured DEM.
        """
        if source == configured_dem:
            raise RasterNotFoundError("The catalog raster could not be found.")
        return authorized

    jobs = SimpleNamespace(find_request=Mock(return_value=None), submit=Mock())
    authorizer = SimpleNamespace(authorize=AsyncMock(side_effect=authorize))
    service = ProcessingService(
        jobs, object(), model_registry=registry, model_authorizer=authorizer
    )
    request = ModelRunRequest.model_validate(
        {
            "requestId": "b" * 32,
            "model": {
                "id": model.id,
                "version": model.version,
                "definitionSha256": model.digest,
            },
            "inputs": {
                "starting_mask": {"kind": "catalogRaster", "source": user_raster},
                "values": user_raster,
            },
            "parameters": {},
            "label": "Missing DEM",
        }
    )
    with pytest.raises(ProcessingError, match="dem input is unavailable") as failure:
        asyncio.run(service.submit_model_run("owner", request))
    assert failure.value.code == "source_unavailable"
    assert "catalog raster could not be found" in failure.value.detail
    jobs.submit.assert_not_called()
