"""Expose Habitat input choices, saved preparation areas and current coverage."""

import asyncio
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Path as PathParameter, Request, Response
from pydantic import BaseModel

from eolab_app.catalog_selection import (
    CatalogSelectionReader,
    SelectionUnavailableError,
)
from eolab_app.processing.habitat_earth_engine import load_habitat_stack
from eolab_app.processing.habitat_prepared_areas import (
    HabitatPreparedArea,
    HabitatPreparedAreaStore,
    get_prepared_habitat_area_coverage,
)
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.habitat_models import (
    get_habitat_dataset_roles,
    get_required_habitat_predictor_datasets,
)
from eolab_app.raster.source_models import ProjectedRasterGrid
from eolab_app.routes.http_disconnect import (
    HttpClientDisconnectedError,
    run_until_http_disconnect,
)

HABITAT_DATASET_LINKS: dict[str, tuple[str, str]] = {
    "LANDSAT/COMPOSITES/C02/T1_L2_8DAY_NDVI": (
        "Landsat NDVI composites",
        "https://developers.google.com/earth-engine/datasets/catalog/LANDSAT_COMPOSITES_C02_T1_L2_8DAY_NDVI",
    ),
    "MODIS/061/MCD12Q2": (
        "MODIS land-cover dynamics / phenology",
        "https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MCD12Q2",
    ),
    "projects/global-pasture-watch/assets/gsvh-30m/v1/short-veg-height_m": (
        "Global Pasture Watch short vegetation height",
        "https://developers.google.com/earth-engine/datasets/catalog/projects_global-pasture-watch_assets_gsvh-30m_v1_short-veg-height_m",
    ),
    "MODIS/061/MOD44B": (
        "MODIS vegetation cover",
        "https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MOD44B",
    ),
    "MODIS/061/MOD15A2H": (
        "MODIS LAI / FPAR",
        "https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MOD15A2H",
    ),
    "MODIS/061/MOD17A3HGF": (
        "MODIS annual productivity",
        "https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MOD17A3HGF",
    ),
    "ECMWF/ERA5/DAILY": (
        "ERA5 daily aggregates",
        "https://developers.google.com/earth-engine/datasets/catalog/ECMWF_ERA5_DAILY",
    ),
    "ECMWF/ERA5/MONTHLY": (
        "ERA5 monthly aggregates",
        "https://developers.google.com/earth-engine/datasets/catalog/ECMWF_ERA5_MONTHLY",
    ),
    "GRIDMET/DROUGHT": (
        "GRIDMET drought",
        "https://developers.google.com/earth-engine/datasets/catalog/GRIDMET_DROUGHT",
    ),
    "NASA/VIIRS/002/VNP64A1": (
        "VIIRS burned area",
        "https://developers.google.com/earth-engine/datasets/catalog/NASA_VIIRS_002_VNP64A1",
    ),
    "JRC/GSW1_4/MonthlyHistory": (
        "JRC monthly water",
        "https://developers.google.com/earth-engine/datasets/catalog/JRC_GSW1_4_MonthlyHistory",
    ),
    "MERIT/Hydro/v1_0_1": (
        "MERIT Hydro",
        "https://developers.google.com/earth-engine/datasets/catalog/MERIT_Hydro_v1_0_1",
    ),
    "projects/soilgrids-isric/soc_mean": (
        "SoilGrids organic carbon",
        "https://gee-community-catalog.org/projects/isric/",
    ),
    "NASA/GLDAS/V021/NOAH/G025/T3H": (
        "GLDAS",
        "https://developers.google.com/earth-engine/datasets/catalog/NASA_GLDAS_V021_NOAH_G025_T3H",
    ),
    "CSP/ERGo/1_0/Global/SRTM_landforms": (
        "SRTM landforms",
        "https://developers.google.com/earth-engine/datasets/catalog/CSP_ERGo_1_0_Global_SRTM_landforms",
    ),
    "CSP/ERGo/1_0/Global/ALOS_topoDiversity": (
        "ALOS topographic diversity",
        "https://developers.google.com/earth-engine/datasets/catalog/CSP_ERGo_1_0_Global_ALOS_topoDiversity",
    ),
    "MODIS/061/MOD16A2GF": (
        "MODIS evapotranspiration",
        "https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MOD16A2GF",
    ),
    "NASA/SMAP/SPL4SMGP/008": (
        "SMAP",
        "https://developers.google.com/earth-engine/datasets/catalog/NASA_SMAP_SPL4SMGP_008",
    ),
}


