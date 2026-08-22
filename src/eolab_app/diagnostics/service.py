"""Probe, cache, and classify current GeoServer rendering diagnostics."""

import asyncio
import time
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx2

from eolab_app.diagnostics.metrics import (
    JvmMetrics,
    RenderingDiagnosticsError,
    parse_jmx_metrics,
)
from eolab_app.diagnostics.models import (
    RenderingDiagnostics,
    UnavailableRenderingDiagnostics,
    build_available_rendering_diagnostics,
)
from eolab_app.diagnostics.tracker import GetMapRequestTracker


DIAGNOSTICS_CACHE_SECONDS = 5.0
DIAGNOSTICS_RESPONSE_LIMIT_BYTES = 65_536
DIAGNOSTICS_STREAM_CHUNK_BYTES = 8_192


@dataclass(frozen=True)
class _CachedJvmObservation:
    """One cache entry, including an explicit unavailable observation."""

    observed_at: datetime
    metrics: JvmMetrics | None


async def _read_bounded_response(
    response: httpx2.Response,
    maximum_bytes: int = DIAGNOSTICS_RESPONSE_LIMIT_BYTES,
) -> bytes:
    """Read an internal response without trusting its declared body size.

    Args:
        response: Streaming internal HTTP response.
        maximum_bytes: Maximum response bytes accepted into memory.

    Returns:
        Complete response body within the configured bound.

    Raises:
        RenderingDiagnosticsError: If the declared or streamed body exceeds
            the limit or declares a malformed content length.
        httpx2.RequestError: If reading the response stream fails.
    """
    content_length = response.headers.get("content-length")
    if content_length is not None:
        try:
            declared_length = int(content_length)
        except ValueError as error:
            raise RenderingDiagnosticsError(
                "Internal diagnostics content length is malformed"
            ) from error
        if declared_length < 0 or declared_length > maximum_bytes:
            raise RenderingDiagnosticsError(
                "Internal diagnostics response is too large"
            )

    response_body = bytearray()
    async for chunk in response.aiter_bytes(
        chunk_size=DIAGNOSTICS_STREAM_CHUNK_BYTES
    ):
        response_body.extend(chunk)
        if len(response_body) > maximum_bytes:
            raise RenderingDiagnosticsError(
                "Internal diagnostics response is too large"
            )
    return bytes(response_body)


class RenderingDiagnosticsService:
    """Cache and summarize current internal rendering diagnostics."""

    def __init__(
        self,
        client: httpx2.AsyncClient,
        metrics_url: str,
        geoserver_url: str,
        request_tracker: GetMapRequestTracker,
    ) -> None:
        """Initialize the diagnostics sampler and its short-lived cache.

        Args:
            client: Internal-only HTTP client for metrics and WMS probes.
            metrics_url: Internal JVM metrics endpoint.
            geoserver_url: Internal GeoServer root URL.
            request_tracker: EOLab proxy's bounded GetMap observation tracker.
        """
        self._client = client
        self._metrics_url = metrics_url
        self._capabilities_url = f"{geoserver_url.rstrip('/')}/eolab/wms"
        self._request_tracker = request_tracker
        self._cache_lock = asyncio.Lock()
        self._cached_observation: _CachedJvmObservation | None = None
        self._cache_expires_at = 0.0

    async def get(self) -> RenderingDiagnostics:
        """Return a complete current sample or the stable unavailable variant.

        Returns:
            Browser-safe rendering diagnostics classified by the server.
        """
        observation = await self._get_jvm_observation()
        if observation.metrics is None:
            return UnavailableRenderingDiagnostics(
                observed_at=observation.observed_at,
            )

        return build_available_rendering_diagnostics(
            observation.observed_at,
            observation.metrics,
            self._request_tracker.snapshot(),
        )

    async def _get_jvm_observation(self) -> _CachedJvmObservation:
        """Coalesce and briefly cache internal probes across browser clients.

        Returns:
            Current validated JVM values, or an explicit unavailable
            observation when either internal probe fails its contract.
        """
        current_time = time.monotonic()
        if (
            self._cached_observation is not None
            and current_time < self._cache_expires_at
        ):
            return self._cached_observation

        async with self._cache_lock:
            current_time = time.monotonic()
            if (
                self._cached_observation is not None
                and current_time < self._cache_expires_at
            ):
                return self._cached_observation
            observed_at = datetime.now(timezone.utc)
            try:
                metrics_task = asyncio.create_task(self._load_metrics_document())
                readiness_task = asyncio.create_task(self._probe_wms_readiness())
                probe_tasks = (metrics_task, readiness_task)
                try:
                    metrics_document, _ = await asyncio.gather(*probe_tasks)
                finally:
                    for probe_task in probe_tasks:
                        probe_task.cancel()
                    await asyncio.gather(*probe_tasks, return_exceptions=True)
                metrics = parse_jmx_metrics(metrics_document)
            except (
                httpx2.RequestError,
                RenderingDiagnosticsError,
                UnicodeDecodeError,
            ):
                metrics = None
            observation = _CachedJvmObservation(
                observed_at=observed_at,
                metrics=metrics,
            )
            self._cached_observation = observation
            self._cache_expires_at = current_time + DIAGNOSTICS_CACHE_SECONDS
            return observation

    async def _load_metrics_document(self) -> str:
        """Load the complete bounded JMX exporter document as strict UTF-8.

        Returns:
            Complete metrics document within the response-size bound.

        Raises:
            RenderingDiagnosticsError: If the response status, media type, or
                body size violates the internal endpoint contract.
            UnicodeDecodeError: If the response is not valid UTF-8.
            httpx2.RequestError: If the internal request fails.
        """
        async with self._client.stream(
            "GET",
            self._metrics_url,
            headers={"accept": "text/plain"},
        ) as response:
            if not response.is_success:
                raise RenderingDiagnosticsError(
                    "The internal JMX exporter is unavailable"
                )
            media_type = response.headers.get("content-type", "").partition(";")[0]
            if media_type.lower() not in {
                "text/plain",
                "application/openmetrics-text",
            }:
                raise RenderingDiagnosticsError(
                    "The internal JMX exporter media type is invalid"
                )
            response_body = await _read_bounded_response(response)
        return response_body.decode("utf-8")

    async def _probe_wms_readiness(self) -> None:
        """Confirm WMS readiness from its bounded XML document prefix.

        Raises:
            RenderingDiagnosticsError: If WMS does not return a successful
                capabilities document within the response-size bound.
            httpx2.RequestError: If the internal request fails.
        """
        async with self._client.stream(
            "GET",
            self._capabilities_url,
            params={
                "service": "WMS",
                "version": "1.3.0",
                "request": "GetCapabilities",
            },
            headers={"accept": "application/xml"},
        ) as response:
            if not response.is_success:
                raise RenderingDiagnosticsError(
                    "The internal WMS service is unavailable"
                )
            document_prefix = bytearray()
            async for chunk in response.aiter_bytes(
                chunk_size=DIAGNOSTICS_STREAM_CHUNK_BYTES
            ):
                document_prefix.extend(chunk)
                if (
                    b"<WMS_Capabilities" in document_prefix
                    or b"<WMT_MS_Capabilities" in document_prefix
                ):
                    return
                if len(document_prefix) > DIAGNOSTICS_RESPONSE_LIMIT_BYTES:
                    break
        raise RenderingDiagnosticsError(
            "WMS readiness returned an unexpected document"
        )
