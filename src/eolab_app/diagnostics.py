"""Summarize internal GeoServer metrics for the public EOLab interface."""

import asyncio
import math
import re
import time
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Annotated, Literal

import httpx2
from pydantic import BaseModel, ConfigDict, Field, FiniteFloat


DIAGNOSTICS_CACHE_SECONDS = 5.0
DIAGNOSTICS_RESPONSE_LIMIT_BYTES = 65_536
DIAGNOSTICS_STREAM_CHUNK_BYTES = 8_192
RECENT_GET_MAP_LIMIT = 100
BUSY_HEAP_PERCENT = 75.0
BUSY_CPU_PERCENT = 80.0
DEGRADED_HEAP_PERCENT = 90.0

_NUMBER_PATTERN = r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?"
_METRIC_LINE_PATTERN = re.compile(
    rf"^(?P<name>[a-zA-Z_:][a-zA-Z0-9_:]*)"
    rf"(?P<labels>\{{[^\r\n]*\}})?\s+"
    rf"(?P<value>{_NUMBER_PATTERN})$"
)
_GC_LABEL_PATTERN = re.compile(
    r'^\{gc="(?:[^"\\]|\\.)+"\}$'
)
_SINGLETON_METRICS = {
    "eolab_jvm_heap_used_bytes": "heap_used_bytes",
    "eolab_jvm_heap_committed_bytes": "heap_committed_bytes",
    "eolab_jvm_heap_max_bytes": "heap_max_bytes",
    "eolab_jvm_process_cpu_load_ratio": "process_cpu_load_ratio",
    "eolab_jvm_live_threads": "live_threads",
    "eolab_jvm_uptime_seconds": "uptime_seconds",
}
_GC_COUNT_METRIC = "jvm_gc_collection_seconds_count"
_GC_SECONDS_METRIC = "jvm_gc_collection_seconds_sum"


class _StrictModel(BaseModel):
    """Forbid accidental additions to the browser-visible contract."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class HeapDiagnostics(_StrictModel):
    """Current Java heap values reported by the JVM."""

    used_bytes: int = Field(alias="usedBytes", ge=0)
    committed_bytes: int = Field(alias="committedBytes", ge=0)
    max_bytes: int = Field(alias="maxBytes", gt=0)
    used_percent: FiniteFloat = Field(alias="usedPercent", ge=0, le=100)


class CpuDiagnostics(_StrictModel):
    """Current GeoServer JVM process CPU utilization."""

    process_load_percent: FiniteFloat = Field(
        alias="processLoadPercent",
        ge=0,
        le=100,
    )


class GarbageCollectionDiagnostics(_StrictModel):
    """Cumulative JVM garbage-collection work."""

    count: int = Field(ge=0)
    seconds: FiniteFloat = Field(ge=0)


class ThreadDiagnostics(_StrictModel):
    """Current live JVM thread count."""

    live: int = Field(ge=0)


class GetMapDiagnostics(_StrictModel):
    """Bounded process-local observations from EOLab's WMS proxy."""

    active_get_map: int = Field(alias="activeGetMap", ge=0)
    concurrency_limit: int = Field(alias="concurrencyLimit", gt=0)
    completed_get_map: int = Field(alias="completedGetMap", ge=0)
    latest_get_map_seconds: FiniteFloat | None = Field(
        alias="latestGetMapSeconds",
        default=None,
        ge=0,
    )
    recent_get_map_failures: int = Field(alias="recentGetMapFailures", ge=0)
    recent_window_size: int = Field(
        alias="recentWindowSize",
        ge=0,
        le=RECENT_GET_MAP_LIMIT,
    )


class RenderingMetrics(_StrictModel):
    """Allowlisted rendering metrics exposed to the browser."""

    heap: HeapDiagnostics
    cpu: CpuDiagnostics
    garbage_collection: GarbageCollectionDiagnostics = Field(
        alias="garbageCollection"
    )
    threads: ThreadDiagnostics
    uptime_seconds: FiniteFloat = Field(alias="uptimeSeconds", ge=0)
    requests: GetMapDiagnostics


class AvailableRenderingDiagnostics(_StrictModel):
    """Complete current diagnostics for an available rendering service."""

    state: Literal["ready", "busy", "degraded"]
    observed_at: datetime = Field(alias="observedAt")
    metrics: RenderingMetrics


class UnavailableRenderingDiagnostics(_StrictModel):
    """Stable response when current rendering diagnostics cannot be trusted."""

    state: Literal["unavailable"] = "unavailable"
    observed_at: datetime = Field(alias="observedAt")
    metrics: None = None


RenderingDiagnostics = Annotated[
    AvailableRenderingDiagnostics | UnavailableRenderingDiagnostics,
    Field(discriminator="state"),
]


@dataclass(frozen=True)
class JvmMetrics:
    """Validated values parsed from the project-owned exporter contract."""

    heap_used_bytes: int
    heap_committed_bytes: int
    heap_max_bytes: int
    process_cpu_load_ratio: float
    garbage_collection_count: int
    garbage_collection_seconds: float
    live_threads: int
    uptime_seconds: float


