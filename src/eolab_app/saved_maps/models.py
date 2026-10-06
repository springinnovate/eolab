"""Validate named maps, catalog layers and live shared-annotation references."""

import json
from datetime import datetime, timezone
from typing import Annotated, Literal, Self

from pydantic import (
    AnyHttpUrl,
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    StringConstraints,
    TypeAdapter,
    field_validator,
    model_validator,
)

MAX_VIEW_BYTES = 512 * 1024
MAX_REQUEST_BYTES = MAX_VIEW_BYTES + 4096
MAX_APPEARANCE_DEFINITION_BYTES = 65_536
Slug = Annotated[
    str,
    StringConstraints(
        min_length=1, max_length=80, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$"
    ),
]
Title = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)
]
CatalogIdentity = Annotated[str, StringConstraints(min_length=1, max_length=512)]


class MapDocumentPart(BaseModel):
    """Reject unknown fields and coercion in the saved-map document structure."""

    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class MapViewer(MapDocumentPart):
    """Identify the application version and site that exported the map."""

    version: Annotated[str, StringConstraints(min_length=1, max_length=100)]
    origin: Annotated[str, StringConstraints(min_length=1, max_length=2048)]

    @field_validator("origin")
    @classmethod
    def validate_site_origin(cls, value: str) -> str:
        """Accept an HTTP origin without a path, credentials or query string.

        Args:
            value: Site origin recorded in the map document.

        Returns:
            The unchanged, canonical origin.

        Raises:
            ValueError: If the value is not an HTTP or HTTPS origin.
        """
        parsed = TypeAdapter(AnyHttpUrl).validate_python(value)
        if (
            parsed.username
            or parsed.password
            or parsed.path != "/"
            or parsed.query is not None
            or parsed.fragment is not None
            or str(parsed).removesuffix("/") != value
        ):
            raise ValueError("Viewer origin must be an HTTP origin without a path.")
        return value


class MapCenter(MapDocumentPart):
    """Map center in longitude and latitude degrees."""

    latitude: Annotated[float, Field(ge=-90, le=90)]
    longitude: Annotated[float, Field(ge=-180, le=180)]


class MapViewport(MapDocumentPart):
    """Initial map center and zoom level."""

    center: MapCenter
    zoom: Annotated[float, Field(ge=0, le=22)]


class MapCatalogItem(MapDocumentPart):
    """Catalog identifiers for one layer, never a source filesystem path."""

    collection: CatalogIdentity
    id: CatalogIdentity


def validate_appearance_definition_size(definition: dict[str, JsonValue]) -> None:
    """Bound an opaque appearance definition without interpreting its semantics.

    Args:
        definition: Owner-specific JSON object from a portable appearance.

    Raises:
        ValueError: If serialized content exceeds 65,536 UTF-8 bytes.
    """
    serialized = json.dumps(
        definition, ensure_ascii=False, allow_nan=False, separators=(",", ":")
    )
    if len(serialized.encode("utf-8")) > MAX_APPEARANCE_DEFINITION_BYTES:
        raise ValueError("Saved appearance definition exceeds 65,536 UTF-8 bytes.")


