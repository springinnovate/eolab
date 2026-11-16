"""Validate Planning role sources before persisting an author's tool definition."""

import asyncio
from collections.abc import Awaitable, Callable
from uuid import UUID

from eolab_app.catalog_selection import CatalogSelection, SelectionUnavailableError
from eolab_app.planning.models import (
    PlanningError,
    PlanningTool,
    PlanningToolDocument,
    UpdatePlanningTool,
)
from eolab_app.planning.store import PlanningToolStore
from eolab_app.vector.errors import VectorFeatureError, VectorUpstreamError
from eolab_app.vector.filters import CatalogVectorFilterRequest
from eolab_app.vector.parcel_models import ParcelIdRequest, ParcelIdValidationResponse


class PlanningToolService:
    """Own configuration validation while source readers and storage retain their jobs."""

    def __init__(
        self,
        store: PlanningToolStore,
        authorize_layer: Callable[
            [CatalogVectorFilterRequest], Awaitable[CatalogSelection]
        ],
        validate_parcel_ids: Callable[
            [ParcelIdRequest], Awaitable[ParcelIdValidationResponse]
        ],
    ) -> None:
        """Use composition-supplied polygon-source and whole-layer ID validation.

        Args:
            store: Planning's durable author-owned document store.
            authorize_layer: Require admitted polygon geometry and validate Catalog
                identity, original source, current filter and calculated fields.
            validate_parcel_ids: Existing vector owner validating all original parcel IDs.
        """
        self.store = store
        self._authorize_layer = authorize_layer
        self._validate_parcel_ids = validate_parcel_ids

    async def _validate_sources(self, document: PlanningToolDocument) -> None:
        """Authorize both stored roles and validate the original parcel ID column.

        Args:
            document: Structurally valid portable tool definition.

        Raises:
            PlanningError: A source, filter, polygon schema or parcel ID is unavailable.
            asyncio.CancelledError: The request abandoned native validation.
        """
        selections: dict[UUID, CatalogSelection] = {}
        try:
            for layer in document.layers:
                selections[layer.id] = await self._authorize_layer(
                    layer.to_selection_request()
                )
            parcels = selections[document.parcelLayerId]
            validation = await self._validate_parcel_ids(
                ParcelIdRequest(
                    collectionId=parcels.collection_id,
                    itemId=parcels.item_id,
                    idField=document.parcelIdField,
                )
            )
            if (validation.selection.assetKey, validation.selection.layerName) != (
                parcels.assetKey,
                parcels.layerName,
            ):
                raise PlanningError(
                    422,
                    "The parcel source changed during validation. Reload the layer and try again.",
                )
        except VectorUpstreamError as error:
            raise PlanningError(503, str(error)) from error
        except (VectorFeatureError, SelectionUnavailableError) as error:
            raise PlanningError(422, str(error)) from error

    async def create_tool(
        self, owner: str, document: PlanningToolDocument
    ) -> PlanningTool:
        """Validate sources without a database transaction, then create a tool.

        Args:
            owner: Server-derived browser author identity.
            document: Complete new tool definition.

        Returns:
            Created durable definition and revision.

        Raises:
            PlanningError: Source validation or storage failed.
            asyncio.CancelledError: The request abandoned validation.
        """
        await self._validate_sources(document)
        return await asyncio.to_thread(self.store.create_tool, owner, document)

    async def update_tool(
        self, owner: str, identifier: UUID, request: UpdatePlanningTool
    ) -> PlanningTool:
        """Check ownership/revision before native work and atomically again when saving.

        Args:
            owner: Server-derived browser author identity.
            identifier: Existing tool identifier.
            request: Replacement definition and last acknowledged revision.

        Returns:
            Updated durable definition and incremented revision.

        Raises:
            PlanningError: Ownership, revision, source validation or storage failed.
            asyncio.CancelledError: The request abandoned validation.
        """
        await asyncio.to_thread(
            self.store.require_revision, owner, identifier, request.expectedRevision
        )
        document = request.to_document()
        await self._validate_sources(document)
        return await asyncio.to_thread(
            self.store.update_tool,
            owner,
            identifier,
            request.expectedRevision,
            document,
        )
