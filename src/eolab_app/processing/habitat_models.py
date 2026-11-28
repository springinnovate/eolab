"""Describe selected Habitat condition layers and fixed model settings."""

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, model_validator
from nhi_terrestrial_integrity_modeling.analysis_config import RasterStackConfiguration

from eolab_app.catalog_selection import ModelVectorSelection
from eolab_app.processing.aggregate_models import AggregateArea
from eolab_app.processing.clip_models import ClipGrid
from eolab_app.processing.habitat_earth_engine import load_habitat_stack
from eolab_app.polygon_areas import PolygonAreaReference
from eolab_app.sampling_box import Wgs84SamplingBox
from eolab_app.raster.models import Wgs84Bounds
from eolab_app.raster.source_models import RasterSourceReference

OPERATION = "habitat.condition.v1"
FiniteNumber = Annotated[float, Field(allow_inf_nan=False)]
Fraction = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
PositiveInteger = Annotated[int, Field(strict=True, gt=0)]
PositiveNumber = Annotated[float, Field(gt=0, allow_inf_nan=False)]
ResamplingMethod = Literal["nearest", "bilinear", "cubic", "average", "mode"]
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


def get_habitat_dataset_roles(
    configuration: RasterStackConfiguration,
) -> dict[str, tuple[Literal["predictor", "response"], ...]]:
    """Return configured dataset aliases and the model roles that use them.

    Args:
        configuration: Admitted scientific source definitions for one year.

    Returns:
        Dataset aliases in configured band order, excluding reference-only sources.
        A source used in both roles appears once with both roles.
    """
    roles: dict[str, set[Literal["predictor", "response"]]] = {}
    for band in configuration.bands:
        if band.role in ("predictor", "response"):
            for key in band.source_dataset_keys:
                roles.setdefault(key, set()).add(band.role)
    return {
        key: tuple(role for role in ("predictor", "response") if role in used_roles)
        for key, used_roles in roles.items()
    }


class HabitatSchema(BaseModel):
    """Reject unknown Habitat input fields and keep admitted values immutable."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class NamedHabitatRaster(HabitatSchema):
    """A selected raster and the variable name used in fitting and diagnostics."""

    name: Annotated[str, Field(min_length=1)]
    source: RasterSourceReference


class HabitatRasterStack(HabitatSchema):
    """The final predictor and response choices, with an optional categorical predictor.

    Names are unique across both roles. Inputs are prepared on the model's fixed
    grid before sampling and fitting.
    """

    predictors: Annotated[tuple[NamedHabitatRaster, ...], Field(min_length=1)]
    responses: Annotated[tuple[NamedHabitatRaster, ...], Field(min_length=1)]
    categoricalPredictor: str | None = None

    @model_validator(mode="after")
    def check_variable_names(self) -> Self:
        """Require unambiguous names that upstream fitting will not overwrite.

        Returns:
            This stack with unambiguous variable roles.

        Raises:
            ValueError: If names repeat, collide with fitting columns, or designate
                an unknown categorical predictor.
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
        if self.categoricalPredictor is not None and self.categoricalPredictor not in {
            band.name for band in self.predictors
        }:
            raise ValueError("Choose a categorical predictor from the predictor stack.")
        return self


