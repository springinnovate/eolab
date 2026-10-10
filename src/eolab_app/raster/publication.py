"""Application workflow coordinating authoritative raster publication."""

import asyncio
from collections.abc import Awaitable, Callable
import re

from rasterio.errors import RasterioError

from eolab_app.raster.catalog_metadata import cataloged_source_signature
from eolab_app.raster.geoserver import GEOSERVER_WORKSPACE_NAME
from eolab_app.raster.models import (
    CatalogRasterRequest,
    PublishedRaster,
)
from eolab_app.raster.ports import RasterCatalog, RasterPublisher
from eolab_app.raster.sources import (
    MountedRasterResolver,
    PublishedRasterRegistry,
)
from eolab_app.raster.source_access import RasterSourceAccess, describe_raster_file
from eolab_app.raster.source_identity import RasterSourceIdentity
from eolab_app.raster.source_models import RasterSourceRequest, RunArtifactReference
from eolab_app.raster.errors import RasterConflictError
from eolab_app.source_files import SourceFileError


def temporary_raster_source(layer_name: str) -> RunArtifactReference | None:
    """Recover opaque source IDs from the reserved temporary-publication namespace.

    Args:
        layer_name: Server-owned qualified layer or unqualified coverage-store name.

    Returns:
        Original run/file reference, or None for another publication namespace.
    """
    match = re.fullmatch(r"(?:eolab:)?model_([a-f0-9]{32})_([a-f0-9]{32})", layer_name)
    return (
        RunArtifactReference(kind="runArtifact", jobId=match[1], artifactId=match[2])
        if match
        else None
    )


class RasterPublicationService:
    """Publish catalog and temporary rasters through the same GeoServer adapter."""

    def __init__(
        self,
        catalog: RasterCatalog,
        source_resolver: MountedRasterResolver,
        publisher: RasterPublisher,
        raster_registry: PublishedRasterRegistry,
        *,
        source_access: RasterSourceAccess | None = None,
        source_available: Callable[[str, str], Awaitable[bool]] | None = None,
    ) -> None:
        """Create a serialized publication use case.

        Args:
            catalog: Authoritative raster catalog port.
            source_resolver: Resolver confined to the scan mount.
            publisher: Concrete raster rendering adapter.
            raster_registry: Process-local WMS authorization registry.
            source_access: Existing owner-checked original-file resolution for outputs.
            source_available: Composition-supplied lifetime check for cleanup only.
        """
        self._catalog = catalog
        self._source_resolver = source_resolver
        self._publisher = publisher
        self._raster_registry = raster_registry
        self._publish_lock = asyncio.Lock()
        self._source_access = source_access
        self._source_available = source_available

    async def publish(
        self,
        request: CatalogRasterRequest | RasterSourceRequest,
        owner: str | None = None,
    ) -> PublishedRaster:
        """Publish an authorized catalog or temporary GeoTIFF through the same renderer.

        Args:
            request: Validated catalog identity or explicit original-source reference.
            owner: Server-derived session identity for a temporary output.

        Returns:
            Browser-safe WMS layer identity and WGS 84 bounding box.

        Raises:
            RasterFeatureError: If the Item, Asset, or rendering adapter fails.
            SourceFileError: If temporary source access or expiry rejects publication.
        """
        async with self._publish_lock:
            if isinstance(request, RasterSourceRequest):
                if isinstance(request.source, RunArtifactReference):
                    return await self._publish_temporary(request.source, owner)
                request = request.source
            item = await self._catalog.get_item(request)
            source_path = self._source_resolver.resolve(item)
            catalog_signature = cataloged_source_signature(item)
            resource_name = request.item_id
            await self._publisher.publish(resource_name, source_path)
            layer_name = f"{GEOSERVER_WORKSPACE_NAME}:{resource_name}"
            self._raster_registry.authorize(layer_name, source_path, catalog_signature)
            return PublishedRaster(
                layerName=layer_name,
                bbox=tuple(item["bbox"]),
            )

    async def _publish_temporary(
        self, reference: RunArtifactReference, owner: str | None
    ) -> PublishedRaster:
        """Resolve one run output and reuse ordinary GeoServer publication and styling.

        Args:
            reference: Opaque original-file identity, never a client path.
            owner: Server-derived session identity.

        Returns:
            Normal WMS publication details for the original raster.

        Raises:
            SourceFileError: If ownership, expiry or source resolution fails.
            RasterConflictError: If its extent is unavailable.
            RasterFeatureError: If GeoServer cannot publish the raster.
        """
        if self._source_access is None:
            raise SourceFileError("Temporary raster publication is unavailable.", 503)
        source = await self._source_access.resolve(reference, owner)
        try:
            metadata = await asyncio.to_thread(describe_raster_file, source.source_path)
            signature = await asyncio.to_thread(
                RasterSourceIdentity.read, source.source_path
            )
        except (OSError, ValueError, RasterioError) as error:
            raise RasterConflictError(
                "This raster could not be opened. Reopen the run and try again."
            ) from error
        if metadata["bounds"] is None:
            raise RasterConflictError("This raster cannot be placed on the map.")
        resource_name = f"model_{reference.job_id}_{reference.artifact_id}"
        await self._publisher.publish(
            resource_name, source.source_path, advertised=False
        )
        await self._source_access.resolve(reference, owner)
        layer_name = f"{GEOSERVER_WORKSPACE_NAME}:{resource_name}"
        self._raster_registry.authorize(layer_name, source.source_path, signature)
        return PublishedRaster(layerName=layer_name, bbox=metadata["bounds"])

    async def authorize_layers(
        self, layer_names: tuple[str, ...], owner: str | None
    ) -> bool:
        """Check current output ownership before normal WMS or cached composite delivery.

        Args:
            layer_names: Requested server publication names.
            owner: Current server-derived session identity, never supplied in the URL.

        Returns:
            Whether any layer requires a private, non-cacheable browser response.

        Raises:
            SourceFileError: If ownership, expiry or original-file access fails.
        """
        private = False
        for name in layer_names:
            reference = temporary_raster_source(name)
            if reference is None:
                continue
            private = True
            if self._source_access is None:
                raise SourceFileError("This raster result is unavailable.", 404)
            await self._source_access.resolve(reference, owner)
        return private

    async def cleanup(self) -> None:
        """Reconcile expired output publications, including leftovers from a previous app.

        Original file deletion remains with Processing. Unavailable GeoServer or
        storage leaves publication cleanup retryable and never reopens user access.

        Raises:
            Exception: If discovery, lifetime checks or unpublication fails; retry later.
        """
        if self._source_available is None:
            return
        async with self._publish_lock:
            for name in await self._publisher.temporary_layers():
                reference = temporary_raster_source(name)
                if reference is None:
                    continue
                if not await self._source_available(
                    reference.job_id, reference.artifact_id
                ):
                    await self._publisher.remove(name)
                    self._raster_registry.revoke(f"{GEOSERVER_WORKSPACE_NAME}:{name}")
