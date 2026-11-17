"""Validate portable Catalog and drawing views independently of their storage owner."""

import json
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    StringConstraints,
    field_validator,
    model_validator,
)

from eolab_app.attribute_filter import VectorFilter, validate_filter
from eolab_app.calculated_fields import CalculatedField

MAX_APPEARANCE_DEFINITION_BYTES = 65_536
Title = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)
]
CatalogIdentity = Annotated[str, StringConstraints(min_length=1, max_length=512)]


class MapDocumentPart(BaseModel):
    """Reject unknown fields and coercion in the portable layer document structure."""

    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class MapCatalogItem(MapDocumentPart):
    """Catalog identifiers for one layer, never a source filesystem path."""

    collection: CatalogIdentity
    id: CatalogIdentity


def validate_appearance_definition_size(definition: dict[str, JsonValue]) -> None:
    """Reject a saved style definition larger than 65,536 UTF-8 bytes.

    Args:
        definition: Raster or vector style settings stored with a saved map.

    Raises:
        ValueError: If serialized content exceeds 65,536 UTF-8 bytes.
    """

    serialized = json.dumps(
        definition, ensure_ascii=False, allow_nan=False, separators=(",", ":")
    )
    if len(serialized.encode("utf-8")) > MAX_APPEARANCE_DEFINITION_BYTES:
        raise ValueError("Saved appearance definition exceeds 65,536 UTF-8 bytes.")


class MapRasterContinuousAppearance(MapDocumentPart):
    """Continuous raster style settings stored with a saved map.

    Attributes:
        definition: Continuous style settings, validated when the raster is restored.
        paletteName: Name of the raster's color palette.
        styleWasEdited: Whether automatic initial styling may replace the range.
    """

    definition: dict[str, JsonValue]
    paletteName: Annotated[str, StringConstraints(min_length=1, max_length=100)]
    styleWasEdited: bool

    @field_validator("definition")
    @classmethod
    def validate_continuous_style_size(
        cls, definition: dict[str, JsonValue]
    ) -> dict[str, JsonValue]:
        """Reject continuous style settings that exceed the saved-map size limit.

        Args:
            definition: Opaque continuous style JSON.

        Returns:
            The unchanged definition.

        Raises:
            ValueError: If serialized content exceeds 65,536 UTF-8 bytes.
        """
        validate_appearance_definition_size(definition)
        return definition


class MapRasterStyle(MapDocumentPart):
    """Saved raster styling in the version-one appearance format.

    Both definitions survive a mode change; raster styling code validates the
    settings when restoring a layer.

    Attributes:
        kind: Raster layer appearance discriminator.
        appearanceVersion: Version of the dual-configuration appearance.
        mode: Active retained configuration.
        continuous: Retained continuous definition and editing state.
        categorical: Retained category definition, null before configuration.
    """

    kind: Literal["raster"]
    appearanceVersion: Annotated[int, Field(strict=True, ge=1, le=1)]
    mode: Literal["continuous", "categorical"]
    continuous: MapRasterContinuousAppearance
    categorical: dict[str, JsonValue] | None

    @model_validator(mode="after")
    def validate_appearance_format(self) -> Self:
        """Check retained category size and require a table for categorical mode.

        Returns:
            The unchanged version-one raster style.

        Raises:
            ValueError: If categorical mode has no category table or its
                definition exceeds the portable appearance limit.
        """
        if self.categorical is not None:
            validate_appearance_definition_size(self.categorical)
        elif self.mode == "categorical":
            raise ValueError("Categorical mode requires a category table.")
        return self


class MapVectorStyle(MapDocumentPart):
    """Vector style JSON whose meaning is validated by vector styling on restore."""

    kind: Literal["vector"]
    definition: dict[str, JsonValue]


class MapStyledLayer(MapDocumentPart):
    """Saved appearance and filtering shared by catalog and uploaded layers.

    customName is presentation text; it never replaces the source identity or
    source metadata. Omitted or null means to display the original source name.
    Omitted legendIncluded means to include a visible layer in the map legend.
    isCustom records the card presentation without changing its source or access.
    When omitted, the browser uses the source owner's ordinary presentation.
    calculatedFields preserves ordered numeric definitions independently of style;
    source access and field bindings are revalidated before restoring the view.
    """

    customName: Title | None = None
    isCustom: bool = False
    visible: bool
    legendIncluded: bool = True
    opacity: Annotated[float, Field(ge=0, le=1)]
    style: Annotated[MapRasterStyle | MapVectorStyle, Field(discriminator="kind")]
    filter: dict[str, JsonValue] | None = None
    calculatedFields: Annotated[list[CalculatedField], Field(max_length=64)] | None = (
        None
    )

    @model_validator(mode="after")
    def validate_optional_filter(self) -> Self:
        """Validate optional filters and view-owned numeric definitions.

        Returns:
            This layer with a bounded filter and unique vector field definitions.

        Raises:
            ValueError: If a filter is null or oversized, or calculated fields
                are missing, duplicated or attached to a raster.
        """
        if "filter" in self.model_fields_set:
            if self.filter is None:
                raise ValueError("A layer filter must be an object when supplied.")
            serialized = json.dumps(
                self.filter, ensure_ascii=False, separators=(",", ":")
            )
            if len(serialized.encode("utf-16-le")) // 2 > 8192:
                raise ValueError("A layer filter must fit within 8,192 characters.")
        if "calculatedFields" in self.model_fields_set:
            if self.calculatedFields is None or self.style.kind != "vector":
                raise ValueError(
                    "Calculated fields require a vector layer and a definition list."
                )
            names = [field.name for field in self.calculatedFields]
            if len(set(names)) != len(names):
                raise ValueError("Calculated field names must be unique within a view.")
        return self


class MapLayer(MapStyledLayer):
    """One map view of a Catalog item, with its own style and filter."""

    catalogItem: MapCatalogItem


class MapDrawingAppearance(MapDocumentPart):
    """Retain a drawn layer's polygon styling independently of its source."""

    color: Annotated[str, Field(pattern=r"^#[0-9A-Fa-f]{6}$")]
    outline: Annotated[str, Field(pattern=r"^#[0-9A-Fa-f]{6}$")]
    weight: Annotated[float, Field(ge=0, le=10)]
    fillOpacity: Annotated[float, Field(ge=0, le=1)]
    labels: bool


class MapDrawingLayer(MapDocumentPart):
    """Reference a live drawing source with view-local appearance and filters.

    The opaque drawingLayerId permits reading the latest saved polygons, never
    editing the source. The document retains no geometry or source revision.
    Repeated references represent independent views of the same source.
    Omitted filter leaves every polygon visible; omitted legendIncluded includes
    the visible drawing in the map legend.
    """

    drawingLayerId: Annotated[UUID, Field(strict=False)]
    isCustom: Literal[True] = True
    customName: Title | None = None
    visible: bool
    legendIncluded: bool = True
    opacity: Annotated[float, Field(ge=0, le=1)]
    appearance: MapDrawingAppearance
    filter: VectorFilter = Field(default_factory=VectorFilter)

    @model_validator(mode="after")
    def validate_drawing_filter(self) -> Self:
        """Require the name and note attributes supplied by drawing sources.

        Returns:
            This view with a valid drawing attribute filter.

        Raises:
            ValueError: A rule does not match the source's text attributes.
        """
        validate_filter(self.filter, {"name": "str", "note": "str"})
        return self
