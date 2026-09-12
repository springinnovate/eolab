"""Real subprocess tests for executor environment and diagnostic handling."""

import asyncio
import json
import os

import pytest

from job_service.executor import child_environment, run_job


def test_restricted_environment_executes_real_runner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Launch the real installed operation without inherited service secrets.

    Args:
        monkeypatch: Environment isolation fixture.
    """
    monkeypatch.setenv("JOBS_CALLERS", '{"private":"credential-must-not-reach-child"}')
    monkeypatch.setenv("DATABASE_PASSWORD", "secret-database-value")
    monkeypatch.setenv("PYTHONPATH", "untrusted-import-path")
    monkeypatch.setenv("SYSTEMROOT", os.environ.get("SYSTEMROOT", "C:\\Windows"))
    environment = child_environment()
    assert "JOBS_CALLERS" not in environment
    assert "DATABASE_PASSWORD" not in environment
    assert "PYTHONPATH" not in environment and "PATH" not in environment
    assert set(key.upper() for key in environment) <= {
        "SYSTEMROOT",
        "WINDIR",
        "PYTHONDONTWRITEBYTECODE",
    }
    if os.name == "nt":
        assert environment["SYSTEMROOT"] == os.environ["SYSTEMROOT"]

    async def scenario() -> None:
        """Verify actual JSON output using the exact restricted environment."""
        result = await run_job(
            json.dumps(
                {"operation": "diagnostic.v1", "inputs": {"value": "caf\u00e9"}}
            ).encode(),
            asyncio.Event(),
            10,
        )
        assert result.status == "succeeded"
        assert result.value == {"value": "caf\u00e9"}

    asyncio.run(scenario())