@dataclass(frozen=True)
class GetMapSnapshot:
    """One consistent snapshot of the in-process GetMap observations."""

    active: int
    concurrency_limit: int
    completed: int
    latest_seconds: float | None
    recent_failures: int
    recent_window_size: int
    latest_failed: bool


@dataclass
class _TrackedGetMap:
    """Mutable outcome owned by one tracker context."""

    succeeded: bool = False


@dataclass(frozen=True)
class _CachedJvmObservation:
    """One cache entry, including an explicit unavailable observation."""

    observed_at: datetime
    metrics: JvmMetrics | None


class RenderingDiagnosticsError(ValueError):
    """Internal diagnostics did not satisfy the owned input contract."""


class GetMapRequestTracker:
    """Track the bounded GetMap facts available at EOLab's proxy boundary."""

    def __init__(self, concurrency_limit: int) -> None:
        if concurrency_limit < 1:
            raise ValueError("GetMap concurrency limit must be greater than zero")
        self._concurrency_limit = concurrency_limit
        self._active = 0
        self._completed = 0
        self._latest_seconds: float | None = None
        self._recent_successes: deque[bool] = deque(maxlen=RECENT_GET_MAP_LIMIT)

    @contextmanager
    def track(self):
        """Record one valid GetMap request through completion or cancellation."""
        started_at = time.perf_counter()
        outcome = _TrackedGetMap()
        self._active += 1
        try:
            yield outcome
        finally:
            self._active -= 1
            self._completed += 1
            self._latest_seconds = time.perf_counter() - started_at
            self._recent_successes.append(outcome.succeeded)

    def snapshot(self) -> GetMapSnapshot:
        """Return the current request state without exposing request details."""
        recent_window_size = len(self._recent_successes)
        return GetMapSnapshot(
            active=self._active,
            concurrency_limit=self._concurrency_limit,
            completed=self._completed,
            latest_seconds=self._latest_seconds,
            recent_failures=recent_window_size - sum(self._recent_successes),
            recent_window_size=recent_window_size,
            latest_failed=(
                bool(self._recent_successes) and not self._recent_successes[-1]
            ),
        )


def _parse_metric_value(value_text: str) -> float:
    """Parse one finite Prometheus numeric sample."""
    value = float(value_text)
    if not math.isfinite(value):
        raise RenderingDiagnosticsError("Metric values must be finite")
    return value


def _as_nonnegative_integer(value: float, metric_name: str) -> int:
    """Validate one integer-valued counter or byte quantity."""
    if value < 0 or not value.is_integer():
        raise RenderingDiagnosticsError(
            f"{metric_name} must be a nonnegative integer"
        )
    return int(value)


def parse_jmx_metrics(document: str) -> JvmMetrics:
    """Parse only the metrics emitted by EOLab's owned JMX exporter rules.

    Unknown exporter self-metrics are ignored. Every EOLab singleton must
    appear exactly once, and garbage-collector samples must use only the owned
    ``collector`` label so no upstream label can enter the browser contract.
    """
    singleton_values: dict[str, float] = {}
    garbage_collection_counts: dict[str, int] = {}
    garbage_collection_seconds: dict[str, float] = {}

    for raw_line in document.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        match = _METRIC_LINE_PATTERN.fullmatch(line)
        if match is None:
            if line.startswith(("eolab_jvm_", "jvm_gc_collection_seconds_")):
                raise RenderingDiagnosticsError("Malformed required metric line")
            continue

        metric_name = match.group("name")
        labels = match.group("labels")
        if metric_name in _SINGLETON_METRICS:
            field_name = _SINGLETON_METRICS[metric_name]
            if labels is not None or field_name in singleton_values:
                raise RenderingDiagnosticsError(
                    f"{metric_name} must be one unlabeled sample"
                )
            singleton_values[field_name] = _parse_metric_value(
                match.group("value")
            )
            continue

        if metric_name not in {_GC_COUNT_METRIC, _GC_SECONDS_METRIC}:
            continue
        if labels is None or _GC_LABEL_PATTERN.fullmatch(labels) is None:
            raise RenderingDiagnosticsError(
                f"{metric_name} must use exactly one gc label"
            )
        values_by_collector = (
            garbage_collection_counts
            if metric_name == _GC_COUNT_METRIC
            else garbage_collection_seconds
        )
        if labels in values_by_collector:
            raise RenderingDiagnosticsError(
                f"{metric_name} must not repeat a collector"
            )
        metric_value = _parse_metric_value(match.group("value"))
        if metric_name == _GC_COUNT_METRIC:
            values_by_collector[labels] = _as_nonnegative_integer(
                metric_value,
                metric_name,
            )
        else:
            if metric_value < 0:
                raise RenderingDiagnosticsError(
                    f"{metric_name} must be nonnegative"
                )
            values_by_collector[labels] = metric_value

    missing_singletons = set(_SINGLETON_METRICS.values()) - singleton_values.keys()
    if missing_singletons:
        raise RenderingDiagnosticsError("Required JMX metrics are missing")
    if (
        not garbage_collection_counts
        or garbage_collection_counts.keys() != garbage_collection_seconds.keys()
    ):
        raise RenderingDiagnosticsError(
            "Garbage-collection metrics must identify the same collectors"
        )

    heap_used_bytes = _as_nonnegative_integer(
        singleton_values["heap_used_bytes"],
        "heap used bytes",
    )
    heap_committed_bytes = _as_nonnegative_integer(
        singleton_values["heap_committed_bytes"],
        "heap committed bytes",
    )
    heap_max_bytes = _as_nonnegative_integer(
        singleton_values["heap_max_bytes"],
        "heap maximum bytes",
    )
    if not (
        0 < heap_max_bytes
        and 0 <= heap_used_bytes <= heap_committed_bytes <= heap_max_bytes
    ):
        raise RenderingDiagnosticsError("JVM heap values are not ordered")

    process_cpu_load_ratio = singleton_values["process_cpu_load_ratio"]
    if not 0 <= process_cpu_load_ratio <= 1:
        raise RenderingDiagnosticsError("Process CPU load must be from zero to one")
    live_threads = _as_nonnegative_integer(
        singleton_values["live_threads"],
        "live threads",
    )
    uptime_seconds = singleton_values["uptime_seconds"]
    if uptime_seconds < 0:
        raise RenderingDiagnosticsError("JVM uptime must be nonnegative")

    garbage_collection_seconds_total = sum(garbage_collection_seconds.values())
    if not math.isfinite(garbage_collection_seconds_total):
        raise RenderingDiagnosticsError(
            "Garbage-collection time must have a finite total"
        )

    return JvmMetrics(
        heap_used_bytes=heap_used_bytes,
        heap_committed_bytes=heap_committed_bytes,
        heap_max_bytes=heap_max_bytes,
        process_cpu_load_ratio=process_cpu_load_ratio,
        garbage_collection_count=sum(garbage_collection_counts.values()),
        garbage_collection_seconds=garbage_collection_seconds_total,
        live_threads=live_threads,
        uptime_seconds=uptime_seconds,
    )


