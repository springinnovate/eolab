"""Expose Habitat input choices, prepared Catalog selections and current coverage."""

import asyncio
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from eolab_app.catalog_selection import (
    CatalogSelection,
    CatalogSelectionReader,
    SelectionUnavailableError,
)
from eolab_app.processing.habitat_earth_engine import load_habitat_stack
from eolab_app.processing.habitat_preparation_selections import (
    HabitatPreparationSelections,
    get_habitat_preparation_coverage,
)
from eolab_app.processing.models import ProcessingError
from eolab_app.routes.habitat_datasets import (
    HabitatDatasetSource,
    describe_habitat_datasets,
)
from eolab_app.raster.source_models import ProjectedRasterGrid
from eolab_app.routes.processing import RequestSizeLimitedRoute
from eolab_app.routes.http_disconnect import (
    HttpClientDisconnectedError,
    run_until_http_disconnect,
)


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


class HabitatPreparationSelectionsResponse(BaseModel):
    """List existing Catalog selections recorded by input preparation.

    Attributes:
        selections: Original Catalog source, layer and filter references. Their
            current tile coverage is checked separately for the selected year.
    """

    selections: list[CatalogSelection]


class HabitatPreparationCoverageRequest(BaseModel):
    """Check prepared inputs for an exact Catalog selection and assessment year.

    Attributes:
        selection: Existing Catalog descriptor, including its complete feature filter.
        year: Assessment year checked by the installed scientific configuration.
    """

    model_config = ConfigDict(extra="forbid")
    selection: CatalogSelection
    year: int = Field(strict=True)


class HabitatPreparationCoverageResponse(BaseModel):
    """Describe current cached inputs for the requested Catalog selection and year.

    Attributes:
        year: Assessment year whose current scientific configuration was inspected.
        requiredTiles: Input tiles intersecting the exact selected polygons.
        cachedTiles: Required tiles currently published in the existing cache.
        missingTiles: Required tiles not yet present. A partial run is allowed
            when at least one tile is cached.
    """

    year: int
    requiredTiles: int
    cachedTiles: int
    missingTiles: int


def create_habitat_router(
    preparation_selections: HabitatPreparationSelections | None = None,
    selections: CatalogSelectionReader | None = None,
    cache_directory: Path | None = None,
) -> APIRouter:
    """Expose model input choices and coverage for prepared Catalog selections.

    Args:
        preparation_selections: Recorded Catalog references, or None when unavailable.
        selections: Existing original-source authorization and polygon reader.
        cache_directory: Server-controlled persistent Habitat input-cache root.

    Returns:
        Read-only, path-free setup routes without administrator credentials,
        Earth Engine requests or raster-pixel scans.
    """
    router = APIRouter(tags=["processing"], route_class=RequestSizeLimitedRoute)
    coverage_lock = asyncio.Lock()

    @router.get("/api/processing/models/habitat-condition/preparation-selections")
    async def get_preparation_selections(
        response: Response,
    ) -> HabitatPreparationSelectionsResponse:
        """List exact Catalog selections independently of preparation-job retention.

        Args:
            response: Response receiving a no-store policy for current choices.

        Returns:
            Catalog selections recorded by preparation, including those awaiting inputs.

        Raises:
            HTTPException: If preparation-reference storage is unavailable.
        """
        response.headers["Cache-Control"] = "private, no-store"
        if preparation_selections is None:
            raise HTTPException(
                503,
                "Prepared Catalog selections are temporarily unavailable. Try again later.",
                headers={"Cache-Control": "private, no-store"},
            )
        try:
            recorded = await asyncio.to_thread(preparation_selections.list)
        except ProcessingError as error:
            raise HTTPException(
                error.status,
                error.detail,
                headers={"Cache-Control": "private, no-store"},
            ) from error
        return HabitatPreparationSelectionsResponse(selections=list(recorded))

    @router.post("/api/processing/models/habitat-condition/preparation-coverage")
    async def get_preparation_coverage(
        body: HabitatPreparationCoverageRequest,
        request: Request,
        response: Response,
    ) -> HabitatPreparationCoverageResponse:
        """Read current tile coverage for an exact prepared Catalog selection.

        Args:
            body: Catalog selection and assessment year supplied by setup.
            request: Connection whose disconnection cancels native inspection.
            response: Response receiving a no-store policy for the current snapshot.

        Returns:
            Complete, partial or zero tile counts without downloading inputs.

        Raises:
            HTTPException: If preparation membership, the original source or cache
                is unavailable, the year is unsupported, or the browser disconnects.
        """
        response.headers["Cache-Control"] = "private, no-store"

        async def inspect_coverage() -> HabitatPreparationCoverageResponse:
            """Authorize and inspect the selection after prior native reads finish.

            Returns:
                Current tile counts for the requested selection and year.

            Raises:
                ProcessingError: If configuration, recorded preparation or cache fails.
                SelectionUnavailableError: If its original Catalog source is unavailable.
            """
            async with coverage_lock:
                coverage = await get_habitat_preparation_coverage(
                    body.selection,
                    body.year,
                    preparation_selections,
                    selections,
                    cache_directory,
                )
            return HabitatPreparationCoverageResponse(
                year=coverage.year,
                requiredTiles=coverage.required_tiles,
                cachedTiles=coverage.cached_tiles,
                missingTiles=coverage.missing_tiles,
            )

        try:
            return await run_until_http_disconnect(request, inspect_coverage())
        except HttpClientDisconnectedError as error:
            raise HTTPException(
                499,
                "Preparation coverage check cancelled.",
                headers={"Cache-Control": "private, no-store"},
            ) from error
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
            datasets=describe_habitat_datasets(configuration),
        )

    return router
