"""Describe private parcel scenarios and revision-checked assignment changes."""

from datetime import datetime
from typing import Annotated
from uuid import UUID

from pydantic import Field

from eolab_app.map_layer_documents import Title
from eolab_app.planning.models import PlanningDocumentPart
from eolab_app.vector.parcel_models import ParcelId, ParcelOffset

ScenarioRevision = Annotated[int, Field(strict=True, ge=1)]


class CreateScenario(PlanningDocumentPart):
    """Name an empty scenario against the participant's acknowledged tool revision."""

    name: Title
    expectedToolRevision: ScenarioRevision


class RenameScenario(CreateScenario):
    """Rename an owned scenario without replacing its parcel assignments."""

    expectedRevision: ScenarioRevision


class SetScenarioAssignment(PlanningDocumentPart):
    """Assign one intervention to an original parcel, or clear it with null.

    Both revisions are required so neither a competing scenario edit nor a
    changed Planning definition can silently alter an acknowledged choice.
    """

    parcelId: ParcelId
    interventionId: UUID | None
    expectedRevision: ScenarioRevision
    expectedToolRevision: ScenarioRevision


class Scenario(PlanningDocumentPart):
    """Return owned scenario metadata without assignments or private owner identity.

    toolRevision is the tool's current revision at this read or write, not a
    historical definition snapshot. Assignment pages carry the scenario revision.
    """

    id: UUID
    toolId: UUID
    name: Title
    revision: ScenarioRevision
    toolRevision: ScenarioRevision
    createdAt: datetime
    updatedAt: datetime


class ScenarioAssignment(PlanningDocumentPart):
    """Retain an original typed parcel ID and its one explicitly chosen intervention.

    Missing rows represent no assignment; an intervention is never inferred from
    the source data or substituted when a parcel leaves the current filter.
    """

    parcelId: ParcelId
    interventionId: UUID


class ScenarioAssignmentPage(PlanningDocumentPart):
    """Return saved choices at one scenario revision, regardless of current filters.

    A null nextOffset means all saved choices have been read. Callers must send
    this revision for each following page; a concurrent edit rejects stale pages.
    """

    revision: ScenarioRevision
    assignments: list[ScenarioAssignment]
    offset: ParcelOffset
    nextOffset: ParcelOffset | None
