"""Validate durable Planning roles, original parcel IDs and intervention choices."""

from datetime import datetime
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StringConstraints,
    model_validator,
)

from eolab_app.attribute_filter import VectorFilter, validate_filter
from eolab_app.map_layer_documents import MapLayer, Title
from eolab_app.vector.filters import CatalogVectorFilterRequest
from eolab_app.vector.parcel_models import ParcelField

MAX_TOOL_BYTES = 512 * 1024
MAX_REQUEST_BYTES = MAX_TOOL_BYTES + 4096


class PlanningDocumentPart(BaseModel):
    """Reject unknown Planning fields and nonfinite numeric values."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class PlanningDrawingAppearance(PlanningDocumentPart):
    """Retain a drawn layer's ordinary polygon styling independently of its source."""

    color: Annotated[str, Field(pattern=r"^#[0-9A-Fa-f]{6}$")]
    outline: Annotated[str, Field(pattern=r"^#[0-9A-Fa-f]{6}$")]
    weight: Annotated[float, Field(strict=True, ge=0, le=10)]
    fillOpacity: Annotated[float, Field(strict=True, ge=0, le=1)]
    labels: StrictBool


class PlanningDrawingView(PlanningDocumentPart):
    """Reference a live drawing source with view-local appearance and filters.

    The opaque drawingLayerId permits reading the latest saved polygons, never
    editing the source. No geometry or source revision is captured in the tool.
    """

    drawingLayerId: UUID
    isCustom: Literal[True] = True
    customName: Title | None = None
    visible: StrictBool
    legendIncluded: StrictBool = True
    opacity: Annotated[float, Field(strict=True, ge=0, le=1)]
    appearance: PlanningDrawingAppearance
    filter: VectorFilter = Field(default_factory=VectorFilter)

    @model_validator(mode="after")
    def validate_drawing_filter(self) -> Self:
        """Require the ordinary name/note filter fields supplied by drawings.

        Returns:
            This view with an admitted ordinary annotation filter.

        Raises:
            ValueError: A rule does not match the source's text attributes.
        """
        validate_filter(self.filter, {"name": "str", "note": "str"})
        return self


class PlanningLayer(PlanningDocumentPart):
    """Bind a durable UUID to an ordinary Catalog or drawn polygon view.

    The UUID identifies this stored definition, never a browser map row. The
    definition retains ordinary appearance, filters and calculated fields.
    """

    id: UUID
    definition: MapLayer | PlanningDrawingView

    @model_validator(mode="after")
    def validate_custom_polygon_view(self) -> Self:
        """Require a custom polygon view and validate its source-specific filter.

        Returns:
            This layer; its source owner checks polygon/schema eligibility later.

        Raises:
            ValueError: The view is not custom/vector or its source/filter is invalid.
        """
        if isinstance(self.definition, PlanningDrawingView):
            return self
        if not self.definition.isCustom or self.definition.style.kind != "vector":
            raise ValueError("Choose a custom Catalog polygon layer for Planning")
        self.to_selection_request()
        return self

    def source_identity(self) -> tuple[str, ...]:
        """Identify the original source independently of its map view and filter.

        Returns:
            Source kind plus its opaque drawing ID or Catalog collection/item IDs.
        """
        if isinstance(self.definition, PlanningDrawingView):
            return ("drawing", str(self.definition.drawingLayerId))
        return (
            "catalog",
            self.definition.catalogItem.collection,
            self.definition.catalogItem.id,
        )

    def to_selection_request(self) -> CatalogVectorFilterRequest:
        """Return Catalog identity and this view's live filter for authorization.

        Returns:
            Path-free vector request retaining ordered calculated-field definitions.

        Raises:
            ValueError: This is a drawing view or its Catalog filter is incompatible.
        """
        if isinstance(self.definition, PlanningDrawingView):
            raise ValueError("Drawn layers use their drawing source reference")
        return CatalogVectorFilterRequest(
            collectionId=self.definition.catalogItem.collection,
            itemId=self.definition.catalogItem.id,
            filter=VectorFilter.model_validate(self.definition.filter or {}),
            calculatedFields=tuple(self.definition.calculatedFields or ()),
        )