class HabitatEarthEngineStack(HabitatSchema):
    """Use prepared geographic coverage of the original inputs for one year.

    The scientific configuration loader owns the supported year range. Reference
    sites still come from the user's separate selection, never from Earth Engine.
    Ordinary runs read complete cached tiles and leave unprepared areas as NoData;
    administrators prepare missing inputs separately.

    Attributes:
        kind: Selects the literal string "earthEngine".
        year: Supported source year.
        predictorDatasets: Configured source aliases used as predictors. Omission
            selects all predictor datasets; explicit empty selections are invalid.
        responseDatasets: Configured source aliases used as observed responses.
            Omission selects all response datasets; at least one is required.
            Choices for a source used in both roles are independent. A band with
            several sources is included only when all are selected for its role.
    """

    kind: Literal["earthEngine"]
    year: Annotated[int, Field(strict=True)]
    predictorDatasets: Annotated[tuple[str, ...], Field(min_length=1)] = Field(
        default_factory=tuple
    )
    responseDatasets: Annotated[tuple[str, ...], Field(min_length=1)] = Field(
        default_factory=tuple
    )

    _selected_band_counts: dict[str, int] = PrivateAttr(default_factory=dict)
    _tile_pixels: int = PrivateAttr()

    def selected_grid_work(self) -> tuple[int, int, int]:
        """Return the accepted predictor and response counts and pixels per prepared tile.

        Returns:
            Counts from validation of this selection against its installed scientific
            configuration. These measurements are private and need no second file read.
        """
        return (
            self._selected_band_counts["predictor"],
            self._selected_band_counts["response"],
            self._tile_pixels,
        )

    @model_validator(mode="after")
    def check_dataset_selection(self) -> Self:
        """Admit known role-specific datasets and expand omitted choices to all.

        Returns:
            This immutable selection with effective aliases in configuration order.

        Raises:
            ValueError: If the year or dataset choices are invalid or provide no usable band for a role.
            OSError: If the installed scientific configuration cannot be read.
        """
        configuration = load_habitat_stack(self.year)
        roles = get_habitat_dataset_roles(configuration)
        self._tile_pixels = configuration.grid.tile_size_pixels**2
        for field_name, role in (
            ("predictorDatasets", "predictor"),
            ("responseDatasets", "response"),
        ):
            available = tuple(key for key, values in roles.items() if role in values)
            selected = (
                getattr(self, field_name)
                if field_name in self.model_fields_set
                else available
            )
            if len(selected) != len(set(selected)):
                raise ValueError("Choose each dataset only once within a model role.")
            if set(selected) - set(available):
                raise ValueError(f"Choose configured {role} datasets.")
            band_count = sum(
                band.role == role and set(band.source_dataset_keys).issubset(selected)
                for band in configuration.bands
            )
            if not band_count:
                raise ValueError(
                    f"Choose datasets that supply at least one {role} band."
                )
            self._selected_band_counts[role] = band_count
            object.__setattr__(
                self, field_name, tuple(key for key in available if key in selected)
            )
        return self


HabitatStack = HabitatRasterStack | HabitatEarthEngineStack
"""Manual raster choices or the packaged Earth Engine variables for one year."""


class RasterReferenceSites(HabitatSchema):
    """Use valid finite non-zero raster cells as reference sites.

    Nearest-neighbor alignment preserves source membership. Zero, NoData and
    nonfinite cells are excluded; valid negative values are reference sites.

    Attributes:
        kind: Selects the literal string "raster".
        source: Catalog or session-owned raster selected for reference sites.
    """

    kind: Literal["raster"]
    source: RasterSourceReference


class VectorReferenceSites(HabitatSchema):
    """Use selected Catalog or uploaded polygons as reference sites."""

    kind: Literal["vector"]
    selection: ModelVectorSelection


class PolygonReferenceSites(HabitatSchema):
    """Use a private polygon input as reference sites for this run.

    Attributes:
        kind: Selects the literal string "polygonArea".
        reference: Expiring polygon reference owned by the submitting session.
            Admission copies its geometry before queueing the run.
    """

    kind: Literal["polygonArea"]
    reference: PolygonAreaReference


HabitatReferences = Annotated[
    RasterReferenceSites | VectorReferenceSites | PolygonReferenceSites,
    Field(discriminator="kind"),
]


class HabitatPreparation(HabitatSchema):
    """One resampling method for each input raster.

    Attributes:
        resampling: Methods keyed by predictor_N, response_N, reference_mask or
            habitat_mask, matching the selected source roles exactly.
            Reference masks require nearest-neighbor alignment.
            Automatic bands use nearest-neighbor resampling; in automatic mode
            this mapping contains only the user-selected raster masks.
    """

    resampling: dict[str, ResamplingMethod]


