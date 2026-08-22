"""Test bounded process-local GetMap request tracking."""

import pytest

from eolab_app.diagnostics.tracker import GetMapRequestTracker


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
