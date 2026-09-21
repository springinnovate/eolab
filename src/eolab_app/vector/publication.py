"""Application workflow coordinating authoritative vector publication."""

import asyncio
import math
from collections.abc import Callable
from collections import OrderedDict
from threading import Event
from eolab_app.vector.filters import (
    AppliedVectorFilter, CatalogVectorFilterRequest, VectorFilterCount, validate_filter,
)
from eolab_app.vector.metadata import catalog_vector_fields, catalog_vector_feature_count, require_assessed_metadata
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
    ResolvedVectorSource,
    PublishedVector,
    VECTOR_READER_CONTRACT,
    VECTOR_RENDERING_METADATA_KEY,
    VECTOR_RENDERING_POLICY,
    VectorSourceSignature,
)
from eolab_app.vector.ports import VectorCatalog, VectorPublisher, VectorFieldReader
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
        field_reader: VectorFieldReader | None = None,
        *,
        filter_count_queue_capacity: int = 32,
        filter_count_queue_wait_seconds: float = 30,
    ) -> None:
        """Create a serialized vector publication use case.

        Args:
            catalog: Authoritative vector catalog port.
            source_resolver: Exact source and layer resolver.
            publisher: Convergent GeoServer vector adapter.
            vector_registry: Process-local public-WMS authorization registry.
            signature_reader: Complete mounted source identity boundary.
            field_reader: Existing bounded geometry-free scalar reader for counts.
            filter_count_queue_capacity: Maximum count requests waiting behind
                the two active readers. Cached counts do not wait.
            filter_count_queue_wait_seconds: Maximum wait for a reader, separate
                from the existing 21-second counting deadline.

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
        self._signature_reader = signature_reader
        self._publish_lock = asyncio.Lock()
        self._field_reader = field_reader
        self._filter_slots = asyncio.Semaphore(2)
        self._filter_count_queue_capacity = filter_count_queue_capacity
        self._filter_count_queue_wait_seconds = filter_count_queue_wait_seconds
        self._waiting_filter_counts = 0
        self._filter_counts: OrderedDict[str, VectorFilterCount] = OrderedDict()

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

    async def _filter_context(self, request: CatalogVectorFilterRequest):
        """Validate a rule builder against the current authoritative source.

        Args:
            request: Catalog identity and bounded filter rules.

        Returns:
            Item, source, signature, validated rules, and original layer name.

        Raises:
            VectorConflictError: If assessment, fields, or publication is stale.
        """
        item = await self._catalog.get_item(request)
        source = self._source_resolver.resolve(item)
        try:
            signature = await asyncio.to_thread(self._signature_reader, source)
            require_assessed_metadata(item, signature, "Filtering")
            layer_name = f"{GEOSERVER_WORKSPACE_NAME}:{request.item_id}"
            authorization = await asyncio.to_thread(self._vector_registry.require_current, layer_name)
            if authorization.source != source or authorization.source_signature != signature:
                raise VectorConflictError("The published vector source changed; reload the layer")
        except (OSError, PublishedLayerChangedError, PublishedLayerNotAuthorizedError) as error:
            raise VectorConflictError("The vector publication is unavailable; reload the layer") from error
        candidate = validate_filter(request.filter, catalog_vector_fields(item))
        return item, source, signature, candidate, layer_name

    async def apply_filter(self, request: CatalogVectorFilterRequest) -> AppliedVectorFilter:
        """Authorize a per-map predicate without changing GeoServer layer state.

        Args:
            request: Catalog identity and complete rule builder state.

        Returns:
            Validated rules and their immutable rendering identity.

        Raises:
            VectorConflictError: If the fields, source, or publication is stale.
        """
        _, _, _, candidate, base = await self._filter_context(request)
        try:
            layer_name = await asyncio.to_thread(self._vector_registry.authorize_filter, base, candidate)
        except (PublishedLayerChangedError, PublishedLayerNotAuthorizedError) as error:
            raise VectorConflictError(str(error)) from error
        return AppliedVectorFilter(layerName=layer_name, filter=candidate)

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
            VectorConflictError: If authoritative metadata or source changes.
            VectorFilterCountCapacityError: If the waiting queue is full.
            VectorFilterCountQueueTimeoutError: If no reader becomes available
                within the queue wait deadline.
            asyncio.CancelledError: If the requesting browser disconnects.
        """
        item, source, signature, candidate, base = await self._filter_context(request)
        total = catalog_vector_feature_count(item, "Filter count")
        if not candidate.active:
            return VectorFilterCount(matched=total, total=total, complete=True)
        key = repr((base, signature)) + candidate.model_dump_json()
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
                candidate,
                1_000_000,
                cancel_event,
            )
        )

        def finished(completed: asyncio.Task[VectorFilterCount]) -> None:
            """Release capacity only after the actual bounded worker exits.

            Args:
                completed: Finished worker task, including failures.

            Returns:
                None.
            """
            self._filter_slots.release()
            if not completed.cancelled():
                completed.exception()

        task.add_done_callback(finished)
        try:
            result = await asyncio.wait_for(asyncio.shield(task), timeout=21)
        except TimeoutError:
            return VectorFilterCount()
        finally:
            cancel_event.set()
        try:
            after = await asyncio.to_thread(self._signature_reader, source)
        except OSError as error:
            raise VectorConflictError(
                "The counted vector source disappeared"
            ) from error
        if after != signature or (result.complete and result.total != total):
            raise VectorConflictError(
                "The vector source changed; reassess it before counting"
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
