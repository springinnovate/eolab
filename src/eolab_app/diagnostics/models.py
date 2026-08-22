"""Strict browser-visible rendering diagnostics response models."""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat

from eolab_app.diagnostics.metrics import JvmMetrics
from eolab_app.diagnostics.tracker import (
    RECENT_GET_MAP_LIMIT,
    GetMapSnapshot,
)


BUSY_HEAP_PERCENT = 75.0
BUSY_CPU_PERCENT = 80.0
DEGRADED_HEAP_PERCENT = 90.0


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


def build_available_rendering_diagnostics(
    observed_at: datetime,
    jvm_metrics: JvmMetrics,
    request_snapshot: GetMapSnapshot,
) -> AvailableRenderingDiagnostics:
    """Classify validated observations into the browser response model.

    Args:
        observed_at: UTC time at which the internal probes began.
        jvm_metrics: Validated allowlisted JVM measurements.
        request_snapshot: Current bounded WMS GetMap observations.

    Returns:
        Complete ready, busy, or degraded rendering diagnostics.
    """
    heap_used_percent = (
        jvm_metrics.heap_used_bytes / jvm_metrics.heap_max_bytes * 100
    )
    process_cpu_load_percent = jvm_metrics.process_cpu_load_ratio * 100
    if (
        request_snapshot.latest_failed
        or heap_used_percent >= DEGRADED_HEAP_PERCENT
    ):
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
        observed_at=observed_at,
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
