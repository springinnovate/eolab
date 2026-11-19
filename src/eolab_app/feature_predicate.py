"""Describe filtered vector features and the original polygon sources used by spatial conditions."""

from dataclasses import dataclass
from math import isfinite
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictFloat, StrictInt, StrictStr, field_validator

from eolab_app.calculated_fields import CalculatedField
from eolab_app.catalog.vector_contract import CatalogVectorRequest

MAX_FILTER_RULES = 12


class PolygonAreaReference(BaseModel):
    """An expiring browser-owned input ID and the hash of its exact geometry."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    id: Annotated[str, Field(pattern=r"^[a-f0-9]{32}$")]
    sha256: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]


class SavedDrawingReference(BaseModel):
    """Selected editor feature IDs at an acknowledged revision of a linked drawing."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    drawingLayerId: UUID
    revision: int = Field(strict=True, ge=1)
    featureIds: tuple[Annotated[str, Field(pattern=r"^[a-zA-Z0-9-]{1,100}$")], ...] = Field(max_length=500)


DrawingReference = PolygonAreaReference | SavedDrawingReference


class DrawingSelection(BaseModel):
    """Committed drawing polygons and any filtered sources that contributed to the selection."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["drawing"]
    polygonArea: DrawingReference | None
    filter: "VectorFilter | None" = Field(default=None, exclude_if=lambda value: value is None)


class VectorFilterRule(BaseModel):
    """A field comparison with a fixed operator and a scalar value."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    field: StrictStr = Field(min_length=1, max_length=256)
    operator: Literal[
        "eq", "ne", "gt", "ge", "lt", "le", "contains", "missing", "present"
    ]
    value: StrictBool | StrictInt | StrictFloat | StrictStr | None = None

    @field_validator("field", "value")
    @classmethod
    def bounded_literal(cls, value: Any) -> Any:
        """Reject long or control-containing text and numbers unsafe for the browser.

        Args:
            value: Submitted property name or literal.

        Returns:
            Unchanged safe scalar.

        Raises:
            ValueError: If text exceeds 256 characters or contains control characters,
                or a number is nonfinite or exceeds the browser's safe numeric range.
        """
        if isinstance(value, str) and (
            len(value) > 256 or any(ord(c) < 32 for c in value)
        ):
            raise ValueError(
                "Text must be at most 256 characters without control characters"
            )
        if type(value) in {int, float} and (
            not isfinite(value) or abs(value) > 2**53 - 1
        ):
            raise ValueError(
                "Numbers must be finite and within the browser's safe numeric range"
            )
        return value


class IntersectsLayer(BaseModel):
    """Keep target features touching any polygon that passes the source view’s current filter."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    operator: Literal["intersects"]
    layerId: UUID
    source: "CatalogSelection | UploadedSelection | ArtifactVectorSelection | DrawingSelection"


class VectorFilter(BaseModel):
    """An enabled or disabled set of field or spatial conditions combined with all or any."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    enabled: StrictBool = True
    match: Literal["all", "any"] = "all"
    rules: tuple[VectorFilterRule | IntersectsLayer, ...] = Field(default=(), max_length=MAX_FILTER_RULES)

    @field_validator("rules")
    @classmethod
    def check_view_sources(cls, rules: tuple[VectorFilterRule | IntersectsLayer, ...]) -> tuple[VectorFilterRule | IntersectsLayer, ...]:
        """Require repeated conditions on a view to identify the same selected polygons.

        Args:
            rules: Conditions submitted for this target.

        Returns:
            The unchanged conditions.

        Raises:
            ValueError: If two conditions assign different sources to one view ID.
        """
        sources = {}
        for rule in rules:
            if isinstance(rule, IntersectsLayer) and sources.setdefault(rule.layerId, rule.source) != rule.source:
                raise ValueError("A polygon view must have the same source and filter in every condition.")
        return rules

    @property
    def active(self) -> bool:
        """Return whether this state restricts the layer."""
        return self.enabled and bool(self.rules)

    @property
    def fields(self) -> tuple[str, ...]:
        """Return the original or calculated attributes needed by field comparisons."""
        return tuple(dict.fromkeys(rule.field for rule in self.rules if isinstance(rule, VectorFilterRule)))

    @property
    def intersections(self) -> tuple[IntersectsLayer, ...]:
        """Return the active polygon sources that require an authorized original read."""
        return tuple(rule for rule in self.rules if isinstance(rule, IntersectsLayer)) if self.active else ()


