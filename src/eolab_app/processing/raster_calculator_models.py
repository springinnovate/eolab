"""Describe the raster calculator's selected inputs and prepared output grid."""

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, model_validator

from eolab_app.catalog_selection import VectorSelection
from eolab_app.polygon_areas import PolygonAreaReference
from eolab_app.processing.aggregate_models import AggregateArea, Alias
from eolab_app.processing.model_result_contracts import RasterResultGrid
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.raster_expression import (
    PIXEL_FUNCTIONS,
    Node,
    compile_pixel_expression,
)
from eolab_app.raster.models import Wgs84Bounds
from eolab_app.raster.source_models import RasterSourceReference
from eolab_app.sampling_box import Wgs84SamplingBox

OPERATION = "raster.calculator.v1"
INPUT_TYPE = "raster_formula"
CellSize = Annotated[float, Field(strict=True, gt=0, allow_inf_nan=False)]


class RasterCalculatorSchema(BaseModel):
    """Require declared fields and keep accepted calculator settings immutable."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class RasterFormulaLayer(RasterCalculatorSchema):
    """Bind one formula alias to a path-free raster identity and resampling method."""

    alias: Alias
    source: RasterSourceReference
    resampling: Literal["nearest", "bilinear", "mode", "min", "max", "mean"]


class MatchRasterGrid(RasterCalculatorSchema):
    """Use the named input's CRS, cell sizes and grid origin."""

    kind: Literal["match"]
    alias: Alias


class CustomRasterGrid(RasterCalculatorSchema):
    """Use an EPSG coordinate system and positive X/Y sizes in its units."""

    kind: Literal["custom"]
    crs: Annotated[str, Field(strict=True, pattern=r"^EPSG:[1-9][0-9]{0,8}$")]
    pixelSize: tuple[CellSize, CellSize]


class RasterFormulaInput(RasterCalculatorSchema):
    """Capture the formula and exact input bindings chosen in Data tools."""

    layers: Annotated[tuple[RasterFormulaLayer, ...], Field(min_length=1)]
    expression: Annotated[str, Field(strict=True, min_length=1, max_length=4096)]
    grid: Annotated[MatchRasterGrid | CustomRasterGrid, Field(discriminator="kind")]
    _formula: Node = PrivateAttr()

    @model_validator(mode="after")
    def validate_formula(self) -> Self:
        """Resolve formula names and ensure the reference grid names a bound input.

        Returns:
            This input with a validated, process-local syntax tree.
        Raises:
            ValueError: If an alias, reference grid or formula is invalid.
        """
        aliases = frozenset(layer.alias for layer in self.layers)
        if len(aliases) != len(self.layers) or aliases & PIXEL_FUNCTIONS:
            raise ValueError(
                "Raster variables must be unique and cannot be min or max."
            )
        if isinstance(self.grid, MatchRasterGrid) and self.grid.alias not in aliases:
            raise ValueError("Choose a reference grid from the input rasters.")
        try:
            self._formula = compile_pixel_expression(self.expression, aliases)
        except ProcessingError as error:
            raise ValueError(error.detail) from error
        return self

    @property
    def formula(self) -> Node:
        """Return the validated expression tree for preparing and evaluating tiles."""
        return self._formula


class RasterCalculatorRequest(RasterCalculatorSchema):
    """One raster formula restricted to a box or selected polygon area."""

    calculation: RasterFormulaInput
    selectedBounds: Wgs84Bounds | None = None
    samplingBox: Wgs84SamplingBox | None = None
    catalogSelection: VectorSelection | None = None
    polygonArea: PolygonAreaReference | None = None

    @model_validator(mode="after")
    def validate_area(self) -> Self:
        """Require one area for the raster calculation.

        Returns:
            This request with one explicit area.
        Raises:
            ValueError: If the request omits the area or supplies more than one.
        """
        areas = (
            self.selectedBounds,
            self.samplingBox,
            self.catalogSelection,
            self.polygonArea,
        )
        if sum(area is not None for area in areas) != 1:
            raise ValueError("Choose one box or polygon selection.")
        return self


class QueuedRasterCalculator(RasterCalculatorSchema):
    """Retain the selected calculator inputs and any owned drawing at admission."""

    operation: Literal["raster.calculator.v1"] = OPERATION
    request: RasterCalculatorRequest
    polygonArea: AggregateArea | None

    @model_validator(mode="after")
    def validate_polygon_copy(self) -> Self:
        """Verify that saved drawing geometry matches the authorized reference.

        Returns:
            The checked queued work.
        Raises:
            ValueError: If its drawing is absent, unexpected, or has a different digest.
        """
        reference = self.request.polygonArea
        snapshot = self.polygonArea
        if reference is None and snapshot is None:
            return self
        if (
            reference is None
            or snapshot is None
            or snapshot.kind != "polygons"
            or snapshot.geometryHash != reference.sha256
        ):
            raise ValueError("Saved polygons do not match the selected drawing.")
        return self


class RasterCalculatorSpec(RasterCalculatorSchema):
    """Retain the verified grid and selected inputs for a recoverable worker run."""

    operation: Literal["raster.calculator.v1"] = OPERATION
    inputs: RasterCalculatorRequest
    polygonArea: AggregateArea | None
    grid: RasterResultGrid


class RasterCalculatorPolicy(RasterCalculatorSchema):
    """Explain the calculation's fixed value, mask and coverage rules in Run YAML."""

    valueDomain: Literal["stored_band_values"] = "stored_band_values"
    polygonInclusion: Literal["cell_center"] = "cell_center"
    missingValues: Literal["all_referenced_inputs_and_arithmetic_must_be_valid"] = (
        "all_referenced_inputs_and_arithmetic_must_be_valid"
    )
