"""Application workflow coordinating authoritative vector publication."""

import asyncio
from collections.abc import Callable

from eolab_app.rendering.geoserver import GEOSERVER_WORKSPACE_NAME
from eolab_app.rendering.errors import PublishedLayerChangedError
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.models import (
    CatalogVectorRequest,
    ResolvedVectorSource,
    PublishedVector,
    VECTOR_READER_CONTRACT,
    VECTOR_RENDERING_METADATA_KEY,
    VECTOR_RENDERING_POLICY,
    VectorSourceSignature,
)
from eolab_app.vector.ports import VectorCatalog, VectorPublisher
from eolab_app.vector.sources import (
    MountedVectorResolver,
    PublishedVectorRegistry,
    vector_source_signature,
)
from eolab_app.vector.styles import default_vector_style


class VectorPublicationService:
    """Publish eligible exact vector layers and authorize bounded WMS access."""

    def __init__(
        self,
        catalog: VectorCatalog,
        source_resolver: MountedVectorResolver,
        publisher: VectorPublisher,
        vector_registry: PublishedVectorRegistry,
        signature_reader: Callable[
            [ResolvedVectorSource], VectorSourceSignature
        ] = vector_source_signature,
    ) -> None:
        """Create a serialized vector publication use case.

        Args:
            catalog: Authoritative vector catalog port.
            source_resolver: Exact source and layer resolver.
            publisher: Convergent GeoServer vector adapter.
            vector_registry: Process-local public-WMS authorization registry.
            signature_reader: Complete mounted source identity boundary.
        """
        self._catalog = catalog
        self._source_resolver = source_resolver
        self._publisher = publisher
        self._vector_registry = vector_registry
        self._signature_reader = signature_reader
        self._publish_lock = asyncio.Lock()

    async def publish(self, request: CatalogVectorRequest) -> PublishedVector:
        """Resolve and idempotently publish one approved exact vector layer.

        Args:
            request: Validated Collection and Item identity.

        Returns:
            Browser-safe WMS identity, bounds, geometry class, and fixed style.

        Raises:
            VectorFeatureError: If catalog, source, or GeoServer boundaries fail.
            VectorConflictError: If assessment is absent, stale, unsupported, or
                the mounted source changes.
        """
        async with self._publish_lock:
            item = await self._catalog.get_item(request)
            source = self._source_resolver.resolve(item)
            metadata = item.get("properties", {}).get(
                VECTOR_RENDERING_METADATA_KEY
            )
            if (
                not isinstance(metadata, dict)
                or metadata.get("policy") != VECTOR_RENDERING_POLICY
            ):
                raise VectorConflictError(
                    "Visualization unavailable: assess this vector layer first."
                )
            if metadata.get("eligible") is not True:
                reason = metadata.get("reason")
                raise VectorConflictError(
                    reason if isinstance(reason, str) and reason else
                    "Visualization unavailable for this vector layer."
                )
            if (
                metadata.get("reader_contract") != VECTOR_READER_CONTRACT
                or metadata.get("reader_compatible") is not True
            ):
                raise VectorConflictError(
                    "Visualization unavailable: reassess this vector layer for "
                    "the current GeoServer reader."
                )
            if (
                source.source_kind != "mounted"
                or source.source_path is None
                or source.layer_name is None
                or source.source_format not in {"shapefile", "geopackage"}
            ):
                raise VectorConflictError(
                    "Visualization unavailable: the assessed mounted vector "
                    "source contract is no longer valid."
                )
            try:
                inspected_signature = await asyncio.to_thread(
                    self._signature_reader,
                    source,
                )
            except OSError as error:
                raise VectorConflictError(
                    "Visualization unavailable: the vector source cannot be read."
                ) from error
            if [list(entry) for entry in inspected_signature] != metadata.get(
                "source_signature"
            ):
                raise VectorConflictError(
                    "Visualization unavailable: the vector source changed; "
                    "reassess it before publication."
                )
            geometry_kind = metadata.get("geometry_kind")
            if geometry_kind not in {"point", "line", "polygon"}:
                raise VectorConflictError(
                    "Visualization unavailable: the assessed geometry is invalid."
                )
            style_name = await self._publisher.publish(
                request.item_id,
                source.source_format,
                source.source_path,
                source.layer_name,
                geometry_kind,
            )
            layer_name = f"{GEOSERVER_WORKSPACE_NAME}:{request.item_id}"
            try:
                await asyncio.to_thread(
                    self._vector_registry.authorize,
                    layer_name,
                    source,
                    inspected_signature,
                    style_name,
                )
            except PublishedLayerChangedError as error:
                raise VectorConflictError(str(error)) from error
            return PublishedVector(
                layerName=layer_name,
                bbox=tuple(item["bbox"]),
                geometryKind=geometry_kind,
                styleName=style_name,
                style=default_vector_style(geometry_kind),
            )
