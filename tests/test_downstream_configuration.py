"""Configure pit filling without reinstating downstream work-size rejections."""

from dataclasses import fields
from pathlib import Path

import pytest

from eolab_app.processing.clip_models import RasterClipLimits
from eolab_app.processing.downstream_models import DownstreamLimits
from eolab_app.settings import load_downstream_limits


@pytest.mark.parametrize("value", ["1", "", "obsolete"])
def test_obsolete_downstream_limits_are_ignored(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    """Existing deployment overrides neither cap work nor prevent startup.

    Args:
        monkeypatch: Supplies settings retained by older deployments.
        value: Former numeric limit or an obsolete setting's unused value.
    """
    monkeypatch.delenv("PROCESSING_DOWNSTREAM_PIT_FILL_SEARCH_LIMIT", raising=False)
    for suffix in (
        "ROUTING_CELLS",
        "VALUE_CELLS",
        "MASK_CELLS",
        "WATERSHEDS",
        "WATERSHED_COORDINATES",
        "TERMINALS",
        "DISTANCE_PAIRS",
    ):
        monkeypatch.setenv("PROCESSING_DOWNSTREAM_MAX_" + suffix, value)
    shared = RasterClipLimits(worker_count=2, result_ttl_seconds=3600)
    assert load_downstream_limits(shared) == DownstreamLimits.with_lifecycle(shared)
    assert {field.name for field in fields(DownstreamLimits)} == {
        field.name for field in fields(RasterClipLimits)
    } | {"pit_fill_search_limit"}
    root = Path(__file__).parents[1]
    for name in ("docker-compose.yml", ".env.example"):
        assert "PROCESSING_DOWNSTREAM_MAX_" not in (root / name).read_text()


@pytest.mark.parametrize(
    "value,expected",
    [
        (None, 100),
        ("", 100),
        ("  ", 100),
        ("1000", 1000),
        ("-1", -1),
        ("0", 0),
        (str(2**63 - 1), 2**63 - 1),
    ],
)
def test_pit_fill_search_limit_environment(
    monkeypatch: pytest.MonkeyPatch, value: str | None, expected: int
) -> None:
    """Load the numerical cutoff while preserving shared job lifecycle settings.

    Args:
        monkeypatch: Isolate the administrator's environment setting.
        value: Absent, blank, or supported integer configuration.
        expected: Effective EcoShard search cutoff.
    """
    name = "PROCESSING_DOWNSTREAM_PIT_FILL_SEARCH_LIMIT"
    if value is None:
        monkeypatch.delenv(name, raising=False)
    else:
        monkeypatch.setenv(name, value)
    limits = load_downstream_limits(
        RasterClipLimits(worker_count=2, result_ttl_seconds=3600)
    )
    assert limits.pit_fill_search_limit == expected
    assert limits.worker_count == 2
    assert limits.result_ttl_seconds == 3600


@pytest.mark.parametrize("value", ["invalid", "true", "1.5", "-2", str(2**63)])
def test_invalid_pit_fill_search_limit_environment(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    """Reject values EcoShard cannot accept before starting a worker.

    Args:
        monkeypatch: Isolate the administrator's environment setting.
        value: Noninteger or outside the native signed integer range.
    """
    name = "PROCESSING_DOWNSTREAM_PIT_FILL_SEARCH_LIMIT"
    monkeypatch.setenv(name, value)
    with pytest.raises(ValueError, match=name):
        load_downstream_limits(RasterClipLimits())