class PlanningIntervention(PlanningDocumentPart):
    """Name an allowed intervention without assigning parcels or model parameters."""

    id: UUID
    label: Annotated[
        str,
        StringConstraints(
            strict=True, strip_whitespace=True, min_length=1, max_length=160
        ),
    ]


class PlanningToolDocument(PlanningDocumentPart):
    """Define durable AOI/parcel roles and allowed intervention names.

    One or two stored layer definitions are referenced by the roles; both roles
    may share a definition. No geometry or runtime map keys are retained.
    """

    title: Title
    layers: Annotated[list[PlanningLayer], Field(min_length=1, max_length=2)]
    aoiLayerId: UUID
    parcelLayerId: UUID
    parcelIdField: ParcelField
    interventions: Annotated[
        list[PlanningIntervention], Field(min_length=1, max_length=64)
    ]

    @model_validator(mode="after")
    def validate_bindings_and_choices(self) -> Self:
        """Require exact role bindings, distinct choices and a bounded document.

        Returns:
            This complete Planning configuration.

        Raises:
            ValueError: IDs/names repeat, role bindings are incomplete or unused,
                or serialized content exceeds 512 KiB.
        """
        layer_ids = [layer.id for layer in self.layers]
        if len(set(layer_ids)) != len(layer_ids):
            raise ValueError("Planning layer identifiers must be unique")
        if set(layer_ids) != {self.aoiLayerId, self.parcelLayerId}:
            raise ValueError(
                "Every Planning layer must be bound to the AOI or parcel role"
            )
        parcels = next(layer for layer in self.layers if layer.id == self.parcelLayerId)
        if (
            isinstance(parcels.definition, PlanningDrawingView)
            and self.parcelIdField != "id"
        ):
            raise ValueError("Drawn parcels use their built-in polygon IDs")
        choice_ids = [choice.id for choice in self.interventions]
        labels = [choice.label.casefold() for choice in self.interventions]
        if len(set(choice_ids)) != len(choice_ids) or len(set(labels)) != len(labels):
            raise ValueError("Intervention identifiers and names must be unique")
        if (
            len(
                self.model_dump_json(
                    exclude={
                        "id",
                        "revision",
                        "expectedRevision",
                        "createdAt",
                        "updatedAt",
                    },
                    exclude_unset=True,
                ).encode("utf-8")
            )
            > MAX_TOOL_BYTES
        ):
            raise ValueError("A Planning tool must fit within 512 KiB")
        return self


class UpdatePlanningTool(PlanningToolDocument):
    """Replace an author's tool at the last acknowledged revision."""

    expectedRevision: Annotated[int, Field(strict=True, ge=1)]

    def to_document(self) -> PlanningToolDocument:
        """Return the replacement definition without its write precondition.

        Returns:
            Validated portable definition to persist.
        """
        return PlanningToolDocument.model_validate(
            self.model_dump(exclude={"expectedRevision"}, exclude_unset=True)
        )


class PlanningToolSummary(PlanningDocumentPart):
    """List an author's tool without layer definitions or private owner identity."""

    id: UUID
    title: Title
    revision: Annotated[int, Field(strict=True, ge=1)]
    createdAt: datetime
    updatedAt: datetime


class PlanningTool(PlanningToolDocument):
    """Return a durable author-owned definition and its atomic update revision."""

    id: UUID
    revision: Annotated[int, Field(strict=True, ge=1)]
    createdAt: datetime
    updatedAt: datetime


class PlanningError(Exception):
    """Carry a safe Planning failure without source paths or database details."""

    def __init__(self, status: int, message: str) -> None:
        """Retain an HTTP-equivalent status and actionable public explanation.

        Args:
            status: HTTP-equivalent failure status.
            message: Public explanation without private ownership/database details.
        """
        super().__init__(message)
        self.status = status