async def _read_bounded_response(
    response: httpx2.Response,
    maximum_bytes: int = DIAGNOSTICS_RESPONSE_LIMIT_BYTES,
) -> bytes:
    """Read an internal response without trusting its declared body size."""
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
        self._client = client
        self._metrics_url = metrics_url
        self._capabilities_url = f"{geoserver_url.rstrip('/')}/eolab/wms"
        self._request_tracker = request_tracker
        self._cache_lock = asyncio.Lock()
        self._cached_observation: _CachedJvmObservation | None = None
        self._cache_expires_at = 0.0

    async def get(self) -> RenderingDiagnostics:
        """Return a complete current sample or the stable unavailable variant."""
        observation = await self._get_jvm_observation()
        if observation.metrics is None:
            return UnavailableRenderingDiagnostics(
                observed_at=observation.observed_at,
            )

        jvm_metrics = observation.metrics
        request_snapshot = self._request_tracker.snapshot()
        heap_used_percent = (
            jvm_metrics.heap_used_bytes / jvm_metrics.heap_max_bytes * 100
        )
        process_cpu_load_percent = jvm_metrics.process_cpu_load_ratio * 100
        if request_snapshot.latest_failed or heap_used_percent >= DEGRADED_HEAP_PERCENT:
            state = "degraded"
        elif (
            request_snapshot.active > 0
            or heap_used_percent >= BUSY_HEAP_PERCENT
            or process_cpu_load_percent >= BUSY_CPU_PERCENT
        ):
            state = "busy"
        else:
            state = "ready"

        return AvailableRenderingDiagnostics(
            state=state,
            observed_at=observation.observed_at,
            metrics=RenderingMetrics(
                heap=HeapDiagnostics(
                    used_bytes=jvm_metrics.heap_used_bytes,
                    committed_bytes=jvm_metrics.heap_committed_bytes,
                    max_bytes=jvm_metrics.heap_max_bytes,
                    used_percent=heap_used_percent,
                ),
                cpu=CpuDiagnostics(
                    process_load_percent=process_cpu_load_percent,
                ),
                garbage_collection=GarbageCollectionDiagnostics(
                    count=jvm_metrics.garbage_collection_count,
                    seconds=jvm_metrics.garbage_collection_seconds,
                ),
                threads=ThreadDiagnostics(live=jvm_metrics.live_threads),
                uptime_seconds=jvm_metrics.uptime_seconds,
                requests=GetMapDiagnostics(
                    active_get_map=request_snapshot.active,
                    concurrency_limit=request_snapshot.concurrency_limit,
                    completed_get_map=request_snapshot.completed,
                    latest_get_map_seconds=request_snapshot.latest_seconds,
                    recent_get_map_failures=request_snapshot.recent_failures,
                    recent_window_size=request_snapshot.recent_window_size,
                ),
            ),
        )

    async def _get_jvm_observation(self) -> _CachedJvmObservation:
        """Coalesce and briefly cache internal probes across browser clients."""
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
        """Load the complete bounded JMX exporter document as strict UTF-8."""
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
        """Confirm WMS readiness from its bounded XML document prefix."""
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
