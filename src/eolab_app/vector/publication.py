"""Application workflow coordinating authoritative vector publication."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AsyncExitStack, asynccontextmanager
import math
from collections import OrderedDict
from threading import Event
from eolab_app.vector.filters import (
    AppliedVectorFilter,
    CatalogVectorFilterRequest,
    VectorFilter,
    VectorFilterCount,
    validate_filter,
)
from eolab_app.vector.metadata import get_catalog_vector_layer
from eolab_app.rendering.errors import PublishedLayerNotAuthorizedError

from eolab_app.rendering.geoserver import GEOSERVER_WORKSPACE_NAME
from eolab_app.rendering.errors import PublishedLayerChangedError
from eolab_app.vector.errors import (
    VectorConflictError,
    VectorFilterCountCapacityError,
    VectorFilterCountQueueTimeoutError,
)
from eolab_app.vector.models import (
    CatalogVectorRequest,
    VectorLayer,
    PublishedVector,
)
from eolab_app.vector.ports import VectorCatalog, VectorPublisher, VectorFieldReader
from eolab_app.vector.sources import (
    MountedVectorResolver,
    PublishedVectorRegistry,
)
from eolab_app.vector.styles import default_vector_style
from eolab_app.vector.artifact_sources import (
    ArtifactVectorSourceResolver,
    parse_artifact_vector_name,
)
from eolab_app.source_files import SourceFileError, finish_source_task


class VectorPublicationService:
    """Publish eligible exact vector layers and authorize bounded WMS access."""

    def __init__(
        self,
        catalog: VectorCatalog,
        source_resolver: MountedVectorResolver,
        publisher: VectorPublisher,
        vector_registry: PublishedVectorRegistry,
        field_reader: VectorFieldReader | None = None,
        *,
        filter_count_queue_capacity: int = 32,
        filter_count_queue_wait_seconds: float = 30,
        artifact_sources: ArtifactVectorSourceResolver | None = None,
        source_available: Callable[[str, str], Awaitable[bool]] | None = None,
    ) -> None:
        """Create a serialized vector publication use case.

        Args:
            catalog: Authoritative vector catalog port.
            source_resolver: Exact source and layer resolver.
            publisher: Convergent GeoServer vector adapter.
            vector_registry: Process-local public-WMS authorization registry.
            field_reader: Existing bounded geometry-free scalar reader for counts.
            filter_count_queue_capacity: Maximum count requests waiting behind
                the two active readers. Cached counts do not wait.
            filter_count_queue_wait_seconds: Maximum wait for a reader, separate
                from the existing 21-second counting deadline.
            artifact_sources: Neutral owned-file access for generated vector layers.
            source_available: Source-owner lifetime check for publication cleanup.

        Raises:
            ValueError: If the queue capacity is negative or its wait is not
                finite and positive.
        """
        if filter_count_queue_capacity < 0:
            raise ValueError("Filter count queue capacity must be nonnegative")
        if (
            not math.isfinite(filter_count_queue_wait_seconds)
            or filter_count_queue_wait_seconds <= 0
        ):
            raise ValueError("Filter count queue wait must be finite and positive")
        self._catalog = catalog
        self._source_resolver = source_resolver
        self._publisher = publisher
        self._vector_registry = vector_registry
        self._publish_lock = asyncio.Lock()
        self._field_reader = field_reader
        self._filter_slots = asyncio.Semaphore(2)
        self._filter_count_queue_capacity = filter_count_queue_capacity
        self._filter_count_queue_wait_seconds = filter_count_queue_wait_seconds
        self._waiting_filter_counts = 0
        self._filter_counts: OrderedDict[str, VectorFilterCount] = OrderedDict()
        self._artifact_sources = artifact_sources
        self._source_available = source_available
        self._artifact_readers: dict[tuple[str, str], int] = {}

    async def publish(self, request: CatalogVectorRequest) -> PublishedVector:
        """Resolve and idempotently publish one approved exact vector layer.

        Args:
            request: Validated Collection and Item identity.

        Returns:
            Browser-safe WMS identity, bounds, geometry class, and fixed style.

        Raises:
            VectorFeatureError: If catalog, source, or GeoServer boundaries fail.
            VectorConflictError: If assessment is absent, unsupported, or
                the Catalog source binding is invalid.
        """
        item = await self._catalog.get_item(request)
        source = self._source_resolver.resolve(item)
        return await self.publish_layer(
            get_catalog_vector_layer(item, source, "Visualization")
        )

    async def publish_layer(self, layer: VectorLayer) -> PublishedVector:
        """Display an authorized catalog, uploaded or generated vector through GeoServer.

        Args:
            layer: Original file and metadata supplied by its source owner.

        Returns:
            WMS layer name, bounds and the geometry's default appearance.

        Raises:
            VectorPublicationError: If GeoServer cannot publish the source layer.
        """
        async with self._publish_lock:
            source = layer.source
            options = (
                {"advertised": False}
                if parse_artifact_vector_name(layer.resource_name)
                else {}
            )
            style_name = await self._publisher.publish(
                layer.resource_name,
                source.source_format,
                source.source_path,
                source.layer_name,
                layer.geometry_kind,
                **options,
            )
            layer_name = f"{GEOSERVER_WORKSPACE_NAME}:{layer.resource_name}"
            self._vector_registry.authorize(layer_name, source, style_name)
            return PublishedVector(
                layerName=layer_name,
                bbox=layer.bbox,
                geometryKind=layer.geometry_kind,
                styleName=style_name,
                style=default_vector_style(layer.geometry_kind),
            )

    async def authorize_artifact_layers(
        self, names: tuple[str, ...], owner: str
    ) -> bool:
        """Check result ownership before ordinary WMS or cached composite delivery.

        Args:
            names: Requested original or filtered vector publication names.
            owner: Current browser identity established by the HTTP boundary.

        Returns:
            Whether any requested layer is a private generated vector.

        Raises:
            SourceFileError: If source ownership, expiry or availability rejects access.
        """
        private = False
        for name in names:
            reference = self._vector_registry.get_artifact_reference(name)
            if reference is not None:
                private = True
                if self._artifact_sources is None:
                    raise SourceFileError("This vector result is unavailable.", 404)
                await self._artifact_sources.files.resolve(owner, *reference)
        return private

    @asynccontextmanager
    async def use_artifact_layers(
        self, names: tuple[str, ...], owner: str
    ) -> AsyncIterator[None]:
        """Protect generated files and GeoServer layers until upstream reading stops.

        Args:
            names: Already authorized original or filtered layer names.
            owner: Browser identity, checked again when a queued render starts.

        Yields:
            Control while original files and their publications remain available.

        Raises:
            SourceFileError: If expiry or ownership rejects the queued read.
        """
        references = set(
            filter(
                None,
                (self._vector_registry.get_artifact_reference(name) for name in names),
            )
        )
        if not references:
            yield
            return
        if self._artifact_sources is None:
            raise SourceFileError("This vector result is unavailable.", 404)
        retained: list[tuple[str, str]] = []
        try:
            async with AsyncExitStack() as stack:
                async with self._publish_lock:
                    for reference in references:
                        await stack.enter_async_context(
                            self._artifact_sources.files.open(owner, *reference)
                        )
                        self._artifact_readers[reference] = (
                            self._artifact_readers.get(reference, 0) + 1
                        )
                        retained.append(reference)
                yield
        finally:
            async with self._publish_lock:
                for reference in retained:
                    remaining = self._artifact_readers[reference] - 1
                    if remaining:
                        self._artifact_readers[reference] = remaining
                    else:
                        self._artifact_readers.pop(reference)

    async def cleanup_artifact_layers(self) -> None:
        """Remove expired vector publications and cached metadata, including restart leftovers.

        Original file deletion remains with its source owner. Active upstream reads
        retain their GeoServer publication; unavailable infrastructure is retried later.

        Raises:
            Exception: If discovery, lifetime checks or GeoServer removal fails.
        """
        if self._artifact_sources is None or self._source_available is None:
            return
        async with self._publish_lock:
            names = await self._publisher.temporary_layers()
            published = {
                parse_artifact_vector_name(name): name
                for name in names
                if parse_artifact_vector_name(name)
            }
            references = set(published) | set(
                self._artifact_sources.list_cached_references()
            )
            for reference in references:
                if self._artifact_readers.get(
                    reference
                ) or await self._source_available(*reference):
                    continue
                name = published.get(reference)
                if name is not None:
                    self._vector_registry.revoke(f"{GEOSERVER_WORKSPACE_NAME}:{name}")
                    await self._publisher.remove(name)
                self._artifact_sources.forget_metadata(*reference)

    async def _get_catalog_filter_layer(
        self, request: CatalogVectorFilterRequest
    ) -> VectorLayer:
        """Load the catalog layer whose displayed features will be filtered.

        Args:
            request: Catalog identity and bounded filter rules.

        Returns:
            Original source and its assessed display and attribute metadata.

        Raises:
            VectorConflictError: If assessment, fields, or publication is unavailable.
        """
        item = await self._catalog.get_item(request)
        source = self._source_resolver.resolve(item)
        return get_catalog_vector_layer(item, source, "Filtering")

    def _validate_layer_filter(
        self,
        layer: VectorLayer,
        candidate: VectorFilter,
    ) -> tuple[VectorFilter, str]:
        """Check a feature filter against its published source and attribute schema.

        Args:
            layer: Authorized original source and metadata.
            candidate: Attribute rules supplied by the browser.

        Returns:
            Validated rules and the original WMS layer name.

        Raises:
            VectorConflictError: If publication or attribute validation fails.
        """
        try:
            layer_name = f"{GEOSERVER_WORKSPACE_NAME}:{layer.resource_name}"
            authorization = self._vector_registry.require_current(layer_name)
            if authorization.source != layer.source:
                raise VectorConflictError("The published vector binding changed; reload the layer")
        except (PublishedLayerChangedError, PublishedLayerNotAuthorizedError) as error:
            raise VectorConflictError("The vector publication is unavailable; reload the layer") from error
        validated_filter = validate_filter(candidate, layer.fields)
        return validated_filter, layer_name

    async def apply_filter(self, request: CatalogVectorFilterRequest) -> AppliedVectorFilter:
        """Authorize a per-map predicate without changing GeoServer layer state.

        Args:
            request: Catalog identity and complete rule builder state.

        Returns:
            Validated rules and their immutable rendering identity.

        Raises:
            VectorConflictError: If the fields, source binding, or publication is invalid.
        """
        layer = await self._get_catalog_filter_layer(request)
        return await self.apply_layer_filter(layer, request.filter)

    async def apply_layer_filter(
        self,
        layer: VectorLayer,
        candidate: VectorFilter,
    ) -> AppliedVectorFilter:
        """Apply attribute rules to a catalog or uploaded layer's displayed features.

        Args:
            layer: Authorized original source and metadata.
            candidate: Structurally validated filter requested by the browser.

        Returns:
            Validated rules and a WMS identity for the filtered view.

        Raises:
            VectorConflictError: If the source, fields or publication are unavailable.
        """
        validated_filter, published_layer_name = self._validate_layer_filter(
            layer, candidate
        )
        try:
            layer_name = self._vector_registry.authorize_filter(
                published_layer_name,
                validated_filter,
            )
        except (PublishedLayerChangedError, PublishedLayerNotAuthorizedError) as error:
            raise VectorConflictError(str(error)) from error
        return AppliedVectorFilter(layerName=layer_name, filter=validated_filter)

    async def count_filter(
        self, request: CatalogVectorFilterRequest
    ) -> VectorFilterCount:
        """Wait for a reader and count the features matching an applied filter.

        Args:
            request: Same Catalog identity and rules used for rendering.

        Returns:
            Cached or newly calculated exact counts. Unavailable counts mean
            reading could not finish within its row/time budget or no reader
            is configured; a busy queue raises a separate error.

        Raises:
            VectorConflictError: If authoritative metadata or source binding is invalid.
            VectorFilterCountCapacityError: If the waiting queue is full.
            VectorFilterCountQueueTimeoutError: If no reader becomes available
                within the queue wait deadline.
            asyncio.CancelledError: If the requesting browser disconnects.
        """
        layer = await self._get_catalog_filter_layer(request)
        return await self.count_layer_filter(layer, request.filter)

    async def count_layer_filter(
        self,
        layer: VectorLayer,
        candidate: VectorFilter,
    ) -> VectorFilterCount:
        """Count matching features through the existing bounded field reader and queue.

        Timeout and cancellation signal the native reader, then wait for its
        thread to stop before returning. Source owners may release their file
        leases only after this method exits.

        Args:
            layer: Authorized original source and metadata.
            candidate: Structurally validated filter requested by the browser.

        Returns:
            Exact counts, or an incomplete result when a read reaches its budget.

        Raises:
            VectorConflictError: If source access or attribute validation fails.
            VectorFilterCountCapacityError: If the waiting queue is full.
            VectorFilterCountQueueTimeoutError: If waiting exceeds its deadline.
            asyncio.CancelledError: After the cancelled reader has stopped.
        """
        validated_filter, published_layer_name = self._validate_layer_filter(
            layer, candidate
        )
        source = layer.source
        total = layer.feature_count
        if not validated_filter.active:
            return VectorFilterCount(matched=total, total=total, complete=True)
        key = (
            repr((published_layer_name, source)) + validated_filter.model_dump_json()
        )
        if key in self._filter_counts:
            self._filter_counts.move_to_end(key)
            return self._filter_counts[key]
        if self._field_reader is None:
            return VectorFilterCount()
        await self._wait_for_filter_count_reader()
        cancel_event = Event()
        task = asyncio.create_task(
            asyncio.to_thread(
                self._field_reader.count_filter,
                source,
                validated_filter,
                1_000_000,
                cancel_event,
            )
        )

        def release_filter_reader(completed: asyncio.Task[VectorFilterCount]) -> None:
            """Release the filter-reader slot and collect any unobserved worker exception.

            Args:
                completed: Finished worker task, including failures.

            Returns:
                None.
            """
            self._filter_slots.release()
            if not completed.cancelled():
                completed.exception()

        task.add_done_callback(release_filter_reader)
        try:
            result = await asyncio.wait_for(asyncio.shield(task), timeout=21)
        except TimeoutError:
            return VectorFilterCount()
        finally:
            cancel_event.set()
            await finish_source_task(task)
        if result.complete and result.total != total:
            raise VectorConflictError(
                "The feature count read from the file disagrees with the layer metadata"
            )
        if result.complete:
            self._filter_counts[key] = result
            while len(self._filter_counts) > 256:
                self._filter_counts.popitem(last=False)
        return result

    async def _wait_for_filter_count_reader(self) -> None:
        """Reserve one count reader, waiting in FIFO order when both are busy.

        Returns:
            None after acquiring a reader. The caller must keep that slot until
            its native read actually exits, even if the HTTP request is canceled.

        Raises:
            VectorFilterCountCapacityError: If the bounded waiting queue is full.
            VectorFilterCountQueueTimeoutError: If the wait deadline expires.
            asyncio.CancelledError: If the caller cancels while waiting. Its
                queue entry is removed without starting a read.
        """
        if not self._filter_slots.locked():
            await self._filter_slots.acquire()
            return
        if self._waiting_filter_counts >= self._filter_count_queue_capacity:
            raise VectorFilterCountCapacityError(
                "The filter count queue is full. The filter is still applied; "
                "apply it again to retry counting."
            )
        self._waiting_filter_counts += 1
        try:
            async with asyncio.timeout(self._filter_count_queue_wait_seconds):
                await self._filter_slots.acquire()
        except TimeoutError as error:
            raise VectorFilterCountQueueTimeoutError(
                "The filter count waited too long for a reader. The filter is "
                "still applied; apply it again to retry counting."
            ) from error
        finally:
            self._waiting_filter_counts -= 1
