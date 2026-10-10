"""Administrator downstream budgets reach preparation and execution without code edits."""

from dataclasses import fields
from pathlib import Path

import pytest

from eolab_app.processing.clip_models import RasterClipLimits
from eolab_app.processing.downstream_models import DownstreamLimits
from eolab_app.settings import load_downstream_limits


def test_all_downstream_budgets_are_configurable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every downstream budget has an environment override forwarded by Compose.

    Args:
        monkeypatch: Restores the operator's environment after the test.
    """
    shared = RasterClipLimits(runtime_seconds=321, process_memory_bytes=3 * 1024**3)
    root = Path(__file__).parents[1]
    compose = (root / "docker-compose.yml").read_text()
    example = (root / ".env.example").read_text()
    defaults = DownstreamLimits()
    inherited = {field.name for field in fields(RasterClipLimits)}
    overrides = {}
    for field in fields(DownstreamLimits):
        if field.name in inherited:
            continue
        name = "PROCESSING_DOWNSTREAM_" + field.name.upper()
        default = getattr(defaults, field.name)
        overrides[field.name] = default * 2
        monkeypatch.setenv(name, str(default * 2))
        assert compose.count(f'"{name}=${{EOLAB_{name}-}}"') == 2
        assert f"EOLAB_{name}=" in example.splitlines()
    configured = load_downstream_limits(shared)
    assert configured.runtime_seconds == 321
    assert configured.process_memory_bytes == 3 * 1024**3
    for attribute, expected in overrides.items():
        assert getattr(configured, attribute) == expected


@pytest.mark.parametrize("value", [None, ""])
def test_unset_or_empty_downstream_budgets_use_python_defaults(
    monkeypatch: pytest.MonkeyPatch, value: str | None
) -> None:
    """Direct and Compose deployments share the defaults owned by DownstreamLimits.

    Args:
        monkeypatch: Restores the operator's environment after the test.
        value: Missing direct-process setting or empty Compose override.
    """
    shared = RasterClipLimits(runtime_seconds=321, process_memory_bytes=3 * 1024**3)
    inherited = {field.name for field in fields(RasterClipLimits)}
    for field in fields(DownstreamLimits):
        if field.name in inherited:
            continue
        name = "PROCESSING_DOWNSTREAM_" + field.name.upper()
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)
    assert load_downstream_limits(shared) == DownstreamLimits.with_lifecycle(shared)


@pytest.mark.parametrize("value", [" ", "0", "-1", "1.5", "many", str(2**63)])
def test_invalid_downstream_budget_names_its_setting(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    """Invalid operator input fails before any native model work is admitted.

    Args:
        monkeypatch: Supplies one invalid environment override.
        value: Invalid integer budget text.
    """
    name = "PROCESSING_DOWNSTREAM_MAX_ROUTING_CELLS"
    monkeypatch.setenv(name, value)
    with pytest.raises(ValueError, match=name):
        load_downstream_limits(RasterClipLimits())
