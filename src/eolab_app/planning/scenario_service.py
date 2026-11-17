"""Save private scenario edits after validating one original parcel identity."""

import asyncio
from collections.abc import Awaitable, Callable
from uuid import UUID

from eolab_app.catalog_selection import SelectionUnavailableError
from eolab_app.planning.models import PlanningError
from eolab_app.planning.scenario_models import (
    CreateScenario,
    RenameScenario,
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
    ) -> None:
        """Use Planning persistence and a composition-supplied original-ID lookup.

        Args:
            store: Planning's durable tools and private scenario store.
            lookup_parcel: Validate one ID against the whole original Catalog
                parcel layer without AOI or ordinary custom-view filters.
        """
        self.store = store
        self._lookup_parcel = lookup_parcel

    async def create_scenario(
        self, owner: str, tool_id: UUID, request: CreateScenario
    ) -> Scenario:
        """Create an empty owned scenario using an acknowledged linked tool.

        Args:
            owner: Participant browser's server-derived identity.
            tool_id: Opaque identifier from the participant link.
            request: Name and expected tool revision.

        Returns:
            New private scenario metadata at revision one.

        Raises:
            PlanningError: The tool is missing, changed, or storage is unavailable.
        """
        return await asyncio.to_thread(
            self.store.create_scenario, owner, tool_id, request
        )

    async def rename_scenario(
        self, owner: str, identifier: UUID, request: RenameScenario
    ) -> Scenario:
        """Rename an owned scenario without changing its assignments or reading sources.

        Args:
            owner: Participant browser's server-derived identity.
            identifier: Opaque scenario identifier.
            request: New name and both acknowledged revisions.

        Returns:
            Updated metadata with its scenario revision incremented.

        Raises:
            PlanningError: Ownership, revisions or storage prevent the rename.
        """
        return await asyncio.to_thread(
            self.store.rename_scenario, owner, identifier, request
        )

    async def set_assignment(
        self, owner: str, identifier: UUID, request: SetScenarioAssignment
    ) -> Scenario:
        """Validate and save or clear one original parcel's intervention choice.

        Ownership, both revisions and intervention eligibility are checked before
        native work. Original-source membership is required even when clearing;
        ordinary view filters do not restrict or remove saved assignments.

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
        _, tool = await asyncio.to_thread(
            self.store.get_scenario_for_edit,
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
        ).definition.catalogItem
        try:
            result = await self._lookup_parcel(
                ParcelLookupRequest(
                    collectionId=parcels.collection,
                    itemId=parcels.id,
                    idField=tool.parcelIdField,
                    parcelId=request.parcelId,
                )
            )
        except VectorUpstreamError as error:
            raise PlanningError(503, str(error)) from error
        except (VectorFeatureError, SelectionUnavailableError) as error:
            raise PlanningError(422, str(error)) from error
        if not result.found:
            raise PlanningError(
                422,
                "This parcel ID is not in the Planning tool's original parcel layer.",
            )
        return await asyncio.to_thread(
            self.store.set_assignment, owner, identifier, request
        )
