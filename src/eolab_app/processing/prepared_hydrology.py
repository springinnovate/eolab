"""Configure the catalog sources and watershed topology used by downstream models."""

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from eolab_app.catalog.vector_contract import CatalogVectorRequest
from eolab_app.raster.models import CatalogRasterRequest

FieldName = Annotated[str, Field(strict=True, min_length=1, max_length=128)]
NetworkId = (
    Annotated[int, Field(strict=True)]
    | Annotated[str, Field(strict=True, min_length=1, max_length=128)]
)


class HydrologySchema(BaseModel):
    """Immutable hydrology settings that reject misspelled or unsupported fields."""

    model_config = ConfigDict(
        extra="forbid", frozen=True, populate_by_name=True, allow_inf_nan=False
    )


class HydrologyRaster(CatalogRasterRequest):
    """An immutable catalog identity for the prepared elevation raster."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class HydrologyWatersheds(CatalogVectorRequest):
    """An immutable catalog identity for the complete watershed network."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class NetworkTermination(HydrologySchema):
    """Identify a terminal watershed by matching a constant or another field.

    For HydroBASINS this is typically NEXT_DOWN equal to integer zero. String,
    integer and Boolean terminal flags are supported without coercion. Setting
    ``equalsField: HYBAS_ID`` with ``field: NEXT_SINK`` instead stops at the next
    real sink, including endorheic sinks with virtual downstream links.
    """

    field: FieldName
    value: NetworkId | Annotated[bool, Field(strict=True)] | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    equalsField: FieldName | None = Field(
        default=None, exclude_if=lambda value: value is None
    )

    @model_validator(mode="after")
    def check_comparison(self) -> Self:
        """Require exactly one comparison and reject self-comparison.

        Returns:
            This terminal rule with an unambiguous comparison.

        Raises:
            ValueError: If neither or both comparisons are supplied, or fields match.
        """
        if (self.value is None) == (self.equalsField is None):
            raise ValueError("Choose a terminal value or equalsField")
        if self.equalsField == self.field:
            raise ValueError("Terminal comparison requires two different fields")
        return self


class WatershedTopology(HydrologySchema):
    """Map watershed IDs, downstream links and optional terminal drainage IDs.

    All IDs use the declared type. When terminalIdField is supplied, its value
    must equal the feature ID of the terminal reached by following downstream links.
    """

    idField: FieldName
    downstreamField: FieldName
    idType: Literal["integer", "string"]
    terminal: NetworkTermination
    terminalIdField: FieldName | None = None

    @model_validator(mode="after")
    def check_distinct_fields(self) -> Self:
        """Require distinct identity and downstream fields.

        Returns:
            This mapping after checking that links can identify another feature.

        Raises:
            ValueError: If identity and downstream fields coincide.
        """
        if self.idField == self.downstreamField:
            raise ValueError("Feature ID and next-downstream ID need different fields")
        return self


class HydrologySources(HydrologySchema):
    """Configure the DEM, watershed layer and field mappings used by a model.

    These catalog identities belong to Model YAML. They do not certify source
    suitability or pin files to a historical registration. Each run resolves
    the current catalog sources and keeps them unchanged while calculating.
    """

    dem: HydrologyRaster
    watersheds: HydrologyWatersheds
    topology: WatershedTopology
