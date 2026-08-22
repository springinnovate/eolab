"""Test pure rendering-state classification and response construction."""

from dataclasses import replace
from datetime import datetime, timezone

import pytest

from eolab_app.diagnostics.metrics import JvmMetrics
from eolab_app.diagnostics.models import build_available_rendering_diagnostics
from eolab_app.diagnostics.tracker import GetMapSnapshot


BASE_JVM_METRICS = JvmMetrics(
    heap_used_bytes=256,
    heap_committed_bytes=512,
    heap_max_bytes=1024,
    process_cpu_load_ratio=0.125,
    garbage_collection_count=42,
    garbage_collection_seconds=0.361,
    live_threads=42,
    uptime_seconds=3600.5,
)
BASE_REQUEST_SNAPSHOT = GetMapSnapshot(
    active=0,
    concurrency_limit=2,
    completed=0,
    latest_seconds=None,
    recent_failures=0,
    recent_window_size=0,
    latest_failed=False,
)


@pytest.mark.parametrize(
    ("jvm_metrics", "request_snapshot", "expected_state"),
    (
        (BASE_JVM_METRICS, BASE_REQUEST_SNAPSHOT, "ready"),
        (
            BASE_JVM_METRICS,
            replace(BASE_REQUEST_SNAPSHOT, active=1),
            "busy",
        ),
        (
            replace(BASE_JVM_METRICS, process_cpu_load_ratio=0.8),
            BASE_REQUEST_SNAPSHOT,
            "busy",
        ),
        (
            replace(
                BASE_JVM_METRICS,
                heap_used_bytes=900,
                heap_committed_bytes=900,
                heap_max_bytes=1000,
            ),
            BASE_REQUEST_SNAPSHOT,
            "degraded",
        ),
        (
            BASE_JVM_METRICS,
            replace(BASE_REQUEST_SNAPSHOT, latest_failed=True),
            "degraded",
        ),
    ),
    ids=("ready", "active-request", "high-cpu", "high-heap", "failed-map"),
)
def test_build_available_rendering_diagnostics_classifies_current_state(
    jvm_metrics: JvmMetrics,
    request_snapshot: GetMapSnapshot,
    expected_state: str,
) -> None:
    """Apply the existing ready, busy, and degraded precedence."""
    diagnostics = build_available_rendering_diagnostics(
        datetime(2026, 8, 22, tzinfo=timezone.utc),
        jvm_metrics,
        request_snapshot,
    )

    assert diagnostics.state == expected_state
    assert diagnostics.metrics.heap.used_percent == pytest.approx(
        jvm_metrics.heap_used_bytes / jvm_metrics.heap_max_bytes * 100
    )
    assert diagnostics.metrics.cpu.process_load_percent == pytest.approx(
        jvm_metrics.process_cpu_load_ratio * 100
    )
    assert diagnostics.metrics.requests.active_get_map == request_snapshot.active
