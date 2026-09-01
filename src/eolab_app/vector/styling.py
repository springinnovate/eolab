"""Application workflow for authoritative single-symbol vector styling."""

import asyncio
from typing import Any

from eolab_app.rendering.errors import (
    PublishedLayerChangedError,
    PublishedLayerNotAuthorizedError,
)
from eolab_app.rendering.geoserver import GEOSERVER_WORKSPACE_NAME
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.models import (
    AppliedVectorStyle,
    CatalogVectorStyleRequest,
    VECTOR_READER_CONTRACT,
    VECTOR_RENDERING_METADATA_KEY,
    VECTOR_RENDERING_POLICY,
)
from eolab_app.vector.ports import VectorCatalog, VectorStyler
from eolab_app.vector.sources import (
    MountedVectorResolver,
    PublishedVectorRegistry,
)


class VectorStyleService:
    """Apply styles only to current, published, authoritative vector Items."""

    def __init__(
        self,
        catalog: VectorCatalog,
        source_resolver: MountedVectorResolver,
        styler: VectorStyler,
        vector_registry: PublishedVectorRegistry,
    ) -> None:
        """Create a serialized vector single-symbol styling use case.

        Args:
            catalog: Authoritative vector catalog port.
            source_resolver: Exact mounted source and layer resolver.
            styler: GeoServer single-symbol style adapter.
            vector_registry: Current public-WMS authorization registry.
        """
        self._catalog = catalog
        self._source_resolver = source_resolver
        self._styler = styler
        self._vector_registry = vector_registry
        self._style_lock = asyncio.Lock()

    async def apply(
        self,
        request: CatalogVectorStyleRequest,
    ) -> AppliedVectorStyle:
        """Validate ownership and apply one per-layer vector style.

        Args:
            request: Catalog identity and complete validated symbol state.

        Returns:
            Applied style name and normalized style state.

        Raises:
            VectorFeatureError: If catalog, source, authorization, or GeoServer
                boundaries cannot safely complete the operation.
            VectorConflictError: If the layer is unpublished, changed, or the
                requested geometry disagrees with authoritative assessment.
        """
        async with self._style_lock:
            item = await self._catalog.get_item(request)
            source = self._source_resolver.resolve(item)
            layer_name = f"{GEOSERVER_WORKSPACE_NAME}:{request.item_id}"
            try:
                authorization = await asyncio.to_thread(
                    self._vector_registry.require_current,
                    layer_name,
                )
            except (
                PublishedLayerChangedError,
                PublishedLayerNotAuthorizedError,
            ) as error:
                raise VectorConflictError(
                    "Style unavailable: add the current vector Item to the map "
                    "before styling it."
                ) from error
            if source != authorization.source:
                raise VectorConflictError(
                    "Style unavailable: the authoritative vector source no "
                    "longer matches the published layer."
                )
            metadata = item.get("properties", {}).get(
                VECTOR_RENDERING_METADATA_KEY
            )
            if (
                not isinstance(metadata, dict)
                or metadata.get("policy") != VECTOR_RENDERING_POLICY
                or metadata.get("eligible") is not True
                or metadata.get("reader_contract") != VECTOR_READER_CONTRACT
                or metadata.get("reader_compatible") is not True
                or metadata.get("source_signature") != [
                    list(entry) for entry in authorization.source_signature
                ]
            ):
                raise VectorConflictError(
                    "Style unavailable: reassess and add the current vector "
                    "Item to the map before styling it."
                )
            geometry_kind = metadata.get("geometry_kind")
            if geometry_kind != request.style.geometry_kind:
                raise VectorConflictError(
                    "Style unavailable: the requested symbol geometry does not "
                    "match the assessed vector layer."
                )
            if (
                request.style.label is not None
                and request.style.label.field
                not in _catalog_vector_label_fields(item)
            ):
                raise VectorConflictError(
                    "Style unavailable: the selected label field is not a "
                    "current attribute of the authoritative vector Item."
                )
            style_name = await self._styler.apply_style(
                request.item_id,
                request.style,
            )
            try:
                await asyncio.to_thread(
                    self._vector_registry.authorize,
                    layer_name,
                    source,
                    authorization.source_signature,
                    style_name,
                )
            except PublishedLayerChangedError as error:
                raise VectorConflictError(str(error)) from error
            return AppliedVectorStyle(
                styleName=style_name,
                style=request.style,
            )


def _catalog_vector_label_fields(item: dict[str, Any]) -> frozenset[str]:
    """Return authoritative non-geometry fields eligible for vector labels.

    Args:
        item: Authoritative Catalog Item loaded by the style service.

    Returns:
        Exact bounded attribute field identities declared by the STAC Table
        Extension, excluding its primary geometry column.
    """
    properties = item.get("properties")
    if not isinstance(properties, dict):
        return frozenset()
    columns = properties.get("table:columns")
    primary_geometry = properties.get("table:primary_geometry")
    if not isinstance(columns, list):
        return frozenset()
    return frozenset(
        name
        for column in columns
        if isinstance(column, dict)
        and isinstance((name := column.get("name")), str)
        and 0 < len(name) <= 256
        and name != primary_geometry
    )