class CatalogSelection(CatalogVectorRequest):
    """A catalog vector layer and attribute filter identifying features for analysis.

    Asset and layer names are checked against the authoritative Catalog on every
    resolution. Source files are immutable after admission. Ordered calculated_fields
    travel with the view and filter; readers evaluate them from original attributes.
    """

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)
    filter: VectorFilter
    assetKey: str = Field(min_length=1, max_length=256)
    layerName: str = Field(min_length=1, max_length=256)
    calculated_fields: tuple[CalculatedField, ...] = Field(
        default=(), alias="calculatedFields", exclude_if=lambda value: not value
    )


class UploadedVectorFilterRequest(BaseModel):
    """Identify an upload, its view-owned calculated fields and feature predicate."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)
    uploadId: UUID
    filter: VectorFilter
    calculated_fields: tuple[CalculatedField, ...] = Field(
        default=(), alias="calculatedFields", exclude_if=lambda value: not value
    )


class UploadedSelection(UploadedVectorFilterRequest):
    """Identify selected features in one browser-owned immutable GeoPackage.

    The server checks ownership separately from this public descriptor. The layer
    name must match the sole layer recorded when the upload was admitted.
    """

    layerName: str


class ArtifactVectorSelection(BaseModel):
    """Select original features from a private immutable Processing result.

    Attributes:
        kind: The literal string "runArtifact" identifies its source lifetime.
        jobId: Opaque owning run ID, authorized by the Processing source boundary.
        artifactId: Opaque published file ID within the run.
        layerName: Original native GeoPackage layer, checked when the file opens.
        filter: Accepted attribute predicate, including calculated attributes.
        calculated_fields: Ordered view-owned definitions captured with the predicate.
    """

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)
    kind: Literal["runArtifact"]
    jobId: str = Field(pattern=r"^[a-f0-9]{32}$")
    artifactId: str = Field(pattern=r"^[a-f0-9]{32}$")
    layerName: str = Field(min_length=1, max_length=256)
    filter: VectorFilter
    calculated_fields: tuple[CalculatedField, ...] = Field(
        default=(), alias="calculatedFields", exclude_if=lambda value: not value
    )


VectorSelection = CatalogSelection | UploadedSelection | ArtifactVectorSelection
"""Path-free source identity and attribute filter for vector analysis."""


IntersectsLayer.model_rebuild()
VectorFilter.model_rebuild()


@dataclass(frozen=True)
class VectorSourceOwners:
    """The browser's separate credentials for uploads and private run results or drawings."""

    uploads: str | None = None
    processing: str | None = None

    def for_source(self, source: VectorSelection | DrawingSelection) -> str | None:
        """Choose the ownership credential checked by this source's authority.

        Args:
            source: Original catalog, upload, run result or committed drawing.

        Returns:
            The appropriate private identity, or None for a public catalog item.
        """
        if isinstance(source, UploadedVectorFilterRequest):
            return self.uploads
        if isinstance(source, (ArtifactVectorSelection, DrawingSelection)):
            return self.processing
        return None


def referenced_layers(predicate: VectorFilter) -> tuple[VectorSelection | DrawingSelection, ...]:
    """List the sources needed by active spatial conditions, including nested filters.

    Args:
        predicate: Captured filter of the view to be read.

    Returns:
        Every referenced layer in condition order, with its captured filter.
    """
    if not predicate.active:
        return ()
    layers = []
    for rule in predicate.rules:
        if isinstance(rule, IntersectsLayer):
            layers.append(rule.source)
            if rule.source.filter is not None:
                layers.extend(referenced_layers(rule.source.filter))
    return tuple(layers)
