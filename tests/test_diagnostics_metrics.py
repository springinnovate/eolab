"""Test the strict project-owned JMX metrics contract."""

import pytest

from eolab_app.diagnostics.metrics import (
    RenderingDiagnosticsError,
    parse_jmx_metrics,
)
from tests.diagnostics_support import VALID_METRICS


def test_parse_jmx_metrics_accepts_only_the_owned_metric_contract() -> None:
    """Aggregate collectors and preserve explicit byte, ratio, and second units."""
    metrics = parse_jmx_metrics(VALID_METRICS)

    assert metrics.heap_used_bytes == 268_435_456
    assert metrics.heap_committed_bytes == 536_870_912
    assert metrics.heap_max_bytes == 1_073_741_824
    assert metrics.process_cpu_load_ratio == 0.125
    assert metrics.garbage_collection_count == 42
    assert metrics.garbage_collection_seconds == pytest.approx(0.361)
    assert metrics.live_threads == 42
    assert metrics.uptime_seconds == 3600.5


@pytest.mark.parametrize(
    "invalid_document",
    (
        VALID_METRICS.replace("eolab_jvm_heap_max_bytes 1.073741824E9\n", ""),
        VALID_METRICS.replace(
            "eolab_jvm_heap_used_bytes 2.68435456E8",
            "eolab_jvm_heap_used_bytes 2.68435456E8\n"
            "eolab_jvm_heap_used_bytes 2.68435456E8",
        ),
        VALID_METRICS.replace(
            "eolab_jvm_process_cpu_load_ratio 0.125",
            "eolab_jvm_process_cpu_load_ratio NaN",
        ),
        VALID_METRICS.replace(
            "eolab_jvm_process_cpu_load_ratio 0.125",
            "eolab_jvm_process_cpu_load_ratio 1.1",
        ),
        VALID_METRICS.replace(
            "eolab_jvm_heap_committed_bytes 5.36870912E8",
            "eolab_jvm_heap_committed_bytes 1",
        ),
        VALID_METRICS.replace(
            "eolab_jvm_heap_used_bytes 2.68435456E8",
            "eolab_jvm_heap_used_bytes 0",
        ).replace(
            "eolab_jvm_heap_committed_bytes 5.36870912E8",
            "eolab_jvm_heap_committed_bytes 0",
        ).replace(
            "eolab_jvm_heap_max_bytes 1.073741824E9",
            "eolab_jvm_heap_max_bytes 0",
        ),
        VALID_METRICS.replace(
            'jvm_gc_collection_seconds_count{gc="G1 Old Generation"} 0\n',
            "",
        ),
        VALID_METRICS.replace(
            'jvm_gc_collection_seconds_count{gc="G1 Young Generation"} 32',
            'jvm_gc_collection_seconds_count{gc="G1 Young Generation",'
            'path="/secret"} 32',
        ),
        VALID_METRICS.replace(
            'jvm_gc_collection_seconds_count{gc="G1 Young Generation"} 32',
            'jvm_gc_collection_seconds_count{gc="G1 Young Generation"} 7.5',
        ),
        VALID_METRICS.replace(
            'jvm_gc_collection_seconds_sum{gc="G1 Young Generation"} 0.305',
            'jvm_gc_collection_seconds_sum{gc="G1 Young Generation"} 1e308',
        ).replace(
            'jvm_gc_collection_seconds_sum{gc="G1 Old Generation"} 0.0',
            'jvm_gc_collection_seconds_sum{gc="G1 Old Generation"} 1e308',
        ),
    ),
    ids=(
        "missing",
        "duplicate",
        "not-finite",
        "cpu-out-of-range",
        "unordered-heap",
        "zero-heap-maximum",
        "collector-mismatch",
        "unexpected-label",
        "fractional-count",
        "overflowing-aggregate",
    ),
)
def test_parse_jmx_metrics_rejects_partial_or_malformed_samples(
    invalid_document: str,
) -> None:
    """Make a malformed internal scrape unavailable instead of guessing."""
    with pytest.raises(RenderingDiagnosticsError):
        parse_jmx_metrics(invalid_document)
