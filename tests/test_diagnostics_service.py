"""Test diagnostics probes, bounds, cancellation, and caching."""

import asyncio

import httpx2
import pytest

from eolab_app.diagnostics.metrics import RenderingDiagnosticsError
from eolab_app.diagnostics.service import (
    DIAGNOSTICS_STREAM_CHUNK_BYTES,
    RenderingDiagnosticsService,
    _read_bounded_response,
)
from eolab_app.diagnostics.tracker import GetMapRequestTracker
from tests.diagnostics_support import VALID_METRICS


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
        "eolab_app.diagnostics.service.time.monotonic",
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