class MapRasterContinuousAppearance(MapDocumentPart):
    """Retained continuous configuration whose definition stays raster-owned.

    Attributes:
        definition: Bounded opaque continuous style definition.
        paletteName: Raster-owned palette identifier.
        styleWasEdited: Whether automatic initial styling may replace the range.
    """

    definition: dict[str, JsonValue]
    paletteName: Annotated[str, StringConstraints(min_length=1, max_length=100)]
    styleWasEdited: bool

    @field_validator("definition")
    @classmethod
    def require_bounded_definition(
        cls, definition: dict[str, JsonValue]
    ) -> dict[str, JsonValue]:
        """Keep a retained definition within the portable appearance limit.

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
    """Legacy or versioned raster appearance, with owner-validated definitions.

    A legacy envelope contains only kind, definition, and paletteName. Version
    one contains only kind, appearanceVersion, mode, continuous, and categorical.
    Both definitions survive a mode change; the raster owner validates their
    meaning when restoring a layer. Legacy content is preserved for migration.

    Attributes:
        kind: Raster layer appearance discriminator.
        definition: Legacy opaque continuous definition.
        paletteName: Legacy opaque palette value.
        appearanceVersion: Version of the dual-configuration appearance.
        mode: Active retained configuration.
        continuous: Retained continuous definition and editing state.
        categorical: Retained category definition, absent before configuration.
    """

    kind: Literal["raster"]
    definition: dict[str, JsonValue] | None = None
    paletteName: JsonValue = None
    appearanceVersion: Annotated[int, Field(strict=True, ge=1, le=1)] | None = None
    mode: Literal["continuous", "categorical"] | None = None
    continuous: MapRasterContinuousAppearance | None = None
    categorical: dict[str, JsonValue] | None = None

    @model_validator(mode="after")
    def require_complete_appearance_envelope(self) -> Self:
        """Reject mixed envelopes and preserve the storage/appearance boundary.

        Returns:
            This unchanged legacy or versioned appearance envelope.

        Raises:
            ValueError: If fields are missing, modes conflict, or a definition
                exceeds the portable appearance limit.
        """
        if "appearanceVersion" not in self.model_fields_set:
            if self.model_fields_set != {"kind", "definition", "paletteName"}:
                raise ValueError("Legacy raster appearance has unsupported fields.")
            if self.definition is None:
                raise ValueError("Legacy raster definition must be an object.")
            return self
        if self.model_fields_set != {
            "kind",
            "appearanceVersion",
            "mode",
            "continuous",
            "categorical",
        }:
            raise ValueError(
                "Raster appearance contains missing or unsupported fields."
            )
        if self.appearanceVersion != 1 or self.mode is None or self.continuous is None:
            raise ValueError(
                "Raster appearance version, mode, and continuous state are required."
            )
        if self.categorical is not None:
            validate_appearance_definition_size(self.categorical)
        elif self.mode == "categorical":
            raise ValueError("Categorical mode requires a category table.")
        return self


class MapVectorStyle(MapDocumentPart):
    """Vector style JSON whose meaning is validated by vector styling on restore."""

    kind: Literal["vector"]
    definition: dict[str, JsonValue]


class MapLayer(MapDocumentPart):
    """Catalog reference and map appearance, including name and legend inclusion.

    customName is presentation text; it never replaces the catalog identity or
    source metadata. Omitted or null means to display the original source name.
    Omitted legendIncluded means to include a visible layer in the map legend.
    """

    catalogItem: MapCatalogItem
    customName: Title | None = None
    sourceRevision: Annotated[str, Field(pattern=r"^sha256:[0-9a-f]{64}$")] | None
    visible: bool
    legendIncluded: bool = True
    opacity: Annotated[float, Field(ge=0, le=1)]
    style: Annotated[MapRasterStyle | MapVectorStyle, Field(discriminator="kind")]
    filter: dict[str, JsonValue] | None = None

    @model_validator(mode="after")
    def validate_optional_filter(self) -> Self:
        """Match the browser's optional-object and 8,192-character filter limit.

        Returns:
            This layer if its filter is absent or a bounded JSON object.

        Raises:
            ValueError: If an explicit filter is null or exceeds the limit.
        """
        if "filter" in self.model_fields_set:
            if self.filter is None:
                raise ValueError("A layer filter must be an object when supplied.")
            serialized = json.dumps(
                self.filter, ensure_ascii=False, separators=(",", ":")
            )
            if len(serialized.encode("utf-16-le")) // 2 > 8192:
                raise ValueError("A layer filter must fit within 8,192 characters.")
        return self


class MapAnnotationReference(MapDocumentPart):
    """Same-site invitation to a live shared layer; contains no edit credentials."""

    id: Annotated[
        str,
        Field(
            pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
        ),
    ]
    joinCode: Annotated[str, Field(pattern=r"^[A-Z2-9]{8}$")]


class MapAnnotationAppearance(MapDocumentPart):
    """Viewer-local appearance; contributor colors remain owned by the live layer."""

    outline: Annotated[str, Field(pattern=r"^#[0-9A-Fa-f]{6}$")]
    weight: Annotated[float, Field(ge=0, le=10)]
    fillOpacity: Annotated[float, Field(ge=0, le=1)]
    labels: bool
    notes: bool


class MapAnnotationLayer(MapDocumentPart):
    """Live layer invitation, appearance and legend inclusion, without polygons.

    Omitted legendIncluded includes the visible layer in the map legend. These
    preferences do not change a contributor's polygons or shared colors.
    """

    sharedAnnotation: MapAnnotationReference
    visible: bool
    legendIncluded: bool = True
    opacity: Annotated[float, Field(ge=0, le=1)]
    appearance: MapAnnotationAppearance


class MapLegendAppearance(MapDocumentPart):
    """Whether the on-map legend is shown and whether its contents are collapsed."""

    visible: bool
    collapsed: bool


class SavedMapView(MapDocumentPart):
    """Portable map JSON with optional legend visibility and collapse preferences.

    Version three includes a basemap provider. Older maps without mapLegend
    open with the legend visible and expanded.
    """

    format: Literal["eolab-map-view"]
    schemaVersion: Annotated[int, Field(ge=1, le=3)]
    viewer: MapViewer
    createdAt: str
    viewport: MapViewport
    basemap: Literal["detailed", "carto", "maptiler", "outlines", "none"] | None = None
    mapLegend: MapLegendAppearance | None = None
    layers: Annotated[list[MapLayer | MapAnnotationLayer], Field(max_length=50)]

    @field_validator("createdAt")
    @classmethod
    def normalize_creation_time(cls, value: str) -> str:
        """Normalize an ISO date to the UTC timestamp exported by the browser.

        Args:
            value: Date when the map configuration was captured.

        Returns:
            UTC timestamp with millisecond precision.

        Raises:
            ValueError: If the date is invalid or lacks a timezone.
        """
        date = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if date.tzinfo is None:
            raise ValueError("Map creation time must include a timezone.")
        return (
            date.astimezone(timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )

    @model_validator(mode="after")
    def validate_layer_uniqueness_and_size(self) -> Self:
        """Reject inconsistent versions, repeated layers and oversized maps.

        Returns:
            This map if it fits the saved-map format.

        Raises:
            ValueError: If fields do not match the schema version, a layer repeats,
                or the document exceeds the size limit.
        """
        if self.schemaVersion == 3:
            if self.basemap is None:
                raise ValueError("Saved-map version three requires a basemap provider.")
        elif "basemap" in self.model_fields_set:
            raise ValueError("Basemap selection requires saved-map version three.")
        if "mapLegend" in self.model_fields_set and self.mapLegend is None:
            raise ValueError("Map legend preferences must be an object when supplied.")
        identities = []
        for layer in self.layers:
            if isinstance(layer, MapAnnotationLayer):
                if self.schemaVersion == 1:
                    raise ValueError(
                        "Shared annotations require saved-map version two."
                    )
                identities.append(("annotation", layer.sharedAnnotation.id))
            else:
                identities.append(
                    ("catalog", layer.catalogItem.collection, layer.catalogItem.id)
                )
        if len(set(identities)) != len(identities):
            raise ValueError("A saved map cannot contain duplicate layers.")
        if (
            len(self.model_dump_json(exclude_unset=True).encode("utf-8"))
            > MAX_VIEW_BYTES
        ):
            raise ValueError("A saved map must fit within 512 KiB.")
        return self


class CreateSavedMap(MapDocumentPart):
    """Title, optional subtitle, URL name and map settings to save on this site."""

    title: Title
    subtitle: Annotated[
        str, StringConstraints(strip_whitespace=True, max_length=240)
    ] = ""
    slug: Slug
    view: SavedMapView


class SavedMap(CreateSavedMap):
    """Stored map with its creation time and revision for administrator updates."""

    createdAt: datetime
    revision: Annotated[int, Field(ge=1, strict=True)] = 1


class UpdateSavedMap(CreateSavedMap):
    """Replacement map configuration and the revision opened by the administrator."""

    revision: Annotated[int, Field(ge=1, strict=True)]


class SavedMapError(Exception):
    """An actionable saved-map error safe to return through the HTTP API."""

    def __init__(self, status: int, message: str) -> None:
        """Record the response status and explanation.

        Args:
            status: HTTP error status.
            message: User-facing explanation without database internals.
        """
        super().__init__(message)
        self.status = status
