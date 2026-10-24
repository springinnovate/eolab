"""Application workflow coordinating authoritative raster publication."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
import logging
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
)
from eolab_app.raster.source_models import (
    RasterSourceRequest,
    RunArtifactReference,
    TemporalRasterSelection,
)
from eolab_app.raster.temporal import TemporalObservation
from eolab_app.raster.errors import (
    RasterConflictError,
    RasterFeatureError,
    RasterRequestError,
)
from eolab_app.source_files import SourceFileError


def is_temporal_raster_layer(layer_name: str) -> bool:
    """Return whether a GeoServer layer name identifies a temporal observation.

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


@dataclass
class _TemporalPublication:
    """Track a temporal layer's identity and in-flight renders until unpublication.

    Attributes:
        published: Stable browser-facing layer identity and bounds.
        users: Active upstream renders that still require its GeoServer layer.
        revoked: Whether an explicit refresh withdrew this layer's identity.
    """

    published: PublishedRaster
    users: int = 0
    revoked: bool = False


class RasterPublicationService:
    """Publish mounted rasters and model outputs through GeoServer."""

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
        """Configure publication and cleanup of expired or refreshed layers.

        Args:
            catalog: Authoritative raster catalog port.
            source_resolver: Resolver confined to the scan mount.
            publisher: Concrete raster rendering adapter.
            raster_registry: Process-local WMS authorization registry.
            source_access: Original-file and temporal-observation source authority.
            source_available: Composition-supplied lifetime check for cleanup only.
        """
        self._catalog = catalog
        self._source_resolver = source_resolver
        self._publisher = publisher
        self._raster_registry = raster_registry
        self._publish_lock = asyncio.Lock()
        self._source_access = source_access
        self._source_available = source_available
        self._observations: dict[TemporalRasterSelection, _TemporalPublication] = {}
        self._temporal_layers: dict[str, _TemporalPublication] = {}

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
        """Publish the selected archive GeoTIFF under one process-local layer identity.

        Called with the publication lock held. Repeated selections reuse their
        layer until an explicit source refresh or process restart.

        Args:
            selection: Validated Catalog variable and exact observation time.

        Returns:
            Ordinary WMS identity and admitted Catalog bounds for the GeoTIFF.

        Raises:
            RasterFeatureError: If source access, metadata reading or publication fails.
        """
        record = self._observations.get(selection)
        if record is not None:
            return record.published
        if self._source_access is None:
            raise RasterConflictError("Temporal map display is unavailable.")
        source = await self._source_access.resolve(selection)
        try:
            await asyncio.to_thread(describe_raster_data, source.data)
        except (OSError, ValueError, RasterioError) as error:
            raise RasterConflictError(
                "The selected observation could not be opened for map display."
            ) from error
        item = await self._catalog.get_item(selection)
        resource_name = f"slice_{uuid4().hex}"
        await self._publisher.publish(
            resource_name, cast(TemporalObservation, source.data).path, advertised=False
        )
        published = PublishedRaster(
            layerName=f"{GEOSERVER_WORKSPACE_NAME}:{resource_name}",
            bbox=tuple(item["bbox"]),
        )
        record = _TemporalPublication(published)
        self._observations[selection] = record
        self._temporal_layers[published.layer_name] = record
        self._raster_registry.authorize(published.layer_name)
        return published

    @asynccontextmanager
    async def use_layers(self, layer_names: tuple[str, ...]) -> AsyncIterator[None]:
        """Keep temporal GeoServer layers published until an upstream render finishes.

        Enter inside the scheduled upstream operation so protection lasts until
        that operation finishes, even if its browser request disconnects. An
        explicit refresh revokes queued identities while active renders finish.

        Args:
            layer_names: Layer identities already authorized by the rendering route.

        Yields:
            Control while the requested temporal publications remain available.

        Raises:
            RasterRequestError: If a temporal identity was revoked while queued.
        """
        temporal_names = tuple(
            name for name in layer_names if is_temporal_raster_layer(name)
        )
        if not temporal_names:
            yield
            return
        records: list[_TemporalPublication] = []
        try:
            async with self._publish_lock:
                selected: list[_TemporalPublication] = []
                for name in temporal_names:
                    record = self._temporal_layers.get(name)
                    if record is None or record.revoked:
                        raise RasterRequestError(
                            "This temporal map layer is no longer available. Refresh its dates."
                        )
                    selected.append(record)
                records = selected
                for record in records:
                    record.users += 1
            yield
        finally:
            if records:
                async with self._publish_lock:
                    for record in records:
                        record.users -= 1
                    try:
                        await self._cleanup_temporal_publications(
                            tuple(
                                record.published.layer_name.split(":", 1)[1]
                                for record in records
                                if record.revoked
                            )
                        )
                    except RasterFeatureError:
                        # Cleanup must not replace a completed tile or its read error.
                        logging.getLogger(__name__).warning(
                            "Temporal publication cleanup will retry."
                        )

    async def invalidate_temporal_items(
        self, item_keys: tuple[tuple[str, str], ...]
    ) -> None:
        """Revoke observation layers of datasets written by an explicit scan.

        Revocation is immediate and does not require GeoServer to be available.
        Active renders keep their publications until completion. Cleanup removes
        obsolete GeoServer resources without deleting original archive files.

        Args:
            item_keys: Collection and Item IDs successfully written by the scan.
        """
        refreshed = set(item_keys)
        async with self._publish_lock:
            for selection in tuple(self._observations):
                if (selection.collection_id, selection.item_id) in refreshed:
                    record = self._observations.pop(selection)
                    record.revoked = True
                    self._raster_registry.revoke(record.published.layer_name)

    async def _cleanup_temporal_publications(self, names: tuple[str, ...]) -> None:
        """Remove revoked idle layers and publications left by a previous process.

        Called with the publication lock held. Original archive files are never
        deleted. A failed unpublication remains available for a later retry.

        Args:
            names: Unqualified temporary store names returned by GeoServer or
                released by completed renders.

        Raises:
            RasterFeatureError: If GeoServer cleanup must be retried.
        """
        for name in names:
            if not is_temporal_raster_layer(name):
                continue
            layer_name = f"{GEOSERVER_WORKSPACE_NAME}:{name}"
            record = self._temporal_layers.get(layer_name)
            if record is not None and (not record.revoked or record.users):
                continue
            await self._publisher.remove(name)
            self._temporal_layers.pop(layer_name, None)

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

        Original file deletion remains with each source owner. This service only
        removes GeoServer resources. Unavailable GeoServer leaves cleanup retryable.

        Raises:
            Exception: If discovery, lifetime checks or unpublication fails; retry later.
        """
        async with self._publish_lock:
            names = await self._publisher.temporary_layers()
            await self._cleanup_temporal_publications(names)
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