class HabitatDatasetSource(BaseModel):
    """Describe a linked dataset used by the configured Habitat input bands.

    Attributes:
        id: Stable configured dataset alias used in submitted selections.
        label: Human-readable dataset name shown in model setup.
        url: Catalog page describing the configured Earth Engine source.
        roles: Predictor and/or response roles derived from the configured bands.
        requiredRoles: Roles in which this source must remain selected.
    """

    id: str
    label: str
    url: str
    roles: list[Literal["predictor", "response"]]
    requiredRoles: list[Literal["predictor", "response"]]


class HabitatEarthEngineOptions(BaseModel):
    """Scientific source choices available to Habitat model setup.

    Attributes:
        defaultYear: Assessment year selected by the packaged configuration.
        minimumYear: First year supported by the complete input stack.
        maximumYear: Last year supported by the complete input stack.
        grid: Fixed projection, pixel size and origin used to acquire the inputs.
        datasets: Linked sources used by predictor and response bands, excluding
            sources used only to generate upstream reference sites.
    """

    defaultYear: int
    minimumYear: int
    maximumYear: int
    grid: ProjectedRasterGrid
    datasets: list[HabitatDatasetSource]


class HabitatPreparedAreasResponse(BaseModel):
    """List named, durable Catalog selections available to Earth Engine runs.

    Attributes:
        areas: Stable identities, administrator labels and exact Catalog selections.
            Coverage is checked separately for the selected assessment year.
    """

    areas: list[HabitatPreparedArea]


class HabitatPreparedAreaCoverageResponse(BaseModel):
    """Describe cached inputs for one saved area and assessment year.

    Attributes:
        areaId: Saved preparation-area identity requested by the browser.
        year: Assessment year whose current scientific configuration was inspected.
        requiredTiles: Input tiles intersecting the exact saved polygon selection.
        cachedTiles: Required tiles currently published in the existing cache.
        missingTiles: Required tiles not yet present; positive counts permit a
            partial run when at least one tile is cached.
    """

    areaId: str
    year: int
    requiredTiles: int
    cachedTiles: int
    missingTiles: int


