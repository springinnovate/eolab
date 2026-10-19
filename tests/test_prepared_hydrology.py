"""Resolve configured hydrology sources without registration reports."""

import asyncio
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
from rasterio.transform import from_origin
from shapely.geometry import box, mapping

from catalog_selection_support import FixtureCatalog
from eolab_app.catalog_selection import (
    ResolvedCatalogSelection,
    SelectionUnavailableError,
)
from eolab_app.processing.prepared_hydrology import HydrologySources
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
    HydrologySources,
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
    }
    definition = HydrologySources.model_validate(
        {**document, **(definition_changes or {})}
    )
    return (
        definition,
        AuthorizedRaster(dem_path, RasterSourceIdentity.read(dem_path)),
        resolved,
        VectorSamplingService(catalog, catalog),
    )


def test_current_watershed_resolution_preserves_catalog_binding(
    tmp_path: Path,
) -> None:
    """Resolve the configured watershed layer and reject substituted source bindings.

    Args:
        tmp_path: Isolated catalog vector and elevation fixtures.
    """
    definition, _, watersheds, reader = prepare_sources(tmp_path)
    current = asyncio.run(reader.resolve_source(definition.watersheds))
    assert current.selection == watersheds.selection
    assert not current.selection.filter.active
    for field in ("assetKey", "layerName"):
        with pytest.raises(SelectionUnavailableError, match="identity changed"):
            asyncio.run(
                reader.resolve_for_sampling(
                    current.selection.model_copy(update={field: "other"})
                )
            )
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
