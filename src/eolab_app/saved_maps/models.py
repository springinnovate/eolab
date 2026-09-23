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


class MapRasterStyle(MapDocumentPart):
    """Raster style JSON whose meaning is validated by raster styling on restore."""

    kind: Literal["raster"]
    definition: dict[str, JsonValue]
    paletteName: JsonValue


class MapVectorStyle(MapDocumentPart):
    """Vector style JSON whose meaning is validated by vector styling on restore."""

    kind: Literal["vector"]
    definition: dict[str, JsonValue]


class MapLayer(MapDocumentPart):
    """Catalog reference, visibility, style and optional filter for one map layer."""

    catalogItem: MapCatalogItem
    sourceRevision: Annotated[str, Field(pattern=r"^sha256:[0-9a-f]{64}$")] | None
    visible: bool
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
    """Live layer invitation and local appearance, without polygons or membership."""

    sharedAnnotation: MapAnnotationReference
    visible: bool
    opacity: Annotated[float, Field(ge=0, le=1)]
    appearance: MapAnnotationAppearance


class SavedMapView(MapDocumentPart):
    """Portable map JSON; version two also permits live annotation references."""

    format: Literal["eolab-map-view"]
    schemaVersion: Annotated[int, Field(ge=1, le=2)]
    viewer: MapViewer
    createdAt: str
    viewport: MapViewport
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
        """Reject repeated layers, version-one annotation references and oversized maps.

        Returns:
            This map if it fits the saved-map format.

        Raises:
            ValueError: If a layer repeats, needs version two or exceeds the size limit.
        """
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
    """Title, URL name and map configuration to save permanently on this site."""

    title: Title
    slug: Slug
    view: SavedMapView


class SavedMap(CreateSavedMap):
    """Stored map with its database creation time; the view is never overwritten."""

    createdAt: datetime


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
