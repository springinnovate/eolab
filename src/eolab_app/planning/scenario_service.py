"""Save private scenario edits after validating one original parcel identity."""

import asyncio
from collections.abc import Awaitable, Callable
from uuid import UUID

from eolab_app.catalog_selection import SelectionUnavailableError
from eolab_app.drawings.models import DrawingError, DrawingLayer
from eolab_app.planning.models import PlanningDrawingView, PlanningError
from eolab_app.planning.scenario_models import (
    Scenario,
    SetScenarioAssignment,
)
from eolab_app.planning.store import PlanningToolStore
from eolab_app.vector.errors import VectorFeatureError, VectorUpstreamError
from eolab_app.vector.parcel_models import ParcelLookupRequest, ParcelLookupResponse


class PlanningScenarioService:
    """Coordinate owned scenario edits with the neutral original-parcel reader.

    No database transaction remains open during native source validation. The
    store rechecks both revisions after validation and serializes the final edit.
    """

    def __init__(
        self,
        store: PlanningToolStore,
        lookup_parcel: Callable[[ParcelLookupRequest], Awaitable[ParcelLookupResponse]],
        read_drawing: Callable[[UUID], Awaitable[DrawingLayer]] | None = None,
    ) -> None:
        """Use Planning persistence and a composition-supplied original-ID lookup.

        Args:
            store: Planning's durable tools and private scenario store.
            lookup_parcel: Validate one ID against the whole original Catalog
                parcel layer without AOI or ordinary custom-view filters.
            read_drawing: Read the latest saved polygons through the drawing
                source owner; omit only in Catalog-only compositions.
        """
        self.store = store
        self._lookup_parcel = lookup_parcel
        self._read_drawing = read_drawing

    async def set_assignment(
        self, owner: str, identifier: UUID, request: SetScenarioAssignment
    ) -> Scenario:
        """Validate and save or clear one original parcel's intervention choice.

        Ownership, both revisions and intervention eligibility are checked before
        source work. Catalog membership is required even when clearing. Drawing
        choices may be cleared after their polygon is deleted; new choices must
        refer to a currently saved polygon. Filters never remove saved assignments.

        Args:
            owner: Participant browser's server-derived identity.
            identifier: Opaque scenario identifier.
            request: Original typed parcel ID, nullable choice and both revisions.

        Returns:
            Metadata after one atomic revision-checked assignment change.

        Raises:
            PlanningError: Ownership, revisions, intervention choice, source
                membership or storage prevents saving.
            asyncio.CancelledError: The request abandoned native validation.
        """
        tool = await asyncio.to_thread(
            self.store.get_scenario_tool_for_edit,
            owner,
            identifier,
            request.expectedRevision,
            request.expectedToolRevision,
        )
        if request.interventionId is not None and not any(
            choice.id == request.interventionId for choice in tool.interventions
        ):
            raise PlanningError(
                422, "Choose an intervention allowed by this Planning tool."
            )
        parcels = next(
            layer for layer in tool.layers if layer.id == tool.parcelLayerId
        ).definition
        try:
            if isinstance(parcels, PlanningDrawingView):
                if request.parcelId.type != "string":
                    raise PlanningError(422, "Drawn parcels use text polygon IDs.")
                if request.interventionId is None:
                    found = True
                else:
                    if self._read_drawing is None:
                        raise PlanningError(
                            503, "Saved drawing layers are unavailable."
                        )
                    drawing = await self._read_drawing(parcels.drawingLayerId)
                    found = any(
                        feature.id == request.parcelId.value
                        for feature in drawing.collection.features
                    )
            else:
                result = await self._lookup_parcel(
                    ParcelLookupRequest(
                        collectionId=parcels.catalogItem.collection,
                        itemId=parcels.catalogItem.id,
                        idField=tool.parcelIdField,
                        parcelId=request.parcelId,
                    )
                )
                found = result.found
        except DrawingError as error:
            raise PlanningError(error.status, str(error)) from error
        except VectorUpstreamError as error:
            raise PlanningError(503, str(error)) from error
        except (VectorFeatureError, SelectionUnavailableError) as error:
            raise PlanningError(422, str(error)) from error
        if not found:
            raise PlanningError(
                422,
                "This parcel ID is not in the Planning tool's saved parcel layer.",
            )
        return await asyncio.to_thread(
            self.store.set_assignment, owner, identifier, request
        )
