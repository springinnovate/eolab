"""Real subprocess tests for executor environment and diagnostic handling."""

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

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


def test_runner_stderr_preserves_traceback_without_changing_public_reply() -> None:
    """Keep development diagnostics on stderr and the public failure on stdout."""
    result = subprocess.run(
        [sys.executable, "-m", "job_service.runner"],
        input=json.dumps(
            {
                "operation": "diagnostic.v1",
                "inputs": {"mode": "exception", "value": "private-echo-value"},
            }
        ).encode(),
        cwd=Path(__file__).parents[1] / "services/jobs",
        env=child_environment(),
        capture_output=True,
        timeout=10,
        check=True,
    )
    assert json.loads(result.stdout) == {"ok": False}
    assert b"Traceback" in result.stderr
    assert b"RuntimeError: Requested diagnostic exception" in result.stderr
    assert b"private-echo-value" not in result.stderr


def test_executor_inherits_operator_stderr(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify the actual child launch forwards stderr without a capture buffer.

    Args:
        monkeypatch: Subprocess boundary observer.
    """
    original = asyncio.create_subprocess_exec
    observed = []

    async def capture(*args: object, **kwargs: object) -> asyncio.subprocess.Process:
        """Observe launch settings while still executing a real process.

        Args:
            args: Executable arguments.
            kwargs: Subprocess options.

        Returns:
            Real runner process.
        """
        observed.append(kwargs["stderr"])
        return await original(*args, **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", capture)

    async def scenario() -> None:
        """Complete one real invocation with inherited stderr."""
        result = await run_job(
            b'{"operation":"diagnostic.v1","inputs":{}}', asyncio.Event(), 10
        )
        assert result.status == "succeeded"

    asyncio.run(scenario())
    assert observed == [None]
