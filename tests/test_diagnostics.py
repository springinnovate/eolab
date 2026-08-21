"""Test the strict browser-safe GeoServer diagnostics boundary."""

import asyncio

import httpx2
import pytest

from eolab_app.diagnostics import (
    DIAGNOSTICS_STREAM_CHUNK_BYTES,
    GetMapRequestTracker,
    RenderingDiagnosticsError,
    RenderingDiagnosticsService,
    _read_bounded_response,
    parse_jmx_metrics,
)


VALID_METRICS = """
# HELP exporter_self_metric ignored
jmx_scrape_duration_seconds 0.001
eolab_jvm_heap_used_bytes 2.68435456E8
eolab_jvm_heap_committed_bytes 5.36870912E8
eolab_jvm_heap_max_bytes 1.073741824E9
eolab_jvm_process_cpu_load_ratio 0.125
eolab_jvm_gc_collection_count_total{collector="G1 Young Generation"} 7
eolab_jvm_gc_collection_count_total{collector="G1 Old Generation"} 2.0
eolab_jvm_gc_collection_time_seconds_total{collector="G1 Young Generation"} 0.75
eolab_jvm_gc_collection_time_seconds_total{collector="G1 Old Generation"} 0.25
eolab_jvm_live_threads 42.0
eolab_jvm_uptime_seconds 3600.5
""".strip()


