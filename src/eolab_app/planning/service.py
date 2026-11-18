"""Validate Planning role sources before persisting an author's tool definition."""

import asyncio
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from uuid import UUID

from eolab_app.catalog_selection import CatalogSelection, SelectionUnavailableError
from eolab_app.drawings.models import DrawingError, DrawingLayer
from eolab_app.map_layer_documents import MapDrawingLayer
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

# Catalog collection, Item, Asset, native layer and original ID field.
_CatalogParcelField = tuple[str, str, str, str, str]
_MAX_VALIDATED_TOOL_REVISIONS = 256


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
        read_drawing: Callable[[UUID], Awaitable[DrawingLayer]] | None = None,
    ) -> None:
        """Use composition-supplied polygon-source and whole-layer ID validation.

        Args:
            store: Planning's durable author-owned document store.
            authorize_layer: Require admitted polygon geometry and validate Catalog
                identity, original source, current filter and calculated fields.
            validate_parcel_ids: Existing vector owner validating all original parcel IDs.
            read_drawing: Read a linked drawing's current admitted polygons. Omit
                only for compositions that do not provide drawing sources.
        """
        self.store = store
        self._authorize_layer = authorize_layer
        self._validate_parcel_ids = validate_parcel_ids
        self._read_drawing = read_drawing
        self._validated_parcel_fields: OrderedDict[
            tuple[UUID, int], _CatalogParcelField
        ] = OrderedDict()

    async def _validate_sources(
        self,
        document: PlanningToolDocument,
        previous_field: _CatalogParcelField | None = None,
    ) -> _CatalogParcelField | None:
        """Authorize every live role and check uniqueness for newly chosen Catalog IDs.

        Args:
            document: Structurally valid portable tool definition.
            previous_field: Catalog field validated for the preceding tool revision
                in this service instance, if still retained.

        Returns:
            The authorized Catalog parcel field, or None for a linked drawing.

        Raises:
            PlanningError: A source, filter, polygon schema or parcel ID is unavailable.
            asyncio.CancelledError: The request abandoned native validation.
        """
        selections: dict[UUID, CatalogSelection] = {}
        try:
            for layer in document.layers:
                if isinstance(layer.definition, MapDrawingLayer):
                    if self._read_drawing is None:
                        raise PlanningError(
                            503, "Saved drawing layers are unavailable."
                        )
                    await self._read_drawing(layer.definition.drawingLayerId)
                    continue
                selections[layer.id] = await self._authorize_layer(
                    layer.to_selection_request()
                )
            if document.parcelLayerId not in selections:
                return None
            parcels = selections[document.parcelLayerId]
            field = (
                parcels.collection_id,
                parcels.item_id,
                parcels.assetKey,
                parcels.layerName,
                document.parcelIdField,
            )
            if field == previous_field:
                return field
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
            return field
        except DrawingError as error:
            raise PlanningError(error.status, str(error)) from error
        except VectorUpstreamError as error:
            raise PlanningError(503, str(error)) from error
        except (VectorFeatureError, SelectionUnavailableError) as error:
            raise PlanningError(422, str(error)) from error

    def _remember_parcel_field(
        self, tool: PlanningTool, field: _CatalogParcelField | None
    ) -> None:
        """Retain a Catalog uniqueness check for the tool revision that actually saved.

        Args:
            tool: Tool returned by the successful database write.
            field: Validated Catalog field, or None for a mutable drawing.
        """
        self._validated_parcel_fields.pop((tool.id, tool.revision - 1), None)
        if field is not None:
            self._validated_parcel_fields[tool.id, tool.revision] = field
            if len(self._validated_parcel_fields) > _MAX_VALIDATED_TOOL_REVISIONS:
                self._validated_parcel_fields.popitem(last=False)

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
        field = await self._validate_sources(document)
        tool = await asyncio.to_thread(self.store.create_tool, owner, document)
        self._remember_parcel_field(tool, field)
        return tool

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
        previous_field = self._validated_parcel_fields.get(
            (identifier, request.expectedRevision)
        )
        field = await self._validate_sources(document, previous_field)
        tool = await asyncio.to_thread(
            self.store.update_tool,
            owner,
            identifier,
            request.expectedRevision,
            document,
        )
        self._remember_parcel_field(tool, field)
        return tool
