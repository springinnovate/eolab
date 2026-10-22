"""Application workflow coordinating authoritative raster publication."""

import asyncio
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import cast
import re
from uuid import uuid4

from rasterio.errors import RasterioError

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
from eolab_app.raster.source_access import (
    RasterSourceAccess,
    describe_raster_data,
    read_private_raster,
)
from eolab_app.raster.source_models import (
    RasterSourceRequest,
    RunArtifactReference,
    TemporalRasterSelection,
)
from eolab_app.raster.temporal import TemporalObservation
from eolab_app.raster.temporal_geotiff import write_temporal_geotiff
from eolab_app.raster.errors import RasterConflictError
from eolab_app.source_files import SourceFileError


def is_temporal_raster_layer(layer_name: str) -> bool:
    """Identify a publication owned by the temporal display cache.

    Args:
        layer_name: Qualified layer or unqualified GeoServer store name.

    Returns:
        Whether the name belongs to the reserved, opaque slice namespace.
    """
    return re.fullmatch(r"(?:eolab:)?slice_[a-f0-9]{32}", layer_name) is not None


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
    """Publish raster files and cached temporal observations through GeoServer."""

    def __init__(
        self,
        catalog: RasterCatalog,
        source_resolver: MountedRasterResolver,
        publisher: RasterPublisher,
        raster_registry: PublishedRasterRegistry,
        *,
        source_access: RasterSourceAccess | None = None,
        source_available: Callable[[str, str], Awaitable[bool]] | None = None,
        slice_cache_path: Path | None = None,
        slice_cache_entries: int = 8,
    ) -> None:
        """Configure serialized publication and the recent-observation display cache.

        Args:
            catalog: Authoritative raster catalog port.
            source_resolver: Resolver confined to the scan mount.
            publisher: Concrete raster rendering adapter.
            raster_registry: Process-local WMS authorization registry.
            source_access: Original-file and temporal-observation source authority.
            source_available: Composition-supplied lifetime check for cleanup only.
            slice_cache_path: Dedicated writable directory shared read-only with
                GeoServer. None disables temporal publication.
            slice_cache_entries: Validated positive number of observations to retain,
                ordered by their most recent publication request.
        """
        self._catalog = catalog
        self._source_resolver = source_resolver
        self._publisher = publisher
        self._raster_registry = raster_registry
        self._publish_lock = asyncio.Lock()
        self._source_access = source_access
        self._source_available = source_available
        self._slice_cache_path = slice_cache_path
        self._slice_cache_entries = slice_cache_entries
        self._slices: OrderedDict[TemporalRasterSelection, PublishedRaster] = (
            OrderedDict()
        )

    async def publish(
        self,
        request: CatalogRasterRequest | RasterSourceRequest,
        owner: str | None = None,
    ) -> PublishedRaster:
        """Publish an authorized raster file or selected temporal observation.

        Args:
            request: Validated catalog identity or explicit original-source reference.
            owner: Server-derived session identity for a temporary output.

        Returns:
            Browser-safe WMS layer identity and WGS 84 bounding box.

        Raises:
            RasterFeatureError: If the Item, Asset, or rendering adapter fails.
            SourceFileError: If temporary source access or expiry rejects publication.
            asyncio.CancelledError: After native materialization has stopped.
        """
        async with self._publish_lock:
            if isinstance(request, RasterSourceRequest):
                if isinstance(request.source, RunArtifactReference):
                    return await self._publish_temporary(request.source, owner)
                if isinstance(request.source, TemporalRasterSelection):
                    return await self._publish_observation(request.source)
                request = request.source
            item = await self._catalog.get_item(request)
            source_path = self._source_resolver.resolve(item)
            resource_name = request.item_id
            await self._publisher.publish(resource_name, source_path)
            layer_name = f"{GEOSERVER_WORKSPACE_NAME}:{resource_name}"
            self._raster_registry.authorize(layer_name)
            return PublishedRaster(
                layerName=layer_name,
                bbox=tuple(item["bbox"]),
            )

    async def _publish_observation(
        self, selection: TemporalRasterSelection
    ) -> PublishedRaster:
        """Reuse or materialize one observation while holding the publication lock.

        Native work uses the existing 30-second, 2 GiB raster process boundary.
        Only a completed file is given to GeoServer. A failed or interrupted
        GeoServer publication is left for retryable cleanup before another miss.

        Args:
            selection: Validated Catalog variable and exact observation time.

        Returns:
            Ordinary WMS identity and bounds for the cached GeoTIFF.

        Raises:
            RasterFeatureError: If source access, native reading or publication fails.
            asyncio.CancelledError: After the native process stops and its partial
                file is removed; interrupted GeoServer resources are cleaned later.
        """
        if self._source_access is None or self._slice_cache_path is None:
            raise RasterConflictError("Temporal map display is unavailable.")
        source = await self._source_access.resolve(selection)
        if selection in self._slices:
            self._slices.move_to_end(selection)
            return self._slices[selection]
        await self._cleanup_slices(await self._publisher.temporary_layers())
        resource_name = f"slice_{uuid4().hex}"
        path = self._slice_cache_path / f"{resource_name}.tif"
        try:
            self._slice_cache_path.mkdir(parents=True, exist_ok=True)
            bounds = await read_private_raster(
                write_temporal_geotiff, cast(TemporalObservation, source.data), path
            )
        except BaseException as error:
            path.unlink(missing_ok=True)
            if isinstance(error, (ValueError, OSError)):
                raise RasterConflictError(
                    "The selected observation could not be prepared for map display."
                ) from error
            raise
        await self._publisher.publish(resource_name, path, advertised=False)
        published = PublishedRaster(
            layerName=f"{GEOSERVER_WORKSPACE_NAME}:{resource_name}", bbox=bounds
        )
        self._slices[selection] = published
        self._raster_registry.authorize(published.layer_name)
        if len(self._slices) > self._slice_cache_entries:
            _, evicted = self._slices.popitem(last=False)
            self._raster_registry.revoke(evicted.layer_name)
            await self._remove_slice(evicted.layer_name.split(":", 1)[1])
        return published

    async def invalidate_temporal_items(
        self, item_keys: tuple[tuple[str, str], ...]
    ) -> None:
        """Revoke cached observations of datasets written by an explicit scan.

        Cleanup removes their files and GeoServer resources on its next pass.
        Revocation is immediate and does not require GeoServer to be available.
        The operator refreshes between calculations; no source mutation checks
        or historical observation copies are maintained.

        Args:
            item_keys: Collection and Item IDs successfully written by the scan.
        """
        refreshed = set(item_keys)
        async with self._publish_lock:
            for selection in tuple(self._slices):
                if (selection.collection_id, selection.item_id) in refreshed:
                    published = self._slices.pop(selection)
                    self._raster_registry.revoke(published.layer_name)

    async def _remove_slice(self, resource_name: str) -> None:
        """Remove an obsolete display publication before deleting its GeoTIFF.

        Args:
            resource_name: Unqualified cache-owned publication name.

        Raises:
            RasterFeatureError: If GeoServer cleanup must be retried.
            OSError: If cached file deletion fails.
        """
        self._raster_registry.revoke(f"{GEOSERVER_WORKSPACE_NAME}:{resource_name}")
        await self._publisher.remove(resource_name)
        (cast(Path, self._slice_cache_path) / f"{resource_name}.tif").unlink(
            missing_ok=True
        )

    async def _cleanup_slices(self, names: tuple[str, ...]) -> None:
        """Remove cache files and publications no longer retained by this process.

        The cache is process-local, so this also removes leftovers after restart.
        Failed unpublication keeps its file until a later successful attempt.

        Args:
            names: Current temporary store names returned by GeoServer.

        Raises:
            RasterFeatureError: If external cleanup must be retried.
            OSError: If directory access or file deletion fails.
        """
        if self._slice_cache_path is None:
            return
        retained = {
            result.layer_name.split(":", 1)[1] for result in self._slices.values()
        }
        for name in names:
            if is_temporal_raster_layer(name) and name not in retained:
                await self._remove_slice(name)
        for path in self._slice_cache_path.glob("slice_*.tif"):
            if is_temporal_raster_layer(path.stem) and path.stem not in retained:
                path.unlink()

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
            metadata = await asyncio.to_thread(describe_raster_data, source.data)
        except (OSError, ValueError, RasterioError) as error:
            raise RasterConflictError(
                "This raster could not be opened. Reopen the run and try again."
            ) from error
        if metadata["bounds"] is None:
            raise RasterConflictError("This raster cannot be placed on the map.")
        resource_name = f"model_{reference.job_id}_{reference.artifact_id}"
        await self._publisher.publish(
            resource_name, cast(Path, source.data), advertised=False
        )
        await self._source_access.resolve(reference, owner)
        layer_name = f"{GEOSERVER_WORKSPACE_NAME}:{resource_name}"
        self._raster_registry.authorize(layer_name)
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
        """Remove obsolete output and temporal publications, including restart leftovers.

        Original model-result file deletion remains with Processing. This service
        deletes only its own cached observation files after unpublication.
        Unavailable GeoServer or storage leaves cleanup retryable.

        Raises:
            Exception: If discovery, lifetime checks or unpublication fails; retry later.
        """
        async with self._publish_lock:
            names = await self._publisher.temporary_layers()
            await self._cleanup_slices(names)
            if self._source_available is None:
                return
            for name in names:
                reference = temporary_raster_source(name)
                if reference is None:
                    continue
                if not await self._source_available(
                    reference.job_id, reference.artifact_id
                ):
                    await self._publisher.remove(name)
                    self._raster_registry.revoke(f"{GEOSERVER_WORKSPACE_NAME}:{name}")