def test_parse_jmx_metrics_accepts_only_the_owned_metric_contract() -> None:
    """Aggregate collectors and preserve explicit byte, ratio, and second units."""
    metrics = parse_jmx_metrics(VALID_METRICS)

    assert metrics.heap_used_bytes == 268_435_456
    assert metrics.heap_committed_bytes == 536_870_912
    assert metrics.heap_max_bytes == 1_073_741_824
    assert metrics.process_cpu_load_ratio == 0.125
    assert metrics.garbage_collection_count == 9
    assert metrics.garbage_collection_seconds == 1.0
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
        VALID_METRICS.replace("eolab_jvm_process_cpu_load_ratio 0.125", "eolab_jvm_process_cpu_load_ratio NaN"),
        VALID_METRICS.replace("eolab_jvm_process_cpu_load_ratio 0.125", "eolab_jvm_process_cpu_load_ratio 1.1"),
        VALID_METRICS.replace("eolab_jvm_heap_committed_bytes 5.36870912E8", "eolab_jvm_heap_committed_bytes 1"),
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
            'eolab_jvm_gc_collection_count_total{collector="G1 Old Generation"} 2.0\n',
            "",
        ),
        VALID_METRICS.replace(
            'eolab_jvm_gc_collection_count_total{collector="G1 Young Generation"} 7',
            'eolab_jvm_gc_collection_count_total{collector="G1 Young Generation",path="/secret"} 7',
        ),
        VALID_METRICS.replace(
            'eolab_jvm_gc_collection_count_total{collector="G1 Young Generation"} 7',
            'eolab_jvm_gc_collection_count_total{collector="G1 Young Generation"} 7.5',
        ),
        VALID_METRICS.replace(
            'eolab_jvm_gc_collection_time_seconds_total{collector="G1 Young Generation"} 0.75',
            'eolab_jvm_gc_collection_time_seconds_total{collector="G1 Young Generation"} 1e308',
        ).replace(
            'eolab_jvm_gc_collection_time_seconds_total{collector="G1 Old Generation"} 0.25',
            'eolab_jvm_gc_collection_time_seconds_total{collector="G1 Old Generation"} 1e308',
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


def test_get_map_tracker_records_a_bounded_window_and_failures() -> None:
    """Keep request diagnostics bounded without storing request parameters."""
    tracker = GetMapRequestTracker(2)

    with tracker.track() as successful_request:
        assert tracker.snapshot().active == 1
        successful_request.succeeded = True
    with tracker.track():
        pass

    snapshot = tracker.snapshot()
    assert snapshot.active == 0
    assert snapshot.concurrency_limit == 2
    assert snapshot.completed == 2
    assert snapshot.latest_seconds is not None
    assert snapshot.latest_seconds >= 0
    assert snapshot.recent_failures == 1
    assert snapshot.recent_window_size == 2
    assert snapshot.latest_failed is True


def test_get_map_tracker_retains_only_the_latest_hundred_outcomes() -> None:
    """Bound memory and define recent failures as the retained completion set."""
    tracker = GetMapRequestTracker(2)

    for request_index in range(105):
        with tracker.track() as request:
            request.succeeded = request_index >= 5

    snapshot = tracker.snapshot()
    assert snapshot.completed == 105
    assert snapshot.recent_window_size == 100
    assert snapshot.recent_failures == 0


def test_get_map_tracker_requires_the_configured_capacity_contract() -> None:
    """Reject a tracker that could never accept a render."""
    with pytest.raises(ValueError, match="greater than zero"):
        GetMapRequestTracker(0)


def test_bounded_response_rejects_one_oversized_stream_chunk() -> None:
    """Bound decoded chunks even when the internal server omits body length."""

    class RecordingResponse:
        headers = {}

        def __init__(self) -> None:
            self.requested_chunk_size = None

        async def aiter_bytes(self, chunk_size=None):
            self.requested_chunk_size = chunk_size
            yield b"x" * 100

    async def read_response() -> None:
        response = RecordingResponse()
        with pytest.raises(RenderingDiagnosticsError, match="too large"):
            await _read_bounded_response(response, maximum_bytes=16)
        assert response.requested_chunk_size == DIAGNOSTICS_STREAM_CHUNK_BYTES

    asyncio.run(read_response())


def test_failed_diagnostics_probe_cancels_its_sibling() -> None:
    """Do not leave the other internal probe running after one has failed."""
    readiness_started = asyncio.Event()
    readiness_cancelled = asyncio.Event()

    async def run_diagnostics() -> str:
        async with httpx2.AsyncClient() as client:
            service = RenderingDiagnosticsService(
                client,
                "http://geoserver:9404/metrics",
                "http://geoserver:8080/geoserver",
                GetMapRequestTracker(2),
            )

            async def fail_metrics() -> str:
                await readiness_started.wait()
                raise RenderingDiagnosticsError("metrics failed")

            async def wait_for_wms() -> None:
                readiness_started.set()
                try:
                    await asyncio.Future()
                except asyncio.CancelledError:
                    readiness_cancelled.set()
                    raise

            service._load_metrics_document = fail_metrics
            service._probe_wms_readiness = wait_for_wms
            return (await service.get()).state

    assert asyncio.run(run_diagnostics()) == "unavailable"
    assert readiness_cancelled.is_set()


def test_diagnostics_cache_never_substitutes_stale_values_after_failed_refresh(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Coalesce near-term polls but report a failed current refresh unavailable."""
    clock = [0.0]
    exporter_is_available = [True]
    request_count = 0

    monkeypatch.setattr(
        "eolab_app.diagnostics.time.monotonic",
        lambda: clock[0],
    )

    def diagnostics_response(request: httpx2.Request) -> httpx2.Response:
        nonlocal request_count
        request_count += 1
        if request.url.port == 9404:
            if not exporter_is_available[0]:
                raise httpx2.ConnectError("private failure", request=request)
            return httpx2.Response(
                200,
                text=VALID_METRICS,
                headers={"content-type": "text/plain"},
            )
        return httpx2.Response(200, text="<WMS_Capabilities/>")

    async def sample_three_times() -> tuple[str, str, str]:
        async with httpx2.AsyncClient(
            transport=httpx2.MockTransport(diagnostics_response),
        ) as client:
            service = RenderingDiagnosticsService(
                client,
                "http://geoserver:9404/metrics",
                "http://geoserver:8080/geoserver",
                GetMapRequestTracker(2),
            )
            first_state = (await service.get()).state
            exporter_is_available[0] = False
            clock[0] = 4.0
            cached_state = (await service.get()).state
            clock[0] = 6.0
            refreshed_state = (await service.get()).state
        return first_state, cached_state, refreshed_state

    assert asyncio.run(sample_three_times()) == (
        "ready",
        "ready",
        "unavailable",
    )
    assert request_count == 4
