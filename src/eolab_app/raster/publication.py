"""Application workflow coordinating authoritative raster publication."""

import asyncio
from collections.abc import Callable
from pathlib import Path
from typing import Any

import rasterio

from eolab_app.raster.eligibility import (
    RENDERING_METADATA_KEY,
    RENDERING_POLICY,
    inspect_raster_renderability,
)
from eolab_app.raster.errors import RasterConflictError
from eolab_app.raster.geoserver import GEOSERVER_WORKSPACE_NAME
from eolab_app.raster.models import (
    CatalogRasterRequest,
    PublishedRaster,
    SourceSignature,
)
from eolab_app.raster.ports import RasterCatalog, RasterPublisher
from eolab_app.raster.sources import (
    MountedRasterResolver,
    PublishedRasterRegistry,
    source_signature,
)


class RasterPublicationService:
    """Publish eligible catalog rasters and authorize their public layers."""

    def __init__(
        self,
        catalog: RasterCatalog,
        source_resolver: MountedRasterResolver,
        publisher: RasterPublisher,
        raster_registry: PublishedRasterRegistry,
        signature_reader: Callable[[Path], SourceSignature] | None = None,
        eligibility_inspector: Callable[[Path], dict[str, Any]] | None = None,
    ) -> None:
        """Create a serialized publication use case.

        Args:
            catalog: Authoritative raster catalog port.
            source_resolver: Resolver confined to the scan mount.
            publisher: Concrete raster rendering adapter.
            raster_registry: Process-local WMS authorization registry.
            signature_reader: Optional synchronous source identity boundary.
            eligibility_inspector: Optional synchronous structural inspection
                boundary.
        """
        self._catalog = catalog
        self._source_resolver = source_resolver
        self._publisher = publisher
        self._raster_registry = raster_registry
        self._signature_reader = signature_reader or source_signature
        self._eligibility_inspector = (
            eligibility_inspector or inspect_raster_renderability
        )
        self._publish_lock = asyncio.Lock()

    async def publish(
        self,
        request: CatalogRasterRequest,
    ) -> PublishedRaster:
        """Resolve and idempotently publish one approved catalog GeoTIFF.

        Args:
            request: Validated Collection and Item identity.

        Returns:
            Browser-safe WMS layer identity and WGS 84 bounding box.

        Raises:
            RasterFeatureError: If the Item, Asset, or rendering adapter fails.
            RasterConflictError: If the source is ineligible, unreadable, or
                changes during publication.
        """
        async with self._publish_lock:
            item = await self._catalog.get_item(request)
            source_path = self._source_resolver.resolve(item)
            rendering_metadata = item["assets"]["data"].get(
                RENDERING_METADATA_KEY
            )
            if (
                rendering_metadata is None
                or rendering_metadata.get("policy") != RENDERING_POLICY
            ):
                raise RasterConflictError(
                    "Visualization unavailable: assess this raster first."
                )
            if not rendering_metadata["eligible"]:
                raise RasterConflictError(rendering_metadata["reason"])

            try:
                inspected_signature = await asyncio.to_thread(
                    self._signature_reader,
                    source_path,
                )
                current_metadata = await asyncio.to_thread(
                    self._eligibility_inspector,
                    source_path,
                )
            except (OSError, rasterio.errors.RasterioError) as error:
                raise RasterConflictError(
                    "Visualization unavailable: the raster metadata can no "
                    "longer be read."
                ) from error
            if not current_metadata["eligible"]:
                raise RasterConflictError(current_metadata["reason"])

            resource_name = request.item_id
            await self._publisher.publish(resource_name, source_path)
            layer_name = f"{GEOSERVER_WORKSPACE_NAME}:{resource_name}"
            await asyncio.to_thread(
                self._raster_registry.authorize,
                layer_name,
                source_path,
                inspected_signature,
            )
            return PublishedRaster(
                layerName=layer_name,
                bbox=tuple(item["bbox"]),
            )
