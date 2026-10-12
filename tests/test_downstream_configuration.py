"""Old downstream resource settings cannot reintroduce work-size rejections."""

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
    }
    root = Path(__file__).parents[1]
    for name in ("docker-compose.yml", ".env.example"):
        assert "PROCESSING_DOWNSTREAM_MAX_" not in (root / name).read_text()
