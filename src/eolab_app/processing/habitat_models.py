"""Describe selected Habitat condition layers and fixed scientific settings."""

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from eolab_app.catalog_selection import VectorSelection
from eolab_app.processing.aggregate_models import AggregateArea
from eolab_app.processing.clip_models import ClipGrid
from eolab_app.processing.polygon_areas import PolygonAreaReference
from eolab_app.raster.models import Wgs84Bounds
from eolab_app.raster.source_models import RasterSourceReference

OPERATION = "habitat.condition.v1"
FiniteNumber = Annotated[float, Field(allow_inf_nan=False)]
Fraction = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
PositiveInteger = Annotated[int, Field(strict=True, gt=0)]
FITTING_COLUMN_NAMES = frozenset(
    {
        "validation_block_column",
        "validation_block_row",
        "validation_block_id",
        "reference_area_m2",
        "spatial_fold",
        "imputed_predictor_count",
        "missing_predictor_fraction",
        "usable_for_gam",
    }
)
"""Columns upstream fitting writes into the table containing the selected bands."""


class HabitatSchema(BaseModel):
    """Reject unknown Habitat input fields and keep admitted values immutable."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class NamedHabitatRaster(HabitatSchema):
    """A selected raster and the variable name used in fitting and diagnostics."""

    name: Annotated[str, Field(min_length=1)]
    source: RasterSourceReference


class HabitatRasterStack(HabitatSchema):
    """The final predictor and response choices, including one categorical predictor.

    Names are unique across both roles. The first predictor supplies the shared
    grid; every predictor and response must already be aligned with that grid.
    """

    predictors: Annotated[tuple[NamedHabitatRaster, ...], Field(min_length=1)]
    responses: Annotated[tuple[NamedHabitatRaster, ...], Field(min_length=1)]
    categoricalPredictor: str

    @model_validator(mode="after")
    def check_variable_names(self) -> Self:
        """Require unambiguous names that upstream fitting will not overwrite.

        Returns:
            This stack with unambiguous variable roles.

        Raises:
            ValueError: If names repeat, collide with fitting columns, or omit
                the categorical predictor.
        """
        names = [band.name for band in (*self.predictors, *self.responses)]
        if len(names) != len(set(names)):
            raise ValueError("Predictor and response variable names must be unique.")
        collisions = set(names) & FITTING_COLUMN_NAMES
        if collisions:
            raise ValueError(
                "Variable names conflict with fitting columns: "
                + ", ".join(sorted(collisions))
            )
        if self.categoricalPredictor not in {band.name for band in self.predictors}:
            raise ValueError("Choose a categorical predictor from the predictor stack.")
        return self


class RasterReferenceSites(HabitatSchema):
    """Use cells equal to one in an aligned raster as reference sites."""

    kind: Literal["raster"]
    source: RasterSourceReference


class VectorReferenceSites(HabitatSchema):
    """Use selected Catalog or uploaded polygons as reference sites."""

    kind: Literal["vector"]
    selection: VectorSelection


HabitatReferences = Annotated[
    RasterReferenceSites | VectorReferenceSites, Field(discriminator="kind")
]


class HabitatSettings(HabitatSchema):
    """Scientific and sampling settings supplied by the administrator's recipe.

    Attributes:
        fold_count: Number of spatial cross-validation folds.
        sampling_block_size_meters: Width of equal-area sampling blocks.
        validation_block_size_meters: Width of grouped validation blocks.
        minimum_predictor_coverage: Sampled-area coverage needed to keep a predictor.
        maximum_row_missing_fraction: Largest predictor missing fraction in a modeled row.
        spline_knot_count: Number of spline knots for each continuous predictor.
        minimum_response_coverage: Reference-area coverage needed to fit a response.
        ridge_alpha: Nonnegative L2 regularization strength.
        samples_per_class_per_block: Sample cap for each block and reference class.
        random_seed: Seed for reproducible sample selection.
        tile_size_pixels: Width of virtual sampling tiles.
        window_size_pixels: Width and height of prediction windows.
        covariance_shrinkage: Fraction used to regularize the reference covariance.
        tile_origin: EPSG:6933 origin anchoring the virtual sampling tiles.
    """

    fold_count: Annotated[int, Field(strict=True, ge=2)]
    sampling_block_size_meters: PositiveInteger
    validation_block_size_meters: PositiveInteger
    minimum_predictor_coverage: Fraction
    maximum_row_missing_fraction: Fraction
    spline_knot_count: Annotated[int, Field(strict=True, ge=2)]
    minimum_response_coverage: Fraction
    ridge_alpha: Annotated[float, Field(ge=0, allow_inf_nan=False)]
    samples_per_class_per_block: PositiveInteger
    random_seed: Annotated[int, Field(strict=True)]
    tile_size_pixels: PositiveInteger
    window_size_pixels: PositiveInteger
    covariance_shrinkage: Annotated[float, Field(gt=0, lt=1, allow_inf_nan=False)]
    tile_origin: tuple[FiniteNumber, FiniteNumber]


class HabitatRequest(HabitatSchema):
    """Capture the selected layers, assessment area and fixed settings for one run."""

    stack: HabitatRasterStack
    references: HabitatReferences
    habitat_mask: RasterSourceReference | None
    settings: HabitatSettings
    selectedBounds: Wgs84Bounds | None = None
    catalogSelection: VectorSelection | None = None
    polygonArea: PolygonAreaReference | None = None
    wholeRaster: Literal[True] | None = None

    @model_validator(mode="after")
    def check_area_choice(self) -> Self:
        """Require exactly one assessment-area choice in submitted or saved inputs.

        Returns:
            This request with one explicit assessment area.

        Raises:
            ValueError: If no area or several areas were supplied.
        """
        if (
            sum(
                value is not None
                for value in (
                    self.selectedBounds,
                    self.catalogSelection,
                    self.polygonArea,
                    self.wholeRaster,
                )
            )
            != 1
        ):
            raise ValueError(
                "Choose one box, vector selection, polygon area, or whole raster."
            )
        return self


class QueuedHabitat(HabitatSchema):
    """Accepted Habitat inputs awaiting worker preparation and source resolution."""

    operation: Literal["habitat.condition.v1"] = OPERATION
    request: HabitatRequest
    polygonArea: AggregateArea | None = None


class HabitatPlan(HabitatSchema):
    """Captured Habitat inputs, exact area descriptor and source-aligned output grid."""

    operation: Literal["habitat.condition.v1"] = OPERATION
    inputs: HabitatRequest
    area: AggregateArea
    grid: ClipGrid