class HabitatOutputGrid(HabitatSchema):
    """The calculation grid fixed by the Ecosystem Condition model recipe.

    Attributes:
        crs: Equal-area coordinate system required by the scientific runner.
        pixel_size: Positive X/Y cell sizes in metres.
        origin: Grid intersection anchoring the AOI's outward-snapped bounds.
    """

    crs: Literal["EPSG:6933"]
    pixel_size: tuple[PositiveNumber, PositiveNumber]
    origin: tuple[FiniteNumber, FiniteNumber]


class HabitatSettings(HabitatSchema):
    """Projection, scientific and sampling settings fixed by the model recipe.

    Attributes:
        output_grid: Calculation grid fixed by the model, independent of inputs.
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

    output_grid: HabitatOutputGrid
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
    """Capture layers, assessment area, raster preparation and settings for one run."""

    stack: HabitatStack
    references: HabitatReferences
    habitat_mask: RasterSourceReference | None
    preparation: HabitatPreparation
    settings: HabitatSettings
    selectedBounds: Wgs84Bounds | None = None
    samplingBox: Wgs84SamplingBox | None = None
    catalogSelection: ModelVectorSelection | None = None
    polygonArea: PolygonAreaReference | None = None
    wholeRaster: Literal[True] | None = None

    def get_raster_sources(self) -> dict[str, RasterSourceReference]:
        """Return all selected rasters under their preparation and retention roles.

        Returns:
            Manually selected predictor and response positions, plus raster
            references and assessment masks in either mode. Downloaded tiles have
            no Catalog identity and are not declared as external raster sources.
        """
        sources = {}
        if isinstance(self.stack, HabitatRasterStack):
            sources = {
                f"predictor_{index}": band.source
                for index, band in enumerate(self.stack.predictors)
            }
            sources.update(
                {
                    f"response_{index}": band.source
                    for index, band in enumerate(self.stack.responses)
                }
            )
        if isinstance(self.references, RasterReferenceSites):
            sources["reference_mask"] = self.references.source
        if self.habitat_mask is not None:
            sources["habitat_mask"] = self.habitat_mask
        return sources

    @model_validator(mode="after")
    def check_preparation(self) -> Self:
        """Require one explicit resampling method for each active raster.

        Returns:
            This request with one method per raster.

        Raises:
            ValueError: If a method is missing or names an inactive source, or
                reference sites do not use nearest-neighbor alignment.
        """
        if set(self.preparation.resampling) != set(self.get_raster_sources()):
            raise ValueError("Choose one resampling method for each selected raster.")
        if (
            isinstance(self.references, RasterReferenceSites)
            and self.preparation.resampling["reference_mask"] != "nearest"
        ):
            raise ValueError("Reference sites require nearest-neighbor resampling.")
        return self

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
                    self.samplingBox,
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
        if isinstance(self.stack, HabitatEarthEngineStack) and self.wholeRaster:
            raise ValueError(
                "Choose an explicit analysis area for Earth Engine inputs."
            )
        return self


class QueuedHabitat(HabitatSchema):
    """Keep accepted inputs and both owned polygon roles until worker preparation.

    polygonArea holds drawn assessment geometry. referencePolygons holds
    drawn reference sites. Each is absent when its role uses another source.
    """

    operation: Literal["habitat.condition.v1"] = OPERATION
    request: HabitatRequest
    polygonArea: AggregateArea | None = None
    referencePolygons: AggregateArea | None = None


class HabitatCalculationInputs(HabitatSchema):
    """Captured Habitat inputs, exact area descriptor and the model's output grid.

    Grid datatype and NoData describe the runner's primary Reference similarity
    output: float32 with valid values from 0 to 1 and -9999 for missing values.
    Temporary aligned inputs use float64 and NaN NoData on the same spatial grid.
    The window starts at zero; nativeBlocks counts 512-pixel preparation tiles.
    earthEngine captures the packaged scientific source definitions for automatic
    inputs; it contains no credentials, local paths or generated reference sites.
    referencePolygons retains the admitted drawing for the worker to rasterize
    as reference sites on this grid.
    """

    operation: Literal["habitat.condition.v1"] = OPERATION
    inputs: HabitatRequest
    area: AggregateArea
    grid: ClipGrid
    earthEngine: RasterStackConfiguration | None = None
    referencePolygons: AggregateArea | None = None
