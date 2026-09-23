"""Validate names and polygon contributions sent to an annotation session."""

import json
from datetime import datetime
from uuid import UUID
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from shapely.geometry import Polygon

MAX_LAYER_BYTES = 8 * 1024 * 1024
Name = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)
]
Coordinate = tuple[
    Annotated[float, Field(ge=-180, le=180, allow_inf_nan=False, strict=True)],
    Annotated[
        float, Field(ge=-85.05112878, le=85.05112878, allow_inf_nan=False, strict=True)
    ],
]


class SessionInput(BaseModel):
    """Reject unknown fields in the session API's request documents."""

    model_config = ConfigDict(extra="forbid")


class CreateSession(SessionInput):
    """Name a new annotation session and its first contributor."""

    name: Name
    contributorName: Name


class JoinSession(SessionInput):
    """Join an existing session using its invitation code and a display name."""

    joinCode: Annotated[
        str,
        StringConstraints(
            to_upper=True, strip_whitespace=True, pattern=r"(?i)^[A-Z2-9]{8}$"
        ),
    ]
    contributorName: Name


class ContributorProfile(SessionInput):
    """The current member's display name; identity and ownership are unchanged."""

    name: Name


class ContributorColor(SessionInput):
    """This browser's polygon fill color in one shared layer; any RGB color is allowed."""

    color: Annotated[str, StringConstraints(pattern=r"^#[0-9A-Fa-f]{6}$")]


class PolygonGeometry(SessionInput):
    """One valid, closed polygon without holes, in editable longitude/latitude."""

    type: Literal["Polygon"] = "Polygon"
    coordinates: Annotated[
        list[Annotated[list[Coordinate], Field(min_length=4, max_length=2001)]],
        Field(min_length=1, max_length=1),
    ]

    @model_validator(mode="after")
    def validate_polygon(self) -> Self:
        """Reject open, self-crossing, or zero-area polygon rings.

        Returns:
            This geometry when the exterior ring is usable by the editor.

        Raises:
            ValueError: If the ring does not describe a valid polygon.
        """
        ring = self.coordinates[0]
        if ring[0] != ring[-1]:
            raise ValueError("The polygon ring must end at its starting coordinate.")
        polygon = Polygon(ring)
        if not polygon.is_valid or polygon.area == 0:
            raise ValueError(
                "The polygon must have at least three distinct vertices and must not cross itself."
            )
        return self


class PolygonProperties(SessionInput):
    """Plain-text label and note supplied by the contributor."""

    name: Name
    note: str = Field(default="", max_length=10000)


class AnnotationFeature(SessionInput):
    """A polygon with its label and note; server ownership is stored separately."""

    type: Literal["Feature"] = "Feature"
    id: str | None = Field(default=None, max_length=100)
    geometry: PolygonGeometry
    properties: PolygonProperties


class AnnotationCollection(SessionInput):
    """All committed polygons from one annotation layer, including hidden ones."""

    type: Literal["FeatureCollection"] = "FeatureCollection"
    name: Name
    features: list[AnnotationFeature] = Field(max_length=500)


class ShareLayer(SessionInput):
    """Replace a shared layer only if its revision still matches the caller's copy."""

    revision: int = Field(ge=0)
    collection: AnnotationCollection

    @model_validator(mode="after")
    def limit_layer_size(self) -> Self:
        """Bound the serialized contribution before storage.

        Returns:
            The request when its GeoJSON fits the layer limit.

        Raises:
            ValueError: If its serialized GeoJSON exceeds 8 MiB.
        """
        if len(json.dumps(self.collection.model_dump()).encode()) > MAX_LAYER_BYTES:
            raise ValueError("A shared annotation layer must fit within 8 MiB.")
        return self


class SessionError(Exception):
    """An actionable annotation-session failure safe to display in the browser."""

    def __init__(self, status: int, message: str) -> None:
        """Attach an HTTP status to a user-facing explanation.

        Args:
            status: HTTP error status.
            message: Explanation that contains no credentials or database details.
        """
        super().__init__(message)
        self.status = status


class SessionSummary(SessionInput):
    """A shared annotation layer this browser can reopen."""

    id: UUID
    name: str
    joinCode: str


class ContributorSummary(SessionInput):
    """Public contributor identity; private browser credentials are never included."""

    id: UUID
    name: str
    color: Annotated[str, StringConstraints(pattern=r"^#[0-9A-Fa-f]{6}$")]


class SharedLayerSummary(SessionInput):
    """Small contribution metadata used to decide whether its polygons need fetching."""

    contributorId: UUID
    layerId: UUID
    revision: int
    updatedAt: datetime
    name: str
    polygonCount: int


class SessionSnapshot(SessionSummary):
    """Current session membership and layer revisions, excluding polygon bodies."""

    contributorId: UUID
    contributors: list[ContributorSummary]
    layers: list[SharedLayerSummary]


class SharedLayerContents(SessionInput):
    """One shared GeoJSON collection with the revision required for subsequent writes."""

    collection: AnnotationCollection
    revision: int
