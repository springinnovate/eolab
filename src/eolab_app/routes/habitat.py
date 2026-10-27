"""Expose the original Habitat input years and acquisition grid for model setup."""

from fastapi import APIRouter
from pydantic import BaseModel

from eolab_app.processing.habitat_earth_engine import load_habitat_stack
from eolab_app.raster.source_models import ProjectedRasterGrid


class HabitatEarthEngineOptions(BaseModel):
    """Scientific source choices available to Habitat model setup.

    Attributes:
        defaultYear: Assessment year selected by the packaged configuration.
        minimumYear: First year supported by the complete input stack.
        maximumYear: Last year supported by the complete input stack.
        grid: Fixed projection, pixel size and origin used to acquire the inputs.
    """

    defaultYear: int
    minimumYear: int
    maximumYear: int
    grid: ProjectedRasterGrid


def create_habitat_router() -> APIRouter:
    """Create the Habitat setup route using its packaged scientific configuration.

    Returns:
        Router exposing public source choices without credentials or GEE requests.
    """
    router = APIRouter(tags=["processing"])

    @router.get("/api/processing/models/habitat-condition/earth-engine-options")
    def get_earth_engine_options() -> HabitatEarthEngineOptions:
        """Return supported source years and the fixed input grid.

        Returns:
            Options derived from the original model's scientific configuration.

        Raises:
            OSError: If the installed scientific configuration cannot be read.
            ValueError: If the installed scientific configuration is invalid.
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
        )

    return router
