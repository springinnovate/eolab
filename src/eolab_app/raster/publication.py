"""Application workflow coordinating authoritative raster publication."""

import asyncio
from collections import OrderedDict
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
    read_private_raster,
)
from eolab_app.raster.source_models import (
    RasterSourceRequest,
    RunArtifactReference,
    TemporalRasterSelection,
)
from eolab_app.raster.temporal import TemporalObservation
from eolab_app.raster.temporal_geotiff import write_temporal_geotiff
from eolab_app.raster.errors import (
    RasterConflictError,
    RasterFeatureError,
    RasterRequestError,
)
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


@dataclass
class _TemporalPublication:
    """Keep an observation's layer identity independently of its cached file.

    Attributes:
        selection: Catalog variable and exact time that reconstruct this frame.
        published: Stable browser-facing layer identity and bounds.
        users: Active upstream renders that still require its materialization.
    """

    selection: TemporalRasterSelection
    published: PublishedRaster
    users: int = 0


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
            slice_cache_entries: Validated positive number of idle observations to
                retain in least-recently-used order. Active renders may temporarily
                require additional frames, protected until those renders finish.
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
        self._slices: dict[TemporalRasterSelection, _TemporalPublication] = {}
        self._slice_layers: dict[str, _TemporalPublication] = {}
        self._resident_slices: OrderedDict[str, _TemporalPublication] = OrderedDict()

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
        """Publish or restore an observation under its existing layer identity.

        Called with the publication lock held. Logical identities last until an
        explicit source refresh or process restart; idle materializations may be
        evicted without changing those identities.

        Args:
            selection: Validated Catalog variable and exact observation time.

        Returns:
            Ordinary WMS identity and bounds for the observation.

        Raises:
            RasterFeatureError: If source access, reading, publication or cleanup fails.
            asyncio.CancelledError: After native materialization has stopped.
        """
        if self._source_access is None or self._slice_cache_path is None:
            raise RasterConflictError("Temporal map display is unavailable.")
        source = await self._source_access.resolve(selection)
        record = self._slices.get(selection)
        if record is None:
            published = await self._materialize_observation(
                cast(TemporalObservation, source.data), f"slice_{uuid4().hex}"
            )
            record = _TemporalPublication(selection, published)
            self._slices[selection] = record
            self._slice_layers[published.layer_name] = record
            self._raster_registry.authorize(published.layer_name)
        elif record.published.layer_name not in self._resident_slices:
            await self._materialize_observation(
                cast(TemporalObservation, source.data),
                record.published.layer_name.split(":", 1)[1],
            )
        name = record.published.layer_name
        self._resident_slices[name] = record
        self._resident_slices.move_to_end(name)
        await self._trim_idle_slices()
        return record.published

    async def _materialize_observation(
        self, observation: TemporalObservation, resource_name: str
    ) -> PublishedRaster:
        """Write and publish one frame while holding the publication lock.

        Native work uses the existing 30-second, 2 GiB raster process boundary.
        Only a completed file reaches GeoServer. Interrupted publication resources
        are removed before a later materialization retries the same layer name.

        Args:
            observation: Authorized original array and selected time index.
            resource_name: Server-owned unqualified layer name to create or restore.

        Returns:
            Ordinary WMS layer identity and geographic bounds.

        Raises:
            RasterFeatureError: If reading, publication or orphan cleanup fails.
            asyncio.CancelledError: After native work stops and its partial file
                is removed; interrupted GeoServer resources are cleaned later.
        """
        await self._cleanup_slices(await self._publisher.temporary_layers())
        cache = cast(Path, self._slice_cache_path)
        path = cache / f"{resource_name}.tif"
        try:
            cache.mkdir(parents=True, exist_ok=True)
            bounds = await read_private_raster(
                write_temporal_geotiff, observation, path
            )
        except BaseException as error:
            path.unlink(missing_ok=True)
            if isinstance(error, (ValueError, OSError)):
                raise RasterConflictError(
                    "The selected observation could not be prepared for map display."
                ) from error
            raise
        await self._publisher.publish(resource_name, path, advertised=False)
        return PublishedRaster(
            layerName=f"{GEOSERVER_WORKSPACE_NAME}:{resource_name}", bbox=bounds
        )

    @asynccontextmanager
    async def use_layers(self, layer_names: tuple[str, ...]) -> AsyncIterator[None]:
        """Restore temporal frames and keep them available for one upstream render.

        Enter inside the scheduled upstream operation so protection lasts until
        that operation finishes, even if its browser request disconnects. All
        required frames are protected together; ordinary layers need no cache use.

        Args:
            layer_names: Layer identities already authorized by the rendering route.

        Yields:
            Control while the requested temporal materializations remain available.

        Raises:
            RasterRequestError: If a temporal identity was revoked while queued.
            RasterFeatureError: If source access or materialization fails.
            asyncio.CancelledError: After any native work has stopped.
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
                    record = self._slice_layers.get(name)
                    if record is None:
                        raise RasterRequestError(
                            "This temporal map layer is no longer available. Refresh its dates."
                        )
                    selected.append(record)
                records = selected
                for record in records:
                    record.users += 1
                for record in records:
                    name = record.published.layer_name
                    if name not in self._resident_slices:
                        source = await cast(
                            RasterSourceAccess, self._source_access
                        ).resolve(record.selection)
                        await self._materialize_observation(
                            cast(TemporalObservation, source.data),
                            name.split(":", 1)[1],
                        )
                        self._resident_slices[name] = record
                    self._resident_slices.move_to_end(name)
            yield
        finally:
            if records:
                async with self._publish_lock:
                    for record in records:
                        record.users -= 1
                    try:
                        await self._trim_idle_slices()
                    except (RasterFeatureError, OSError):
                        # Cleanup must not replace a completed tile or its read error.
                        logging.getLogger(__name__).warning(
                            "Temporal display cache cleanup will retry."
                        )

    async def _trim_idle_slices(self) -> None:
        """Remove revoked and excess idle frames while holding the publication lock.

        Active renders may exceed the idle cache bound. Removing a materialization
        never revokes a logical layer; a later render restores an evicted frame.

        Raises:
            RasterFeatureError: If GeoServer cleanup must be retried.
            OSError: If cached file deletion fails.
        """
        idle = [
            name for name, record in self._resident_slices.items() if not record.users
        ]
        obsolete = [name for name in idle if name not in self._slice_layers]
        retained = [name for name in idle if name in self._slice_layers]
        for name in (*obsolete, *retained[: -self._slice_cache_entries]):
            self._resident_slices.pop(name)
            await self._remove_slice(name.split(":", 1)[1])

    async def invalidate_temporal_items(
        self, item_keys: tuple[tuple[str, str], ...]
    ) -> None:
        """Revoke all observation identities of datasets written by an explicit scan.

        Evicted identities are revoked too. Active renders keep their files until
        completion; cleanup removes other obsolete materializations on its next pass.
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
                    record = self._slices.pop(selection)
                    self._slice_layers.pop(record.published.layer_name)
                    self._raster_registry.revoke(record.published.layer_name)

    async def _remove_slice(self, resource_name: str) -> None:
        """Remove a display materialization without revoking its logical identity.

        Args:
            resource_name: Unqualified cache-owned publication name.

        Raises:
            RasterFeatureError: If GeoServer cleanup must be retried.
            OSError: If cached file deletion fails.
        """
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
        retained = {name.split(":", 1)[1] for name in self._resident_slices}
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
            await self._trim_idle_slices()
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
