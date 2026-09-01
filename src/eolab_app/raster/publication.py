"""Application workflow coordinating authoritative raster publication."""

import asyncio
from collections.abc import Callable
from pathlib import Path

from eolab_app.raster.catalog_metadata import cataloged_source_signature
from eolab_app.raster.errors import RasterConflictError
from eolab_app.raster.geoserver import GEOSERVER_WORKSPACE_NAME
from eolab_app.raster.models import (
    CatalogRasterRequest,
    PublishedRaster,
)
from eolab_app.raster.ports import RasterCatalog, RasterPublisher
from eolab_app.raster.source_identity import RasterSourceIdentity
from eolab_app.rendering.errors import PublishedLayerChangedError
from eolab_app.raster.sources import (
    MountedRasterResolver,
    PublishedRasterRegistry,
    source_signature,
)


class RasterPublicationService:
    """Publish prepared catalog rasters and authorize their public layers."""

    def __init__(
        self,
        catalog: RasterCatalog,
        source_resolver: MountedRasterResolver,
        publisher: RasterPublisher,
        raster_registry: PublishedRasterRegistry,
        signature_reader: Callable[[Path], RasterSourceIdentity] | None = None,
    ) -> None:
        """Create a serialized publication use case.

        Args:
            catalog: Authoritative raster catalog port.
            source_resolver: Resolver confined to the scan mount.
            publisher: Concrete raster rendering adapter.
            raster_registry: Process-local WMS authorization registry.
            signature_reader: Optional synchronous source identity boundary.
        """
        self._catalog = catalog
        self._source_resolver = source_resolver
        self._publisher = publisher
        self._raster_registry = raster_registry
        self._signature_reader = signature_reader or source_signature
        self._publish_lock = asyncio.Lock()

    async def publish(
        self,
        request: CatalogRasterRequest,
    ) -> PublishedRaster:
        """Resolve and idempotently publish one prepared catalog GeoTIFF.

        Args:
            request: Validated Collection and Item identity.

        Returns:
            Browser-safe WMS layer identity and WGS 84 bounding box.

        Raises:
            RasterFeatureError: If the Item, Asset, or rendering adapter fails.
            RasterConflictError: If the source is unreadable or changes during
                publication.
        """
        async with self._publish_lock:
            item = await self._catalog.get_item(request)
            source_path = self._source_resolver.resolve(item)
            catalog_signature = cataloged_source_signature(item)
            try:
                inspected_signature = await asyncio.to_thread(
                    self._signature_reader,
                    source_path,
                )
            except OSError as error:
                raise RasterConflictError(
                    "Visualization unavailable: the raster metadata can no "
                    "longer be read."
                ) from error
            if inspected_signature != catalog_signature:
                raise RasterConflictError(
                    "The cataloged raster changed; scan it again before "
                    "publication."
                )
            resource_name = request.item_id
            await self._publisher.publish(resource_name, source_path)
            layer_name = f"{GEOSERVER_WORKSPACE_NAME}:{resource_name}"
            try:
                await asyncio.to_thread(
                    self._raster_registry.authorize,
                    layer_name,
                    source_path,
                    inspected_signature,
                )
            except PublishedLayerChangedError as error:
                raise RasterConflictError(str(error)) from error
            return PublishedRaster(
                layerName=layer_name,
                bbox=tuple(item["bbox"]),
            )