def create_habitat_router(
    prepared_areas: HabitatPreparedAreaStore | None = None,
    selections: CatalogSelectionReader | None = None,
    cache_directory: Path | None = None,
) -> APIRouter:
    """Create Habitat setup routes using configured inputs and saved Catalog areas.

    Args:
        prepared_areas: Durable administrator-defined areas, or None when unavailable.
        selections: Existing original-source authorization and polygon reader.
        cache_directory: Server-controlled persistent Habitat input-cache root.

    Returns:
        Read-only, path-free setup routes without administrator credentials,
        Earth Engine requests or pixel scans.
    """
    router = APIRouter(tags=["processing"])
    coverage_lock = asyncio.Lock()

    @router.get("/api/processing/models/habitat-condition/prepared-areas")
    async def get_prepared_areas(response: Response) -> HabitatPreparedAreasResponse:
        """List saved area choices independently of preparation-job retention.

        Args:
            response: Response receiving a no-store policy for current choices.

        Returns:
            Saved labels and Catalog selections, including areas awaiting inputs.

        Raises:
            HTTPException: If durable area storage is unavailable.
        """
        response.headers["Cache-Control"] = "private, no-store"
        if prepared_areas is None:
            raise HTTPException(
                503,
                "Saved preparation areas are temporarily unavailable. Try again later.",
                headers={"Cache-Control": "private, no-store"},
            )
        try:
            areas = await asyncio.to_thread(prepared_areas.list)
        except ProcessingError as error:
            raise HTTPException(
                error.status,
                error.detail,
                headers={"Cache-Control": "private, no-store"},
            ) from error
        return HabitatPreparedAreasResponse(areas=list(areas))

    @router.get(
        "/api/processing/models/habitat-condition/prepared-areas/{area_id}/coverage"
    )
    async def get_prepared_area_coverage(
        request: Request,
        response: Response,
        year: int,
        area_id: str = PathParameter(pattern=r"^[a-f0-9]{64}$"),
    ) -> HabitatPreparedAreaCoverageResponse:
        """Check current tile availability for a saved area and assessment year.

        Args:
            request: Connection whose disconnection cancels native inspection.
            response: Response receiving a no-store policy for the current snapshot.
            year: Assessment year supported by the installed scientific configuration.
            area_id: Stable saved-area identity, never an arbitrary source path.

        Returns:
            Complete, partial or zero tile counts without downloading inputs.

        Raises:
            HTTPException: If the area, original source or cache is unavailable,
                the year is unsupported, or the browser disconnects.
        """
        response.headers["Cache-Control"] = "private, no-store"

        async def inspect_coverage() -> HabitatPreparedAreaCoverageResponse:
            """Authorize and inspect the saved selection after prior reads finish.

            Returns:
                Current tile counts for the requested saved area and year.

            Raises:
                ProcessingError: If configuration, the saved area or cache fails.
                SelectionUnavailableError: If its original Catalog source is unavailable.
            """
            async with coverage_lock:
                coverage = await get_prepared_habitat_area_coverage(
                    area_id, year, prepared_areas, selections, cache_directory
                )
            return HabitatPreparedAreaCoverageResponse(
                areaId=area_id,
                year=coverage.year,
                requiredTiles=coverage.required_tiles,
                cachedTiles=coverage.cached_tiles,
                missingTiles=coverage.missing_tiles,
            )

        try:
            return await run_until_http_disconnect(request, inspect_coverage())
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Prepared-area check cancelled.") from error
        except SelectionUnavailableError as error:
            raise HTTPException(
                409, error.detail, headers={"Cache-Control": "private, no-store"}
            ) from error
        except ProcessingError as error:
            raise HTTPException(
                error.status,
                error.detail,
                headers={"Cache-Control": "private, no-store"},
            ) from error

    @router.get("/api/processing/models/habitat-condition/earth-engine-options")
    def get_earth_engine_options() -> HabitatEarthEngineOptions:
        """Return source years, the acquisition grid and linked input datasets.

        Returns:
            Options derived from the original model's scientific configuration.

        Raises:
            OSError: If the installed scientific configuration cannot be read.
            ValueError: If the installed scientific configuration is invalid.
            KeyError: If a configured dataset has no Habitat catalog description.
        """
        configuration = load_habitat_stack()
        grid = configuration.grid
        dataset_roles = get_habitat_dataset_roles(configuration)
        required_predictors = get_required_habitat_predictor_datasets(configuration)
        datasets: list[HabitatDatasetSource] = []
        for key, roles in dataset_roles.items():
            label, url = HABITAT_DATASET_LINKS[configuration.datasets[key]]
            datasets.append(
                HabitatDatasetSource(
                    id=key,
                    label=label,
                    url=url,
                    roles=list(roles),
                    requiredRoles=["predictor"] if key in required_predictors else [],
                )
            )
        return HabitatEarthEngineOptions(
            defaultYear=configuration.year,
            minimumYear=configuration.minimum_year,
            maximumYear=configuration.maximum_year,
            grid=ProjectedRasterGrid(
                crs=grid.crs,
                pixelSize=(grid.pixel_size_meters, grid.pixel_size_meters),
                origin=(grid.origin_x, grid.origin_y),
                unit="metre",
                approximate=False,
            ),
            datasets=datasets,
        )

    return router
