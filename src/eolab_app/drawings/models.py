"""Describe linked drawing sources with stable polygon IDs and explicit revisions."""

from datetime import datetime
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from eolab_app.editable_polygon import PolygonGeometry

MAX_DRAWING_BYTES = 8 * 1024 * 1024
MAX_REQUEST_BYTES = MAX_DRAWING_BYTES + 4096
DrawingName = Annotated[
    str,
    StringConstraints(strict=True, min_length=1, max_length=160, pattern=r"\S"),
]
"""Nonblank source or polygon label, preserving imported surrounding whitespace."""
DrawingIdentifier = Annotated[
    str, StringConstraints(strict=True, pattern=r"^[a-zA-Z0-9-]{1,100}$")
]
"""Original editor identity retained across geometry, label and ordering changes."""
DrawingRevision = Annotated[int, Field(strict=True, ge=1)]
"""Positive acknowledged source revision required for optimistic updates."""


class DrawingDocumentPart(BaseModel):
    """Reject unknown fields and nonfinite numbers in source documents."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class DrawingProperties(DrawingDocumentPart):
    """Retain a polygon's editable name and note as plain text."""

    name: DrawingName
    note: Annotated[str, StringConstraints(strict=True, max_length=10000)] = ""


class DrawingFeature(DrawingDocumentPart):
    """Identify one drawn polygon independently of its position, name or geometry.

    Editing a polygon preserves its ID. New polygons receive new IDs; removed
    polygons disappear from the current source without reassigning their IDs.
    """

    type: Literal["Feature"] = "Feature"
    id: DrawingIdentifier
    geometry: PolygonGeometry
    properties: DrawingProperties


class DrawingCollection(DrawingDocumentPart):
    """Store all committed polygons, including ones hidden by map-view filters.

    The source contains no appearance or filter settings. Its original IDs remain
    unique across the whole collection and never depend on feature order.
    """

    type: Literal["FeatureCollection"] = "FeatureCollection"
    name: DrawingName
    features: Annotated[list[DrawingFeature], Field(max_length=500)]

    @model_validator(mode="after")
    def validate_source(self) -> Self:
        """Require unique IDs and a source document no larger than eight MiB.

        Returns:
            This validated full-source collection.

        Raises:
            ValueError: Polygon IDs repeat or serialized source data exceeds eight MiB.
        """
        identifiers = [feature.id for feature in self.features]
        if len(set(identifiers)) != len(identifiers):
            raise ValueError("Drawing polygon IDs must be unique across the layer.")
        if len(self.model_dump_json().encode("utf-8")) > MAX_DRAWING_BYTES:
            raise ValueError("A drawing layer must fit within 8 MiB.")
        return self


class CreateDrawingLayer(DrawingDocumentPart):
    """Create a linked source once for a browser's existing local drawing layer.

    Retrying the same local ID and collection returns the existing source.
    A different collection under that local ID requires a revision-checked update.
    """

    localLayerId: DrawingIdentifier
    collection: DrawingCollection


class UpdateDrawingLayer(DrawingDocumentPart):
    """Replace the complete source only at the last acknowledged revision."""

    expectedRevision: DrawingRevision
    collection: DrawingCollection


class DrawingLayer(DrawingDocumentPart):
    """Return a linked source and this browser's authority to edit it.

    The opaque ID permits reading the source. It never grants write access;
    canEdit is derived from the current browser's private ownership cookie.
    """

    id: UUID
    revision: DrawingRevision
    collection: DrawingCollection
    canEdit: bool
    createdAt: datetime
    updatedAt: datetime


class DrawingLayerSummary(DrawingDocumentPart):
    """List an owner's source identities without transferring polygon bodies."""

    id: UUID
    localLayerId: DrawingIdentifier
    name: DrawingName
    revision: DrawingRevision
    createdAt: datetime
    updatedAt: datetime


class DrawingError(Exception):
    """Carry a drawing-source error safe to show without exposing storage details."""

    def __init__(self, status: int, message: str) -> None:
        """Attach an HTTP-equivalent status and actionable message.

        Args:
            status: Public error status.
            message: Explanation without database details or private owner identity.
        """
        super().__init__(message)
        self.status = status
